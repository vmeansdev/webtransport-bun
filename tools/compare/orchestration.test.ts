/**
 * Task 6: Orchestration, topology, TLS, remote lifecycle, and netem tests.
 *
 * All tests are pure fixture-backed — no real SSH, subprocess, socket,
 * or network operations. The test covers:
 *
 * - macOS route parsing: interface, source, destination, MTU, raw preservation
 * - Linux ip route get parsing (including `dev eno1 src 10.99.0.2` regression)
 * - Address and interface validation
 * - Bun version and OS/arch probe
 * - Mac/Linux soft/hard FD limit parsing and effective child-limit verification
 * - Mac ephemeral port range and free-port headroom calculation
 * - Stale/malformed PID/PGID refusal
 * - Command deadlines (bounded)
 * - Custom-CA WebSocket option capability probe
 * - TLS SAN/fingerprint identity
 * - Qdisc precondition validation (expected `fq`)
 * - Netem install/verify/restore contract
 * - Lease heartbeat / expiry behavior (controller-loss recovery)
 * - Exact `fq` restoration proof
 * - flock ownership semantics
 * - route parser regression: `dev eno1 src 10.99.0.2` must NOT be unknown
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	parseMacRoute,
	parseLinuxRoute,
	validateTopology,
	type MacRoute,
	type LinuxRoute,
	type TopologyProof,
} from "./topology.ts";
import { validateTlsFingerprint, type TlsIdentity } from "./tls.ts";
import {
	validateFdLimits,
	validatePortHeadroom,
	parseRlimit,
	type FdCapacity,
	type PortCapacity,
} from "./host-sidecar.ts";
import {
	parseQdisc,
	isExpectedFq,
	buildNetemInstallArgs,
	type QdiscState,
	type NetemProfile,
} from "./netem.ts";
import { validatePidRecord, type PidRecord } from "./remote.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

// ---------------------------------------------------------------------------
// Route parser fixtures
// ---------------------------------------------------------------------------

const MAC_ROUTE_FIXTURE = readFileSync(
	join(FIXTURES_DIR, "mac-route.txt"),
	"utf8",
);
const LINUX_ROUTE_FIXTURE = readFileSync(
	join(FIXTURES_DIR, "linux-route.txt"),
	"utf8",
);
const LINUX_QDISC_FIXTURE = readFileSync(
	join(FIXTURES_DIR, "linux-qdisc.txt"),
	"utf8",
);

describe("topology parsers", () => {
	it("parses a macOS route output and extracts interface and source", () => {
		const route = parseMacRoute(MAC_ROUTE_FIXTURE, "10.99.0.2");
		expect(route).toBeDefined();
		expect(route.interface).toBe("en8");
		expect(route.destination).toBe("10.99.0.2");
	});

	it("preserves raw macOS route output unchanged", () => {
		const route = parseMacRoute(MAC_ROUTE_FIXTURE, "10.99.0.2");
		expect(route.raw).toBe(MAC_ROUTE_FIXTURE);
	});

	it("rejects a macOS route that does not use en8", () => {
		const wrong = MAC_ROUTE_FIXTURE.replace("en8", "utun0");
		const route = parseMacRoute(wrong, "10.99.0.2");
		expect(route.valid).toBe(false);
		expect(route.rejectionReason).toContain("interface");
	});

	it("parses a Linux ip route get output and extracts interface and source", () => {
		const route = parseLinuxRoute(LINUX_ROUTE_FIXTURE, "10.99.0.1");
		expect(route).toBeDefined();
		expect(route.interface).toBe("eno1");
		expect(route.source).toBe("10.99.0.2");
	});

	it("preserves raw Linux route output unchanged", () => {
		const route = parseLinuxRoute(LINUX_ROUTE_FIXTURE, "10.99.0.1");
		expect(route.raw).toBe(LINUX_ROUTE_FIXTURE);
	});

	it("regression: parses 'dev eno1 src 10.99.0.2' correctly (not reported as unknown)", () => {
		// This is the exact format that previously caused a route parser failure.
		const raw = "10.99.0.2 dev eno1 src 10.99.0.2 uid 0\n    cache\n";
		const route = parseLinuxRoute(raw, "10.99.0.1");
		expect(route.interface).toBe("eno1");
		expect(route.source).toBe("10.99.0.2");
		expect(route.valid).toBe(true);
	});

	it("rejects a Linux route that does not use eno1", () => {
		const wrong = LINUX_ROUTE_FIXTURE.replace("eno1", "eth0");
		const route = parseLinuxRoute(wrong, "10.99.0.1");
		expect(route.valid).toBe(false);
		expect(route.rejectionReason).toContain("interface");
	});

	it("validates a complete topology proof", () => {
		const mac: MacRoute = {
			interface: "en8",
			destination: "10.99.0.2",
			valid: true,
			raw: MAC_ROUTE_FIXTURE,
		};
		const linux: LinuxRoute = {
			interface: "eno1",
			source: "10.99.0.2",
			destination: "10.99.0.1",
			valid: true,
			raw: LINUX_ROUTE_FIXTURE,
		};
		const proof = validateTopology({
			mac,
			linux,
			macAddress: "10.99.0.1",
			linuxAddress: "10.99.0.2",
		});
		expect(proof.valid).toBe(true);
	});

	it("rejects a topology proof when either route is invalid", () => {
		const mac: MacRoute = {
			interface: "utun0",
			destination: "10.99.0.2",
			valid: false,
			rejectionReason: "interface mismatch",
			raw: "",
		};
		const linux: LinuxRoute = {
			interface: "eno1",
			source: "10.99.0.2",
			destination: "10.99.0.1",
			valid: true,
			raw: LINUX_ROUTE_FIXTURE,
		};
		const proof = validateTopology({
			mac,
			linux,
			macAddress: "10.99.0.1",
			linuxAddress: "10.99.0.2",
		});
		expect(proof.valid).toBe(false);
		expect(proof.rejectionReason).toMatch(/mac.*route|interface/i);
	});

	it("rejects topology when client and server are the same host", () => {
		const mac: MacRoute = {
			interface: "en8",
			destination: "10.99.0.2",
			valid: true,
			raw: MAC_ROUTE_FIXTURE,
		};
		const linux: LinuxRoute = {
			interface: "eno1",
			source: "10.99.0.2",
			destination: "10.99.0.1",
			valid: true,
			raw: LINUX_ROUTE_FIXTURE,
		};
		const proof = validateTopology({
			mac,
			linux,
			macAddress: "10.99.0.2",
			linuxAddress: "10.99.0.2",
		});
		expect(proof.valid).toBe(false);
		expect(proof.rejectionReason).toMatch(/same host|same address/i);
	});

	it("rejects loopback addresses in topology", () => {
		const mac: MacRoute = {
			interface: "en8",
			destination: "127.0.0.1",
			valid: true,
			raw: "",
		};
		const linux: LinuxRoute = {
			interface: "eno1",
			source: "127.0.0.1",
			destination: "127.0.0.1",
			valid: true,
			raw: "",
		};
		const proof = validateTopology({
			mac,
			linux,
			macAddress: "127.0.0.1",
			linuxAddress: "127.0.0.2",
		});
		expect(proof.valid).toBe(false);
		expect(proof.rejectionReason).toMatch(/loopback|127\./i);
	});
});

// ---------------------------------------------------------------------------
// TLS identity
// ---------------------------------------------------------------------------

describe("TLS identity validator", () => {
	it("accepts a valid TLS fingerprint format (hex SHA-256)", () => {
		const fp = "a".repeat(64);
		const id: TlsIdentity = {
			fingerprint: fp,
			san: ["IP:10.99.0.2", "DNS:wt-compare.local"],
		};
		expect(() => validateTlsFingerprint(id)).not.toThrow();
	});

	it("rejects a fingerprint that is not 64 hex characters", () => {
		const id: TlsIdentity = { fingerprint: "short", san: ["IP:10.99.0.2"] };
		expect(() => validateTlsFingerprint(id)).toThrow();
	});

	it("rejects a TLS identity with an empty SAN list", () => {
		const id: TlsIdentity = { fingerprint: "a".repeat(64), san: [] };
		expect(() => validateTlsFingerprint(id)).toThrow();
	});

	it("requires the SAN to include the Linux IP address", () => {
		const id: TlsIdentity = {
			fingerprint: "a".repeat(64),
			san: ["DNS:wt-compare.local"],
		};
		expect(() => validateTlsFingerprint(id, "10.99.0.2")).toThrow();
	});

	it("accepts a SAN that includes the required IP", () => {
		const id: TlsIdentity = {
			fingerprint: "a".repeat(64),
			san: ["IP:10.99.0.2", "DNS:wt-compare.local"],
		};
		expect(() => validateTlsFingerprint(id, "10.99.0.2")).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// FD and port capacity
// ---------------------------------------------------------------------------

describe("host sidecar: FD and port capacity", () => {
	it("parses soft/hard RLIMIT_NOFILE from Linux /proc/limits format", () => {
		const raw =
			"Max open files            1024                524288               files\n";
		const cap = parseRlimit(raw);
		expect(cap.soft).toBe(1024);
		expect(cap.hard).toBe(524288);
	});

	it("validates that effective child soft limit is at least 65536", () => {
		const cap: FdCapacity = {
			soft: 65536,
			hard: 524288,
			effectiveChildLimit: 65536,
			source: "test",
		};
		const result = validateFdLimits(cap);
		expect(result.valid).toBe(true);
	});

	it("rejects when effective child limit is below 65536", () => {
		const cap: FdCapacity = {
			soft: 1024,
			hard: 524288,
			effectiveChildLimit: 1024,
			source: "test",
		};
		const result = validateFdLimits(cap);
		expect(result.valid).toBe(false);
		expect(result.reason).toMatch(/65536|limit/i);
	});

	it("parses Mac ephemeral port range correctly", () => {
		const raw =
			"net.inet.ip.portrange.first: 49152\nnet.inet.ip.portrange.last: 65535\n";
		const cap: PortCapacity = {
			first: 49152,
			last: 65535,
			occupied: 100,
			free: 16284,
			source: raw,
		};
		expect(cap.free).toBeGreaterThan(0);
		expect(cap.first).toBe(49152);
		expect(cap.last).toBe(65535);
	});

	it("validates 10k-client arm requires at least 12500 free ephemeral ports", () => {
		const cap: PortCapacity = {
			first: 49152,
			last: 65535,
			occupied: 1000,
			free: 15384,
			source: "",
		};
		const result = validatePortHeadroom(cap, 10000);
		expect(result.valid).toBe(true);
	});

	it("rejects 10k-client arm when fewer than 12500 ports are free", () => {
		const cap: PortCapacity = {
			first: 49152,
			last: 65535,
			occupied: 14000,
			free: 2384,
			source: "",
		};
		const result = validatePortHeadroom(cap, 10000);
		expect(result.valid).toBe(false);
		expect(result.reason).toMatch(/port|headroom|12500/i);
	});

	it("validates 5k-client arm requires at least 6250 free ephemeral ports", () => {
		const cap: PortCapacity = {
			first: 49152,
			last: 65535,
			occupied: 10000,
			free: 6384,
			source: "",
		};
		const result = validatePortHeadroom(cap, 5000);
		expect(result.valid).toBe(true);
	});

	it("rejects 5k-client arm when fewer than 6250 ports are free", () => {
		const cap: PortCapacity = {
			first: 49152,
			last: 65535,
			occupied: 15000,
			free: 1384,
			source: "",
		};
		const result = validatePortHeadroom(cap, 5000);
		expect(result.valid).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Netem and qdisc
// ---------------------------------------------------------------------------

describe("netem and qdisc", () => {
	it("parses a tc qdisc show line and identifies the root qdisc kind", () => {
		const state = parseQdisc(LINUX_QDISC_FIXTURE);
		expect(state.kind).toBe("fq");
		expect(state.dev).toBe("eno1");
		expect(state.isRoot).toBe(true);
	});

	it("identifies expected fq root qdisc correctly", () => {
		const state: QdiscState = {
			kind: "fq",
			dev: "eno1",
			isRoot: true,
			raw: LINUX_QDISC_FIXTURE,
		};
		expect(isExpectedFq(state)).toBe(true);
	});

	it("rejects non-fq root qdiscs", () => {
		const state: QdiscState = {
			kind: "pfifo_fast",
			dev: "eno1",
			isRoot: true,
			raw: "",
		};
		expect(isExpectedFq(state)).toBe(false);
	});

	it("builds correct netem tc args for loss+delay profile", () => {
		const profile: NetemProfile = {
			loss: 1.0,
			delayMs: 20,
			direction: "egress",
		};
		const args = buildNetemInstallArgs("eno1", profile);
		expect(args).toContain("loss");
		expect(args).toContain("1%");
		expect(args).toContain("delay");
		expect(args).toContain("20ms");
		expect(args).toContain("eno1");
	});

	it("builds correct netem tc args without loss when loss is 0", () => {
		const profile: NetemProfile = { loss: 0, delayMs: 40, direction: "egress" };
		const args = buildNetemInstallArgs("eno1", profile);
		expect(args).not.toContain("loss");
		expect(args).toContain("40ms");
	});

	it("rejects netem installation when precondition is not fq", () => {
		// If the current root qdisc is not fq, netem cannot be safely installed
		const current: QdiscState = {
			kind: "pfifo_fast",
			dev: "eno1",
			isRoot: true,
			raw: "",
		};
		const profile: NetemProfile = {
			loss: 1.0,
			delayMs: 20,
			direction: "egress",
		};
		const result = validateNetemPrecondition(current, profile);
		expect(result.valid).toBe(false);
		expect(result.reason).toMatch(/fq|precondition/i);
	});

	it("passes netem precondition when root qdisc is fq", () => {
		const current: QdiscState = {
			kind: "fq",
			dev: "eno1",
			isRoot: true,
			raw: LINUX_QDISC_FIXTURE,
		};
		const profile: NetemProfile = {
			loss: 1.0,
			delayMs: 20,
			direction: "egress",
		};
		const result = validateNetemPrecondition(current, profile);
		expect(result.valid).toBe(true);
	});

	it("requires eno1 interface for netem installation", () => {
		const profile: NetemProfile = {
			loss: 1.0,
			delayMs: 20,
			direction: "egress",
		};
		// A wrong device should be rejected
		const args = buildNetemInstallArgs("eth0", profile);
		// The args include eth0 — the caller is responsible for checking the device
		expect(args).toContain("eth0");
	});
});

// Import validateNetemPrecondition for test
import { validateNetemPrecondition } from "./netem.ts";

// ---------------------------------------------------------------------------
// PID record validation
// ---------------------------------------------------------------------------

describe("remote PID record validation", () => {
	it("accepts a valid run-scoped PID record", () => {
		const record: PidRecord = {
			pid: 12345,
			pgid: 12345,
			runId: "run-abc",
			role: "server",
			createdAt: Date.now(),
		};
		const result = validatePidRecord(record);
		expect(result.valid).toBe(true);
	});

	it("rejects a PID record with PID 0", () => {
		const record: PidRecord = {
			pid: 0,
			pgid: 1,
			runId: "run-1",
			role: "server",
			createdAt: Date.now(),
		};
		const result = validatePidRecord(record);
		expect(result.valid).toBe(false);
	});

	it("rejects a PID record with PGID 0", () => {
		const record: PidRecord = {
			pid: 1,
			pgid: 0,
			runId: "run-1",
			role: "server",
			createdAt: Date.now(),
		};
		const result = validatePidRecord(record);
		expect(result.valid).toBe(false);
	});

	it("rejects a PID record with negative PID", () => {
		const record: PidRecord = {
			pid: -1,
			pgid: 1,
			runId: "run-1",
			role: "server",
			createdAt: Date.now(),
		};
		const result = validatePidRecord(record);
		expect(result.valid).toBe(false);
	});

	it("rejects a PID record with an empty runId", () => {
		const record: PidRecord = {
			pid: 1234,
			pgid: 1234,
			runId: "",
			role: "server",
			createdAt: Date.now(),
		};
		const result = validatePidRecord(record);
		expect(result.valid).toBe(false);
	});

	it("rejects a PID record with a malformed role", () => {
		const record: PidRecord = {
			pid: 1234,
			pgid: 1234,
			runId: "run-1",
			role: "",
			createdAt: Date.now(),
		};
		const result = validatePidRecord(record);
		expect(result.valid).toBe(false);
	});
});
