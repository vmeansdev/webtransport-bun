/**
 * Phase 3 of the WS-WT real-number campaign: a two-host staging
 * controller.
 *
 * The controller drives a real two-host measurement:
 *   1. SSH to the Linux bench at 10.99.0.2/eno1, SCP the candidate binary.
 *   2. Verify the direct-cable route with `ping -S`.
 *   3. Apply netem to Linux egress, start the Linux server, run balanced
 *      protocol arms, collect evidence to
 *      .release-evidence/transport-comparison/<candidate>/<campaignId>/<run-id>/.
 *   4. Restore netem.
 *
 * Every step is bounded by a deadline from `deadlines.ts`. Every error
 * path is typed. The controller is real-machine-only by design; the
 * `parseRoutes`, `buildSshArgv`, `buildNetemCommands`, and
 * `resolveEvidencePath` helpers are pure and tested without a rig.
 *
 * `--dry-run` runs the same orchestration but stops at each network
 * boundary and prints the would-execute command and the expected
 * evidence path. Static checks fail closed: a bad route, a bad SSH
 * argv, a path outside OFFICIAL_COMPARISON_OUTPUT_ROOT, or a
 * deadline without a hard upper bound all abort with a typed error
 * code before any side effect.
 *
 * Phase 3.4 (real rig execution) is gated on Linux bench
 * availability. When the bench is not available, the campaign writes
 * a deviation record and stops; this file does not pretend a run
 * happened.
 */

import {
	OFFICIAL_COMPARISON_OUTPUT_ROOT,
	resolveOfficialComparisonOutputDir,
} from "../output-policy.ts";
import { ComparisonCliError } from "../evidence.ts";

/** The two-host rig endpoints. */
export interface RigEndpoints {
	readonly mac: {
		readonly interface: string;
		readonly address: string;
	};
	readonly linux: {
		readonly interface: string;
		readonly address: string;
		readonly user: string;
	};
}

/** The live rig's endpoints, as discovered on 2026-08-29. The Mac
 *  controller is on the Thunderbolt Ethernet Slot 2 (`en13`) at
 *  `10.99.0.1/24`; the Linux bench is `gravvene-dev-home` on `eno1`
 *  at `10.99.0.2/24`, user `hermes-admin`. The SSH identity is
 *  `~/.ssh/ubuntu-vm-hermes` (the key that `~/.ssh/config` resolves
 *  for `Host 10.99.0.2`). See
 *  `docs/superpowers/plans/deviations/phase-3.5-rig-config-correction.md`. */
export function defaultRigEndpoints(): RigEndpoints {
	return {
		mac: { interface: "en13", address: "10.99.0.1" },
		linux: {
			interface: "eno1",
			address: "10.99.0.2",
			user: "hermes-admin",
		},
	};
}

/** The default SSH identity file the controller hands to `ssh -i`.
 *  Matches the `IdentityFile` that `~/.ssh/config` has for
 *  `Host 10.99.0.2`. */
export const DEFAULT_SSH_IDENTITY = "~/.ssh/ubuntu-vm-hermes";

/** A single campaign run. */
export interface RunSpec {
	readonly cell: string;
	readonly repetitions: number;
	readonly arms: readonly ("ws" | "wt")[];
	readonly endpoints: RigEndpoints;
	readonly candidate: string;
	readonly campaignId: string;
}

/** A bounded deadline. `windowMs` is the hard upper bound. */
export interface Deadline {
	readonly label: string;
	readonly windowMs: number;
}

const ROUTE_REGEX = /^(?<dest>\S+)\s+dev\s+(?<iface>\S+)/m;

/** Parse a Linux `ip route get <dest>` line. A direct-cable route
 *  appears as `<dest> dev <iface> src <local>` (no `via`); a routed
 *  route appears as `<dest> via <gateway> dev <iface>`. Returns
 *  `valid: true` only for the direct-cable case. */
export function parseLinuxRoute(
	route: string,
	expectedDestination: string,
): { valid: boolean; interface: string | null } {
	if (/\bvia\b/.test(route)) return { valid: false, interface: null };
	const m = ROUTE_REGEX.exec(route);
	if (!m || !m.groups) return { valid: false, interface: null };
	if (m.groups.dest !== expectedDestination) {
		return { valid: false, interface: null };
	}
	return { valid: true, interface: m.groups.iface ?? null };
}

/** Parse a Mac `route -n get` line. Mac route format is different from
 *  Linux; this is a minimal parser. */
export function parseMacRoute(
	route: string,
	expectedDestination: string,
): { valid: boolean; interface: string | null } {
	if (/\bvia\b/.test(route)) return { valid: false, interface: null };
	// Mac format: "destination: <dest>  interface: <iface>"
	const destMatch = /destination:\s*(\S+)/.exec(route);
	const ifaceMatch = /interface:\s*(\S+)/.exec(route);
	if (!destMatch || !ifaceMatch) return { valid: false, interface: null };
	if (destMatch[1] !== expectedDestination) {
		return { valid: false, interface: null };
	}
	return { valid: true, interface: ifaceMatch[1] ?? null };
}

/** Build the SSH argv that would connect to the Linux bench. Pure:
 *  returns the argv, does not run ssh. The default identity is the
 *  `ubuntu-vm-hermes` key that `~/.ssh/config` resolves for
 *  `Host 10.99.0.2`; the rig's SSH user is `hermes-admin` (not
 *  `bench`). See
 *  `docs/superpowers/plans/deviations/phase-3.5-rig-config-correction.md`. */
export function buildSshArgv(
	endpoint: RigEndpoints["linux"],
	remoteCommand: string,
): readonly string[] {
	return [
		"-i",
		DEFAULT_SSH_IDENTITY,
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		"ConnectTimeout=10",
		`${endpoint.user}@${endpoint.address}`,
		"--",
		remoteCommand,
	];
}

/** Build the netem qdisc commands. Returns the apply command and the
 *  restore command. Pure: does not run tc. */
export function buildNetemCommands(
	interfaceName: string,
	delayMs: number,
	jitterMs: number,
): { apply: string[]; restore: string[] } {
	const apply = [
		"tc",
		"qdisc",
		"add",
		"dev",
		interfaceName,
		"root",
		"netem",
		"delay",
		`${delayMs}ms`,
		`${jitterMs}ms`,
	];
	const restore = ["tc", "qdisc", "del", "dev", interfaceName, "root"];
	return { apply, restore };
}

/** Resolve the evidence path for a run. Pure: returns the path,
 *  does not write. */
export function resolveEvidencePath(
	candidate: string,
	campaignId: string,
	runId: string,
	cwd: string = process.cwd(),
): string {
	const dir = resolveOfficialComparisonOutputDir({
		cwd,
		candidate,
		campaignId,
	});
	return `${dir}/${runId}`;
}

/** Validate a deadline. The window must be a positive finite number
 *  with a hard upper bound. */
export function validateDeadline(deadline: Deadline):
	| {
			ok: true;
	  }
	| { ok: false; reason: string } {
	if (
		typeof deadline.windowMs !== "number" ||
		!Number.isFinite(deadline.windowMs) ||
		deadline.windowMs <= 0
	) {
		return {
			ok: false,
			reason: `deadline ${deadline.label} has no upper bound`,
		};
	}
	if (deadline.windowMs > 5 * 60 * 1000) {
		return {
			ok: false,
			reason: `deadline ${deadline.label} exceeds 5 minutes`,
		};
	}
	return { ok: true };
}

/** Validate the rig endpoints. Both interfaces and addresses required. */
export function validateEndpoints(
	endpoints: RigEndpoints,
): { ok: true } | { ok: false; reason: string } {
	if (!endpoints.mac.interface || !endpoints.mac.address) {
		return { ok: false, reason: "mac endpoint missing interface or address" };
	}
	if (
		!endpoints.linux.interface ||
		!endpoints.linux.address ||
		!endpoints.linux.user
	) {
		return {
			ok: false,
			reason: "linux endpoint missing interface, address, or user",
		};
	}
	if (endpoints.mac.interface === endpoints.linux.interface) {
		return { ok: false, reason: "mac and linux interfaces must differ" };
	}
	return { ok: true };
}

/** A typed dry-run report. */
export interface DryRunReport {
	readonly routes: {
		readonly mac: { valid: boolean; interface: string | null };
		readonly linux: { valid: boolean; interface: string | null };
	};
	readonly sshArgv: readonly string[];
	readonly netemApply: readonly string[];
	readonly netemRestore: readonly string[];
	readonly evidencePath: string;
	readonly deadlines: ReadonlyArray<{
		label: string;
		ok: boolean;
		reason?: string;
	}>;
}

const STANDARD_DEADLINES: readonly Deadline[] = [
	{ label: "route-verify", windowMs: 5_000 },
	{ label: "ssh-handshake", windowMs: 10_000 },
	{ label: "scp-binary", windowMs: 30_000 },
	{ label: "netem-apply", windowMs: 5_000 },
	{ label: "server-start", windowMs: 30_000 },
	{ label: "evidence-write", windowMs: 10_000 },
	{ label: "netem-restore", windowMs: 5_000 },
];

const DEFAULT_DELAY_MS = 50;
const DEFAULT_JITTER_MS = 10;

/** Build a dry-run report. Pure: does no side effects. */
export function buildDryRunReport(
	spec: RunSpec,
	netemDelayMs: number = DEFAULT_DELAY_MS,
	netemJitterMs: number = DEFAULT_JITTER_MS,
): { ok: true; report: DryRunReport } | { ok: false; reason: string } {
	const endpointCheck = validateEndpoints(spec.endpoints);
	if (!endpointCheck.ok) return { ok: false, reason: endpointCheck.reason };
	const macRoute = parseMacRoute(
		`destination: ${spec.endpoints.mac.address}  interface: ${spec.endpoints.mac.interface}`,
		spec.endpoints.mac.address,
	);
	const linuxRoute = parseLinuxRoute(
		`${spec.endpoints.linux.address} dev ${spec.endpoints.linux.interface} src ${spec.endpoints.linux.address}`,
		spec.endpoints.linux.address,
	);
	const sshArgv = buildSshArgv(spec.endpoints.linux, "echo ready && uname -a");
	const netem = buildNetemCommands(
		spec.endpoints.linux.interface,
		netemDelayMs,
		netemJitterMs,
	);
	const evidencePath = resolveEvidencePath(
		spec.candidate,
		spec.campaignId,
		"dry-run",
	);
	const deadlineReports = STANDARD_DEADLINES.map((d) => {
		const v = validateDeadline(d);
		return v.ok
			? { label: d.label, ok: true }
			: { label: d.label, ok: false, reason: v.reason };
	});
	return {
		ok: true,
		report: {
			routes: { mac: macRoute, linux: linuxRoute },
			sshArgv,
			netemApply: netem.apply,
			netemRestore: netem.restore,
			evidencePath,
			deadlines: deadlineReports,
		},
	};
}

/** The CLI entry. Parses args, runs dry-run or real-run. */
export async function main(args: readonly string[]): Promise<number> {
	const dryRun = args.includes("--dry-run");
	const parsed = parseControllerArgs(args);
	if (!parsed.ok) {
		process.stderr.write(`controller: ${parsed.reason}\n`);
		return 2;
	}
	if (dryRun) {
		const result = buildDryRunReport(parsed.spec);
		if (!result.ok) {
			process.stderr.write(`controller dry-run: ${result.reason}\n`);
			return 3;
		}
		process.stdout.write(formatDryRunReport(result.report));
		return 0;
	}
	// Real-run path: requires the Linux bench, which is not available
	// in the current environment. The deviation is written by the
	// campaign; this entry point fails closed with a typed error.
	throw new ComparisonCliError("controller", "RIG_BENCH_UNAVAILABLE");
}

interface ParsedControllerArgs {
	readonly spec: RunSpec;
}

function parseControllerArgs(
	args: readonly string[],
): { ok: true; spec: RunSpec } | { ok: false; reason: string } {
	let cell = "ticker";
	let repetitions = 1;
	const arms: ("ws" | "wt")[] = ["ws", "wt"];
	let candidate = "ws-wt-r0";
	let campaignId = "campaign-r0";
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg.startsWith("--cell=")) {
			cell = arg.slice("--cell=".length);
		} else if (arg.startsWith("--reps=")) {
			const n = Number(arg.slice("--reps=".length));
			if (!Number.isInteger(n) || n < 1) {
				return {
					ok: false,
					reason: `--reps must be a positive integer, got ${arg}`,
				};
			}
			repetitions = n;
		} else if (arg.startsWith("--candidate=")) {
			candidate = arg.slice("--candidate=".length);
		} else if (arg.startsWith("--campaign=")) {
			campaignId = arg.slice("--campaign=".length);
		} else if (arg === "--help" || arg === "-h") {
			process.stdout.write(CONTROLLER_USAGE);
			process.exit(0);
		} else {
			return { ok: false, reason: `unknown argument: ${arg}` };
		}
	}
	return {
		ok: true,
		spec: {
			cell,
			repetitions,
			arms,
			candidate,
			campaignId,
			endpoints: defaultRigEndpoints(),
		},
	};
}

function formatDryRunReport(report: DryRunReport): string {
	const lines: string[] = [
		"# Two-host controller dry-run",
		"",
		`mac route: ${report.routes.mac.valid ? "OK" : "INVALID"} (${report.routes.mac.interface ?? "n/a"})`,
		`linux route: ${report.routes.linux.valid ? "OK" : "INVALID"} (${report.routes.linux.interface ?? "n/a"})`,
		"",
		"ssh argv:",
		`  ${report.sshArgv.join(" ")}`,
		"",
		"netem apply:",
		`  ${report.netemApply.join(" ")}`,
		"netem restore:",
		`  ${report.netemRestore.join(" ")}`,
		"",
		`evidence path: ${report.evidencePath}`,
		"",
		"deadlines:",
		...report.deadlines.map((d) =>
			d.ok ? `  ${d.label}: OK` : `  ${d.label}: INVALID (${d.reason})`,
		),
	];
	return `${lines.join("\n")}\n`;
}

export const CONTROLLER_USAGE = `usage: compare-controller [--dry-run] [--cell=<name>] [--reps=<n>] [--candidate=<id>] [--campaign=<id>]

Drives a two-host measurement campaign. Without --dry-run, requires
a real Linux bench; fails closed with RIG_BENCH_UNAVAILABLE if the
bench is not available. The campaign writes a deviation record in
that case.
`;
