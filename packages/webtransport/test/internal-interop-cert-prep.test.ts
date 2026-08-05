import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	buildInteropIterationState,
	DEFAULT_REQUIRED_COLD_LOOP_COUNT,
	resolveRequiredColdLoopCount,
	runChild,
} from "../../../scripts/run-cold-loop.ts";
import {
	ensureInteropCerts,
	__TESTING__ as INTEROP_TESTING,
	resolvePublishedMaterialPaths,
} from "../../../tools/interop/prepare-certs.ts";

const tempRoots: string[] = [];
const trackedPids: number[] = [];

afterEach(() => {
	delete process.env.WEBTRANSPORT_INTEROP_CERT_DIR;
	for (const pid of trackedPids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Production cleanup should normally have reaped the descendant.
		}
	}
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function makeTempCertDir(): string {
	const certDir = mkdtempSync(join(tmpdir(), "wt-interop-certs-"));
	tempRoots.push(certDir);
	return certDir;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForFile(filePath: string): Promise<void> {
	const deadline = performance.now() + 1_000;
	while (!existsSync(filePath) && performance.now() < deadline) {
		await Bun.sleep(20);
	}
	expect(existsSync(filePath)).toBe(true);
}

async function expectPidExit(pid: number): Promise<void> {
	const deadline = performance.now() + 1_500;
	while (processIsAlive(pid) && performance.now() < deadline) {
		await Bun.sleep(20);
	}
	expect(processIsAlive(pid)).toBe(false);
}

describe("interop cert preparation", () => {
	it("reaps a genuine descendant when the child exits nonzero", async () => {
		if (process.platform === "win32") return;

		const root = makeTempCertDir();
		const pidFile = join(root, "descendant.pid");
		const descendantSource = "setInterval(() => {}, 1_000);";
		const parentSource = [
			'const { spawn } = require("node:child_process");',
			'const { writeFileSync } = require("node:fs");',
			`const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: "ignore" });`,
			`writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
			"child.unref();",
			"process.exit(23);",
		].join("\n");

		await expect(
			runChild(
				"failing child fixture",
				root,
				["-e", parentSource],
				process.env,
				3_000,
			),
		).rejects.toThrow("failing child fixture failed with exit 23 signal none");
		await waitForFile(pidFile);
		const descendantPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
		trackedPids.push(descendantPid);
		await expectPidExit(descendantPid);
	});

	it("accepts modern subjectAltName summary output", () => {
		const summary = [
			"subject=CN = localhost",
			"X509v3 Subject Alternative Name:",
			"    DNS:localhost, IP Address:127.0.0.1",
		].join("\n");

		expect(INTEROP_TESTING.isLocalhostCertificateSummary(summary)).toBe(true);
	});

	it("accepts fallback text-mode summary output", () => {
		const summary = [
			"Certificate:",
			"    Subject: CN = localhost",
			"    X509v3 Subject Alternative Name:",
			"        DNS:localhost, IP Address:127.0.0.1",
		].join("\n");

		expect(INTEROP_TESTING.isLocalhostCertificateSummary(summary)).toBe(true);
	});

	it("rejects summaries missing loopback SAN entries", () => {
		const summary = [
			"Subject: CN = localhost",
			"X509v3 Subject Alternative Name:",
			"    DNS:localhost",
		].join("\n");

		expect(INTEROP_TESTING.isLocalhostCertificateSummary(summary)).toBe(false);
	});

	it("does not clear a young ownerless prep lock", () => {
		const certDir = makeTempCertDir();
		const lockDir = join(dirname(certDir), `.${basename(certDir)}.lock`);
		mkdirSync(lockDir, { recursive: true });

		expect(INTEROP_TESTING.clearStaleLock(lockDir)).toBe(false);
		expect(existsSync(lockDir)).toBe(true);
	});

	it("publishes a generation through the current marker", () => {
		const certDir = makeTempCertDir();
		const stagedDir = mkdtempSync(join(certDir, ".pending-"));
		writeFileSync(join(stagedDir, "cert.pem"), "fake cert\n", "utf8");
		writeFileSync(join(stagedDir, "key.pem"), "fake key\n", "utf8");

		INTEROP_TESTING.publishAtomically(certDir, stagedDir);

		const currentPath = INTEROP_TESTING.getCurrentGenerationPath(certDir);
		const generation = readFileSync(currentPath, "utf8").trim();
		const material = INTEROP_TESTING.resolvePublishedMaterialPaths(certDir);

		expect(generation).toContain("generation-");
		expect(material.certPath).toContain(generation);
		expect(material.keyPath).toContain(generation);
		expect(existsSync(material.certPath)).toBe(true);
		expect(existsSync(material.keyPath)).toBe(true);
		expect(readFileSync(material.certPath, "utf8")).toBe("fake cert\n");
		expect(readFileSync(material.keyPath, "utf8")).toBe("fake key\n");
	});

	it("generates named-curve localhost certs atomically", async () => {
		const certDir = makeTempCertDir();
		process.env.WEBTRANSPORT_INTEROP_CERT_DIR = certDir;

		await ensureInteropCerts();

		const currentPath = INTEROP_TESTING.getCurrentGenerationPath(certDir);
		const generation = readFileSync(currentPath, "utf8").trim();
		const material = resolvePublishedMaterialPaths(certDir);
		const keySummary = execFileSync(
			"openssl",
			["pkey", "-in", material.keyPath, "-text", "-noout"],
			{ encoding: "utf8" },
		);

		expect(generation).toContain("generation-");
		expect(material.certPath).toContain(generation);
		expect(keySummary).toMatch(/ASN1 OID: prime256v1|NIST CURVE: P-256/);
		expect(INTEROP_TESTING.hasValidMaterial(certDir)).toBe(true);
	}, 30_000);

	it("defaults release loops to ten iterations and gives interop runs fresh state", () => {
		const runRoot = makeTempCertDir();
		const first = buildInteropIterationState(runRoot, 1);
		const second = buildInteropIterationState(runRoot, 2);

		expect(DEFAULT_REQUIRED_COLD_LOOP_COUNT).toBe(10);
		expect(resolveRequiredColdLoopCount({})).toBe(10);
		expect(
			resolveRequiredColdLoopCount({ WEBTRANSPORT_COLD_LOOP_COUNT: "2" }),
		).toBe(2);
		expect(first.rootDir).not.toBe(second.rootDir);
		expect(first.env.WEBTRANSPORT_INTEROP_CERT_DIR).not.toBe(
			second.env.WEBTRANSPORT_INTEROP_CERT_DIR,
		);
		expect(first.env.WEBTRANSPORT_INTEROP_QUIC_PORT).not.toBe(
			second.env.WEBTRANSPORT_INTEROP_QUIC_PORT,
		);
		expect(first.env.WEBTRANSPORT_INTEROP_HEALTH_PORT).not.toBe(
			second.env.WEBTRANSPORT_INTEROP_HEALTH_PORT,
		);
	});
});
