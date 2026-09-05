/**
 * Tests for the Phase 3.6.1 spawn contract.
 *
 * Pure-helper tests cover argv construction, FD distinctness, the rig-side
 * wrapper script, and SSH argv construction. The live `Bun.spawn` paths in
 * `spawnMacSupervisor` are exercised in the controller's e2e tests
 * (Phase 3.6.5); they are not unit-testable in this module without a real
 * supervisor binary.
 */

import { describe, expect, it } from "bun:test";
import {
	closeSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import {
	type MacWire,
	type ScriptedMacBinaryOptions,
	ScriptedMacCohortBinary,
	scriptedRigExecutionAcceptedAck,
	serveScriptedMac,
} from "./cohort-fixture-signing.ts";
import {
	bytesOfCanonical,
	CohortEvidenceBudget,
	decodeRegisteredRemotePayload,
	encodeRegisteredRemotePayload,
	generateEd25519KeyPair,
	type MacCohortOpenedAckV1,
	signRigReceipt,
} from "./cross-supervisor-protocol.ts";
import {
	R1_CAMPAIGN_AUTHORITY_BYTES,
	R1_CAMPAIGN_AUTHORITY_SHA256,
	R1_CAMPAIGN_LOCK_BYTES,
	R1_CAMPAIGN_MANIFEST_V1_BYTES,
	R1_STAGED_CAPABILITY_V1_BYTES,
} from "./r1-fixtures.ts";
import {
	assertDistinctFds,
	buildMacSupervisorArgv,
	buildRigSshArgv,
	buildRigSupervisorWrapperScript,
	CohortRigChannel,
	createCloexecPipe,
	createControlPipePair,
	MacCohortChannel,
	mapRigRefusalCodeToIndexCode,
	resolveSupervisorBinaryPath,
	resolveSupervisorBunPath,
	type SupervisorSpawnOptions,
	stageTrustBootstrap,
	type TrustBootstrap,
	verifyStagedTrustBootstrap,
} from "./remote-supervisor.ts";
import { buildFanoutCohortFixture } from "./scenarios/fanout-relay.ts";
import { sha256HexOfBytes } from "./secure-fs.ts";
import { encodeSupervisorFrame } from "./supervisor-client.ts";

const BOOTSTRAP: TrustBootstrap = {
	authority: { fd: 3, label: "authority" },
	authorityDigest: { fd: 4, label: "authority-digest" },
	campaignRoot: { fd: 5, label: "campaign-root" },
	stagingRoot: { fd: 6, label: "staging-root" },
};

const SAMPLE_OPTIONS: SupervisorSpawnOptions = {
	// Use a binary that is guaranteed to exist on every test host so the
	// argv-builder's existence check does not fail before the test's own
	// assertion runs. The actual comparison-supervisor binary is only on
	// the Mac and the rig, not in CI.
	binaryPath: "/bin/sh",
	bootstrap: BOOTSTRAP,
	bunExecutablePath: "/Users/vmeansdev/.bun/bin/bun",
};

describe("remote-supervisor: assertDistinctFds", () => {
	it("accepts a clean bootstrap with all distinct FDs", () => {
		const result = assertDistinctFds(SAMPLE_OPTIONS);
		expect(result.ok).toBe(true);
	});

	it("accepts bootstrap + control with all six FDs distinct", () => {
		const result = assertDistinctFds({
			...SAMPLE_OPTIONS,
			control: {
				controlIn: { fd: 7, label: "control-in" },
				controlOut: { fd: 8, label: "control-out" },
			},
		});
		expect(result.ok).toBe(true);
	});

	it("refuses a duplicate FD between bootstrap entries", () => {
		const result = assertDistinctFds({
			...SAMPLE_OPTIONS,
			bootstrap: {
				...BOOTSTRAP,
				authorityDigest: { fd: 3, label: "authority-digest-collision" },
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("SPAWN_FD_DUPLICATE");
	});

	it("refuses a duplicate FD between bootstrap and control", () => {
		const result = assertDistinctFds({
			...SAMPLE_OPTIONS,
			control: {
				controlIn: { fd: 5, label: "control-in-collision" },
				controlOut: { fd: 8, label: "control-out" },
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("SPAWN_FD_DUPLICATE");
	});

	it("refuses a negative FD", () => {
		const result = assertDistinctFds({
			...SAMPLE_OPTIONS,
			bootstrap: {
				...BOOTSTRAP,
				authority: { fd: -1, label: "authority-negative" },
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("SPAWN_BOOTSTRAP_FD_MISSING");
	});
});

describe("remote-supervisor: buildMacSupervisorArgv", () => {
	it("builds an argv with the four bootstrap FD options", () => {
		const result = buildMacSupervisorArgv(SAMPLE_OPTIONS);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.argv[0]).toBe(SAMPLE_OPTIONS.binaryPath);
		expect(result.argv).toContain("--authority-fd");
		expect(result.argv).toContain("3");
		expect(result.argv).toContain("--authority-digest-fd");
		expect(result.argv).toContain("4");
		expect(result.argv).toContain("--campaign-root-fd");
		expect(result.argv).toContain("5");
		expect(result.argv).toContain("--staging-root-fd");
		expect(result.argv).toContain("6");
	});

	it("omits --control-in-fd / --control-out-fd when control is absent", () => {
		const result = buildMacSupervisorArgv(SAMPLE_OPTIONS);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.argv).not.toContain("--control-in-fd");
		expect(result.argv).not.toContain("--control-out-fd");
	});

	it("includes --control-in-fd and --control-out-fd when control is present", () => {
		const result = buildMacSupervisorArgv({
			...SAMPLE_OPTIONS,
			control: {
				controlIn: { fd: 7, label: "control-in" },
				controlOut: { fd: 8, label: "control-out" },
			},
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.argv).toContain("--control-in-fd");
		expect(result.argv).toContain("7");
		expect(result.argv).toContain("--control-out-fd");
		expect(result.argv).toContain("8");
	});

	it("refuses duplicate FDs before checking the binary exists", () => {
		const result = buildMacSupervisorArgv({
			...SAMPLE_OPTIONS,
			bootstrap: {
				...BOOTSTRAP,
				authority: { fd: 4, label: "dup" },
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("SPAWN_FD_DUPLICATE");
	});

	it("refuses when the supervisor binary does not exist", () => {
		const result = buildMacSupervisorArgv({
			...SAMPLE_OPTIONS,
			binaryPath: "/does/not/exist/comparison-supervisor",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("SPAWN_BINARY_MISSING");
	});
});

describe("remote-supervisor: buildRigSupervisorWrapperScript", () => {
	it("emits a self-contained bash script that pipes authority and execs the supervisor", () => {
		const result = buildRigSupervisorWrapperScript({
			...SAMPLE_OPTIONS,
			binaryPath: "/usr/local/bin/comparison-supervisor",
			rigBinaryPath: "/opt/webtransport/target/release/comparison-supervisor",
			rigPaths: {
				authorityFile: "/var/staged/<campaign>/authority.json",
				authorityDigestFile: "/var/staged/<campaign>/authority-digest.bin",
				campaignRootDir: "/var/campaign/<campaign>",
				stagingRootDir: "/var/staged/<campaign>",
			},
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// The script must exec the rig-side binary with the FD-number argv.
		expect(result.script).toContain(
			"/opt/webtransport/target/release/comparison-supervisor",
		);
		// The control FDs are 0 and 1 (SSH session's stdin/stdout).
		expect(result.script).toContain("--control-in-fd 0");
		expect(result.script).toContain("--control-out-fd 1");
		// Bootstrap FDs are 3, 4, 5, 6 (post 0/1/2 reservation).
		expect(result.script).toContain("--authority-fd");
		expect(result.script).toContain("--authority-digest-fd");
		expect(result.script).toContain("--campaign-root-fd");
		expect(result.script).toContain("--staging-root-fd");
		// `set -eu` so a missing file aborts rather than silently succeeding.
		expect(result.script).toContain("set -eu");
	});

	it("refuses duplicate FDs in the rig-side options", () => {
		const result = buildRigSupervisorWrapperScript({
			...SAMPLE_OPTIONS,
			rigBinaryPath: "/opt/webtransport/target/release/comparison-supervisor",
			rigPaths: {
				authorityFile: "/var/staged/<campaign>/authority.json",
				authorityDigestFile: "/var/staged/<campaign>/authority-digest.bin",
				campaignRootDir: "/var/campaign/<campaign>",
				stagingRootDir: "/var/staged/<campaign>",
			},
			control: {
				controlIn: { fd: 3, label: "control-in-collision" },
				controlOut: { fd: 4, label: "control-out" },
			},
			bootstrap: {
				...BOOTSTRAP,
				authority: { fd: 3, label: "authority-collision" },
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("SPAWN_FD_DUPLICATE");
	});
});

describe("remote-supervisor: buildRigSshArgv", () => {
	it("emits an ssh argv that pipes the wrapper script via stdin (sh -s)", () => {
		const result = buildRigSshArgv({
			...SAMPLE_OPTIONS,
			rigBinaryPath: "/opt/webtransport/target/release/comparison-supervisor",
			rigPaths: {
				authorityFile: "/var/staged/<campaign>/authority.json",
				authorityDigestFile: "/var/staged/<campaign>/authority-digest.bin",
				campaignRootDir: "/var/campaign/<campaign>",
				stagingRootDir: "/var/staged/<campaign>",
			},
			sshTarget: "hermes-admin@10.99.0.2",
			sshIdentity: "~/.ssh/ubuntu-vm-hermes",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.sshArgv[0]).toBe("ssh");
		expect(result.sshArgv).toContain("-i");
		expect(result.sshArgv).toContain("~/.ssh/ubuntu-vm-hermes");
		expect(result.sshArgv).toContain("hermes-admin@10.99.0.2");
		// `-T` disables pty allocation: stdin/stdout ARE the supervisor's
		// control FDs.
		expect(result.sshArgv).toContain("-T");
		// The script body is non-empty so the caller can upload it; spawn
		// uses a two-step upload+exec so stdin stays free for control.
		expect(result.wrapperScript.length).toBeGreaterThan(0);
		expect(result.wrapperScript).toContain("#!/usr/bin/env bash");
		expect(result.wrapperScript).toContain("<(cat --");
		expect(result.sshArgv).toContain("bash");
	});
});

describe("remote-supervisor: createCloexecPipe / createControlPipePair", () => {
	it("round-trips bytes on a write-parent pipe", () => {
		const result = createCloexecPipe({ parentKeeps: "write" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const payload = Buffer.from("control-frame");
		writeSync(result.pipe.parentFd, payload);
		const buf = Buffer.alloc(32);
		const n = readSync(result.pipe.childFd, buf);
		expect(buf.subarray(0, n).toString()).toBe("control-frame");
		closeSync(result.pipe.parentFd);
		closeSync(result.pipe.childFd);
	});

	it("returns controller write / supervisor read streams for the control pair", () => {
		const result = createControlPipePair();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.controllerToSupervisor.writable).toBe(true);
		expect(result.supervisorToController.readable).toBe(true);
		expect(result.controlIn.parentFd).not.toBe(result.controlIn.childFd);
		expect(result.controlOut.parentFd).not.toBe(result.controlOut.childFd);
		closeSync(result.controlIn.parentFd);
		closeSync(result.controlIn.childFd);
		closeSync(result.controlOut.parentFd);
		closeSync(result.controlOut.childFd);
	});
});

describe("remote-supervisor: stageTrustBootstrap / verifyStagedTrustBootstrap", () => {
	it("stages R1 fixture material and verifies against the pinned authority digest", () => {
		const stagedDir = mkdtempSync(join(tmpdir(), "ws-wt-stage-"));
		try {
			const staged = stageTrustBootstrap(stagedDir, {
				authorityBytes: R1_CAMPAIGN_AUTHORITY_BYTES,
				authoritySha256Hex: R1_CAMPAIGN_AUTHORITY_SHA256,
				campaignLockBytes: R1_CAMPAIGN_LOCK_BYTES,
				stagedCapabilityBytes: R1_STAGED_CAPABILITY_V1_BYTES,
				manifestBytes: R1_CAMPAIGN_MANIFEST_V1_BYTES,
			});
			expect(staged.ok).toBe(true);
			if (!staged.ok) return;
			expect(staged.paths.digests.authority).toBe(R1_CAMPAIGN_AUTHORITY_SHA256);
			const digestFile = readFileSync(staged.paths.authorityDigestFile);
			expect(digestFile.byteLength).toBe(32);

			const verified = verifyStagedTrustBootstrap(
				stagedDir,
				R1_CAMPAIGN_AUTHORITY_SHA256,
			);
			expect(verified.ok).toBe(true);
			if (!verified.ok) return;
			expect(verified.paths.campaignRootDir).toBe(staged.paths.campaignRootDir);
			expect(verified.paths.stagingRootDir).toBe(staged.paths.stagingRootDir);
		} finally {
			rmSync(stagedDir, { recursive: true, force: true });
		}
	});

	it("refuses a staged dir whose authority digest does not match the pin", () => {
		const stagedDir = mkdtempSync(join(tmpdir(), "ws-wt-stage-bad-"));
		try {
			const staged = stageTrustBootstrap(stagedDir, {
				authorityBytes: R1_CAMPAIGN_AUTHORITY_BYTES,
				authoritySha256Hex: R1_CAMPAIGN_AUTHORITY_SHA256,
				campaignLockBytes: R1_CAMPAIGN_LOCK_BYTES,
				stagedCapabilityBytes: R1_STAGED_CAPABILITY_V1_BYTES,
				manifestBytes: R1_CAMPAIGN_MANIFEST_V1_BYTES,
			});
			expect(staged.ok).toBe(true);
			const verified = verifyStagedTrustBootstrap(stagedDir, "a".repeat(64));
			expect(verified.ok).toBe(false);
			if (verified.ok) return;
			expect(verified.code).toBe("STAGE_DIGEST_MISMATCH");
		} finally {
			rmSync(stagedDir, { recursive: true, force: true });
		}
	});
});

describe("remote-supervisor: resolveSupervisorBinaryPath / Bun path", () => {
	it("prefers COMPARISON_SUPERVISOR_BINARY when set to an existing path", () => {
		const stagedDir = mkdtempSync(join(tmpdir(), "ws-wt-bin-"));
		const binary = join(stagedDir, "comparison-supervisor");
		try {
			writeFileSync(binary, "#!/bin/true\n", { mode: 0o755 });
			const resolved = resolveSupervisorBinaryPath(
				{ COMPARISON_SUPERVISOR_BINARY: binary },
				stagedDir,
			);
			expect(resolved.ok).toBe(true);
			if (!resolved.ok) return;
			expect(resolved.path).toBe(binary);
		} finally {
			rmSync(stagedDir, { recursive: true, force: true });
		}
	});

	it("refuses when neither env nor default binary exists", () => {
		const resolved = resolveSupervisorBinaryPath(
			{},
			join(tmpdir(), "ws-wt-missing-cwd-does-not-exist"),
		);
		expect(resolved.ok).toBe(false);
	});

	it("resolves Bun from COMPARISON_SUPERVISOR_BUN_PATH", () => {
		const resolved = resolveSupervisorBunPath({
			COMPARISON_SUPERVISOR_BUN_PATH: "/custom/bun",
		});
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		expect(resolved.path).toBe("/custom/bun");
	});
});

// ---------------------------------------------------------------------------
// B3.5: the controller ↔ rig cohort channel
//
// Every test below drives the real codec against a scripted rig peer that
// speaks B1's exact bytes: nothing is stubbed at the parse boundary, so a
// refusal here is a refusal the wire would actually produce.
// ---------------------------------------------------------------------------

const RIG_EXECUTION_SHA256 = "1".repeat(64);
const RIG_HEX = (c: string) => c.repeat(64);

/** The byte length of the frame starting at offset 0, or null if incomplete. */
function framedLength(buffer: Uint8Array): number | null {
	if (buffer.byteLength < 4) return null;
	const view = new DataView(
		buffer.buffer,
		buffer.byteOffset,
		buffer.byteLength,
	);
	const headerLength = view.getUint32(0, false);
	if (buffer.byteLength < 4 + headerLength + 8) return null;
	const payloadLength = Number(view.getBigUint64(4 + headerLength, false));
	const total = 4 + headerLength + 8 + payloadLength + 32;
	return buffer.byteLength < total ? null : total;
}

type RigReply = Record<string, unknown> | "silence";

interface RigWire {
	readonly controllerToRig: PassThrough;
	readonly rigToController: PassThrough;
	readonly seen: Record<string, unknown>[];
}

/**
 * Attach a scripted rig to a pipe pair. `respond` sees the exact decoded
 * request payload and returns the exact payload the rig writes back.
 */
function serveScriptedRig(
	respond: (request: Record<string, unknown>) => RigReply,
): RigWire {
	const controllerToRig = new PassThrough();
	const rigToController = new PassThrough();
	const seen: Record<string, unknown>[] = [];
	let pending = new Uint8Array(0);
	controllerToRig.on("data", (chunk: Buffer) => {
		const merged = new Uint8Array(pending.byteLength + chunk.byteLength);
		merged.set(pending, 0);
		merged.set(new Uint8Array(chunk), pending.byteLength);
		pending = merged;
		for (;;) {
			const length = framedLength(pending);
			if (length === null) return;
			const frame = pending.slice(0, length);
			pending = pending.slice(length);
			const decoded = decodeRegisteredRemotePayload(frame);
			if (!decoded.ok) throw new Error(`scripted rig: ${decoded.code}`);
			seen.push(decoded.value.payload);
			const reply = respond(decoded.value.payload);
			if (reply === "silence") {
				rigToController.end();
				return;
			}
			const encoded = encodeRegisteredRemotePayload(
				reply as Record<string, unknown> & { schema: string },
			);
			if (!encoded.ok) throw new Error(`scripted rig encode: ${encoded.code}`);
			rigToController.write(Buffer.from(encoded.value));
		}
	});
	return { controllerToRig, rigToController, seen };
}

/** The Mac-side inputs the channel carries but never mints. */
const MAC_COHORT_GRANT_BYTES = bytesOfCanonical({
	schema: "cohort-grant/v1",
	executionSha256: RIG_EXECUTION_SHA256,
});
const MAC_COHORT_GRANT_SIGNATURE_BYTES = bytesOfCanonical({
	schema: "mac-receipt-signature/v1",
	signedSchema: "cohort-grant/v1",
});
/** The Phase-A trio the channel carries on RIG_EXECUTION_ACCEPTED, never mints. */
const MAC_MEASUREMENT_GRANT_BYTES = bytesOfCanonical({
	schema: "measurement-grant/v1",
	runId: "rig-channel-run",
});
const MAC_EXECUTION_RECEIPT_BYTES = bytesOfCanonical({
	schema: "mac-execution-grant-receipt/v1",
	executionSha256: RIG_EXECUTION_SHA256,
	approvedPlanSha256: RIG_HEX("b"),
	approvalRecordSha256: RIG_HEX("c"),
	notAfterMs: 900_000,
});
const MAC_EXECUTION_RECEIPT_SIGNATURE_BYTES = bytesOfCanonical({
	schema: "mac-receipt-signature/v1",
	signedSchema: "mac-execution-grant-receipt/v1",
});
const MAC_WARMUP_EPOCH_BYTES = bytesOfCanonical({
	schema: "cohort-warmup-epoch/v1",
	executionSha256: RIG_EXECUTION_SHA256,
});
const MAC_WARMUP_EPOCH_SIGNATURE_BYTES = bytesOfCanonical({
	schema: "mac-receipt-signature/v1",
	signedSchema: "cohort-warmup-epoch/v1",
});
const MAC_MANIFEST_BYTES = bytesOfCanonical({
	schema: "role-warmup-completion-manifest/v1",
	executionSha256: RIG_EXECUTION_SHA256,
});
const MAC_MANIFEST_SIGNATURE_BYTES = bytesOfCanonical({
	schema: "mac-receipt-signature/v1",
	signedSchema: "role-warmup-completion-manifest/v1",
});
const MAC_BARRIER_BYTES = bytesOfCanonical({
	schema: "cohort-start-barrier/v1",
	executionSha256: RIG_EXECUTION_SHA256,
});
const MAC_BARRIER_SIGNATURE_BYTES = bytesOfCanonical({
	schema: "mac-receipt-signature/v1",
	signedSchema: "cohort-start-barrier/v1",
});
const STAGED_LAUNCH_RECORD_BYTES = bytesOfCanonical({
	schema: "staged-server-launch-record/v1",
	bindPort: 4433,
});

const GRANT_SHA256 = sha256HexOfBytes(MAC_COHORT_GRANT_BYTES);
const GRANT_SIGNATURE_SHA256 = sha256HexOfBytes(
	MAC_COHORT_GRANT_SIGNATURE_BYTES,
);
const BARRIER_SHA256 = sha256HexOfBytes(MAC_BARRIER_BYTES);
const BARRIER_SIGNATURE_SHA256 = sha256HexOfBytes(MAC_BARRIER_SIGNATURE_BYTES);

const b64 = (bytes: Uint8Array): string =>
	Buffer.from(bytes).toString("base64");

/**
 * An honest rig: it answers every request of the lifecycle with the records a
 * real rig supervisor would sign, using `keys` as its signing identity.
 */
function honestRig(keys: ReturnType<typeof generateEd25519KeyPair>) {
	let responseSeq = 0;
	const nonce = RIG_HEX("7");
	const drainedFrame = bytesOfCanonical({
		schema: "server-warmup-drained/v1",
		executionSha256: RIG_EXECUTION_SHA256,
	});
	const barrierAcceptedFrame = bytesOfCanonical({
		schema: "server-start-barrier-accepted/v1",
		executionSha256: RIG_EXECUTION_SHA256,
	});
	const snapshotFrame = bytesOfCanonical({
		schema: "server-snapshot/v1",
		executionSha256: RIG_EXECUTION_SHA256,
	});
	const observation = bytesOfCanonical({
		schema: "linux-relay-observation/v1",
		executionSha256: RIG_EXECUTION_SHA256,
	});
	let measureStartAckBytes: Uint8Array = bytesOfCanonical({});

	const sign = (
		signedSchema: Parameters<typeof signRigReceipt>[0]["signedSchema"],
		signedBytes: Uint8Array,
	) =>
		b64(
			bytesOfCanonical(
				signRigReceipt({
					privatePkcs8Der: keys.privatePkcs8Der,
					publicRaw32: keys.publicRaw32,
					signedSchema,
					signedBytes,
				}),
			),
		);

	return (request: Record<string, unknown>): RigReply => {
		const ackRequestSeq = request.requestSeq as number;
		const seq = responseSeq;
		responseSeq += 1;
		switch (request.schema) {
			case "rig-accept-execution-request/v1":
				return scriptedRigExecutionAcceptedAck({
					rigKeys: keys,
					request,
					executionSha256: RIG_EXECUTION_SHA256 as never,
					responseSeq: seq,
					nowMs: 1_000,
					instanceNonceSha256: nonce as never,
				});
			case "rig-accept-cohort-request/v1": {
				const acceptance = {
					schema: "rig-cohort-acceptance/v1",
					executionSha256: RIG_EXECUTION_SHA256,
					cohortGrantSha256: GRANT_SHA256,
					cohortGrantSignatureSha256: GRANT_SIGNATURE_SHA256,
					roleTokenCommitmentRootSha256: RIG_HEX("a"),
					approvedPlanSha256: RIG_HEX("b"),
					approvalRecordSha256: RIG_HEX("c"),
					rigExecutionIndex: 0,
					rigSupervisorInstanceNonce: nonce,
					signingPublicKeySha256: keys.publicKeySha256,
					receiptSequence: 0,
					acceptedAtMs: 1_000,
					issuedAtMs: 1_000,
					notAfterMs: 900_000,
				};
				const bytes = bytesOfCanonical(acceptance);
				return {
					schema: "rig-cohort-accepted-ack/v1",
					responseSeq: seq,
					ackRequestSeq,
					executionSha256: RIG_EXECUTION_SHA256,
					cohortGrantSha256: GRANT_SHA256,
					rigCohortAcceptanceBase64: b64(bytes),
					rigCohortAcceptanceSignatureBase64: sign(
						"rig-cohort-acceptance/v1",
						bytes,
					),
				};
			}
			case "rig-spawn-server-request/v1":
				return {
					schema: "rig-server-ready-ack/v1",
					responseSeq: seq,
					ackRequestSeq,
					executionSha256: RIG_EXECUTION_SHA256,
					childPid: 9_001,
					childPgid: 9_001,
					childInstanceNonce: RIG_HEX("d"),
					serverReadyFrameSha256: RIG_HEX("e"),
				};
			case "rig-begin-warmup-request/v1":
				return {
					schema: "rig-warmup-ready-ack/v1",
					responseSeq: seq,
					ackRequestSeq,
					executionSha256: RIG_EXECUTION_SHA256,
					serverWarmupReadySha256: RIG_HEX("f"),
				};
			case "rig-finish-warmup-request/v1": {
				const receipt = {
					schema: "rig-warmup-drained-receipt/v1",
					executionSha256: RIG_EXECUTION_SHA256,
					cohortGrantSha256: GRANT_SHA256,
					cohortWarmupEpochSha256: sha256HexOfBytes(MAC_WARMUP_EPOCH_BYTES),
					cohortWarmupEpochSignatureSha256: sha256HexOfBytes(
						MAC_WARMUP_EPOCH_SIGNATURE_BYTES,
					),
					roleWarmupCompletionManifestSha256:
						sha256HexOfBytes(MAC_MANIFEST_BYTES),
					roleWarmupCompletionManifestSignatureSha256: sha256HexOfBytes(
						MAC_MANIFEST_SIGNATURE_BYTES,
					),
					serverWarmupDrainedSha256: sha256HexOfBytes(drainedFrame),
					rigSupervisorInstanceNonce: nonce,
					signingPublicKeySha256: keys.publicKeySha256,
					receiptSequence: 1,
					receivedAtRigNs: "1700000000000000000",
					linuxClockId: RIG_HEX("2"),
					issuedAtMs: 2_000,
					notAfterMs: 900_000,
				};
				const bytes = bytesOfCanonical(receipt);
				return {
					schema: "rig-warmup-drained-ack/v1",
					responseSeq: seq,
					ackRequestSeq,
					executionSha256: RIG_EXECUTION_SHA256,
					serverWarmupDrainedBase64: b64(drainedFrame),
					serverWarmupDrainedSha256: sha256HexOfBytes(drainedFrame),
					serverWarmupDrainedSize: drainedFrame.byteLength,
					rigWarmupDrainedReceiptBase64: b64(bytes),
					rigWarmupDrainedReceiptSignatureBase64: sign(
						"rig-warmup-drained-receipt/v1",
						bytes,
					),
				};
			}
			case "rig-measure-start-request/v1": {
				const ack = {
					schema: "rig-measure-start-ack/v1",
					responseSeq: seq,
					ackRequestSeq,
					executionSha256: RIG_EXECUTION_SHA256,
					childResponseSequence: 0,
					baselineBusyMs: 0,
					baselineAtLinuxNs: "1700000000000000001",
					linuxClockId: RIG_HEX("2"),
					warmupCompletionAuthoritySha256: null,
					rigWarmupDrainedReceiptSha256:
						request.rigWarmupDrainedReceiptSha256 as string,
					signingPublicKeySha256: keys.publicKeySha256,
					rigSupervisorInstanceNonce: nonce,
					receiptSequence: 2,
					issuedAtMs: 3_000,
					notAfterMs: 900_000,
				};
				measureStartAckBytes = bytesOfCanonical(ack);
				return {
					schema: "rig-measure-started-ack/v1",
					responseSeq: seq,
					ackRequestSeq,
					executionSha256: RIG_EXECUTION_SHA256,
					rigMeasureStartAckBase64: b64(measureStartAckBytes),
					rigMeasureStartAckSignatureBase64: sign(
						"rig-measure-start-ack/v1",
						measureStartAckBytes,
					),
				};
			}
			case "rig-present-start-barrier-request/v1": {
				const acceptance = {
					schema: "rig-barrier-acceptance/v1",
					executionSha256: RIG_EXECUTION_SHA256,
					cohortGrantSha256: GRANT_SHA256,
					cohortStartBarrierSha256: BARRIER_SHA256,
					cohortStartBarrierSignatureSha256: BARRIER_SIGNATURE_SHA256,
					rigMeasureStartAckSha256: sha256HexOfBytes(measureStartAckBytes),
					serverStartBarrierAcceptedSha256:
						sha256HexOfBytes(barrierAcceptedFrame),
					rigSupervisorInstanceNonce: nonce,
					signingPublicKeySha256: keys.publicKeySha256,
					receiptSequence: 3,
					acceptedAtLinuxNs: "1700000000000000002",
					linuxClockId: RIG_HEX("2"),
					issuedAtMs: 4_000,
					notAfterMs: 900_000,
				};
				const bytes = bytesOfCanonical(acceptance);
				return {
					schema: "rig-barrier-accepted-ack/v1",
					responseSeq: seq,
					ackRequestSeq,
					executionSha256: RIG_EXECUTION_SHA256,
					serverStartBarrierAcceptedBase64: b64(barrierAcceptedFrame),
					serverStartBarrierAcceptedSha256:
						sha256HexOfBytes(barrierAcceptedFrame),
					serverStartBarrierAcceptedSize: barrierAcceptedFrame.byteLength,
					rigBarrierAcceptanceBase64: b64(bytes),
					rigBarrierAcceptanceSignatureBase64: sign(
						"rig-barrier-acceptance/v1",
						bytes,
					),
				};
			}
			case "rig-stop-and-capture-request/v1": {
				const snapshotReceipt = {
					schema: "rig-server-snapshot-receipt/v1",
					executionSha256: RIG_EXECUTION_SHA256,
					snapshotFrameSha256: sha256HexOfBytes(snapshotFrame),
				};
				const snapshotReceiptBytes = bytesOfCanonical(snapshotReceipt);
				const relayReceipt = {
					schema: "rig-relay-observation-receipt/v1",
					executionSha256: RIG_EXECUTION_SHA256,
					cohortGrantSha256: GRANT_SHA256,
					cohortStartBarrierSha256: BARRIER_SHA256,
					linuxRelayObservationSha256: sha256HexOfBytes(observation),
					rigExecutionAcceptanceSha256: RIG_HEX("3"),
					rigSupervisorInstanceNonce: nonce,
					signingPublicKeySha256: keys.publicKeySha256,
					receiptSequence: 4,
					receivedAtRigNs: "1700000000000000003",
					issuedAtMs: 5_000,
					notAfterMs: 900_000,
				};
				const relayReceiptBytes = bytesOfCanonical(relayReceipt);
				return {
					schema: "rig-capture-complete-ack/v1",
					responseSeq: seq,
					ackRequestSeq,
					executionSha256: RIG_EXECUTION_SHA256,
					snapshotFrameBase64: b64(snapshotFrame),
					rigServerSnapshotReceiptBase64: b64(snapshotReceiptBytes),
					rigServerSnapshotReceiptSignatureBase64: sign(
						"rig-server-snapshot-receipt/v1",
						snapshotReceiptBytes,
					),
					linuxRelayObservationBase64: b64(observation),
					rigRelayObservationReceiptBase64: b64(relayReceiptBytes),
					rigRelayObservationReceiptSignatureBase64: sign(
						"rig-relay-observation-receipt/v1",
						relayReceiptBytes,
					),
				};
			}
			default:
				throw new Error(`scripted rig got ${String(request.schema)}`);
		}
	};
}

const RIG_DEADLINES = {
	frameMs: 5_000,
	serverReadyMs: 15_000,
	warmupDrainMs: 6_000,
	captureMs: 15_000,
};

function channelFor(
	wire: RigWire,
	stagedRigPublicRaw32: Uint8Array,
): CohortRigChannel {
	return new CohortRigChannel({
		controllerToRig: wire.controllerToRig,
		rigToController: wire.rigToController,
		executionSha256: RIG_EXECUTION_SHA256,
		stagedRigPublicRaw32,
		deadlines: RIG_DEADLINES,
	});
}

const SPAWN_REQUEST = {
	cohortGrantSha256: GRANT_SHA256,
	serverEntrypointSha256: RIG_HEX("4"),
	bunSha256: RIG_HEX("5"),
	addonSha256: RIG_HEX("6"),
	stagedServerLaunchRecordBytes: STAGED_LAUNCH_RECORD_BYTES,
	bindPort: 4433,
	transport: "wt",
	serverArgv: ["server.ts", "--transport=wt", "--mode=fanout-cohort"],
} as const;

/** Walk the whole lifecycle; every step must be ok or the test says which. */
async function acceptExecutionOn(channel: CohortRigChannel) {
	return channel.acceptExecution({
		measurementGrantBytes: MAC_MEASUREMENT_GRANT_BYTES,
		receiptBytes: MAC_EXECUTION_RECEIPT_BYTES,
		receiptSignatureBytes: MAC_EXECUTION_RECEIPT_SIGNATURE_BYTES,
	});
}

async function runLifecycle(channel: CohortRigChannel) {
	const executionAccepted = await acceptExecutionOn(channel);
	if (!executionAccepted.ok)
		return { at: "acceptExecution", result: executionAccepted } as const;
	const accepted = await channel.acceptCohort({
		cohortGrantBytes: MAC_COHORT_GRANT_BYTES,
		cohortGrantSignatureBytes: MAC_COHORT_GRANT_SIGNATURE_BYTES,
	});
	if (!accepted.ok) return { at: "acceptCohort", result: accepted } as const;
	const spawned = await channel.spawnServer(SPAWN_REQUEST);
	if (!spawned.ok) return { at: "spawnServer", result: spawned } as const;
	const begun = await channel.beginWarmup({
		cohortWarmupEpochBytes: MAC_WARMUP_EPOCH_BYTES,
		cohortWarmupEpochSignatureBytes: MAC_WARMUP_EPOCH_SIGNATURE_BYTES,
	});
	if (!begun.ok) return { at: "beginWarmup", result: begun } as const;
	const drained = await channel.finishWarmup({
		cohortWarmupEpochBytes: MAC_WARMUP_EPOCH_BYTES,
		cohortWarmupEpochSignatureBytes: MAC_WARMUP_EPOCH_SIGNATURE_BYTES,
		roleWarmupCompletionManifestBytes: MAC_MANIFEST_BYTES,
		roleWarmupCompletionManifestSignatureBytes: MAC_MANIFEST_SIGNATURE_BYTES,
	});
	if (!drained.ok) return { at: "finishWarmup", result: drained } as const;
	const baseline = await channel.measureStart({
		warmupCompleteSha256: null,
		rigWarmupDrainedReceiptSha256: sha256HexOfBytes(drained.value.receiptBytes),
	});
	if (!baseline.ok) return { at: "measureStart", result: baseline } as const;
	const barrier = await channel.presentStartBarrier({
		cohortStartBarrierBytes: MAC_BARRIER_BYTES,
		cohortStartBarrierSignatureBytes: MAC_BARRIER_SIGNATURE_BYTES,
	});
	if (!barrier.ok) {
		return { at: "presentStartBarrier", result: barrier } as const;
	}
	const captured = await channel.stopAndCapture({
		macStopIssuedAtNs: "1700000000000000009",
		drainDeadlineMs: 10_000,
	});
	if (!captured.ok) return { at: "stopAndCapture", result: captured } as const;
	return {
		at: "complete",
		result: { ok: true as const },
		accepted,
		drained,
		baseline,
		barrier,
		captured,
	} as const;
}

/** Re-sign a barrier acceptance after patching it, as a real rig would. */
function resignBarrierAcceptance(
	keys: ReturnType<typeof generateEd25519KeyPair>,
	reply: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	const record = JSON.parse(
		Buffer.from(reply.rigBarrierAcceptanceBase64 as string, "base64").toString(
			"utf8",
		),
	);
	Object.assign(record, patch);
	const bytes = bytesOfCanonical(record);
	return {
		rigBarrierAcceptanceBase64: b64(bytes),
		rigBarrierAcceptanceSignatureBase64: b64(
			bytesOfCanonical(
				signRigReceipt({
					privatePkcs8Der: keys.privatePkcs8Der,
					publicRaw32: keys.publicRaw32,
					signedSchema: "rig-barrier-acceptance/v1",
					signedBytes: bytes,
				}),
			),
		),
	};
}

describe("remote-supervisor: CohortRigChannel RIG_EXECUTION_ACCEPTED", () => {
	it("accepts_the_execution_first_and_refuses_a_cohort_before_it", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(keys));
		const channel = channelFor(wire, keys.publicRaw32);
		const early = await channel.acceptCohort({
			cohortGrantBytes: MAC_COHORT_GRANT_BYTES,
			cohortGrantSignatureBytes: MAC_COHORT_GRANT_SIGNATURE_BYTES,
		});
		expect(early.ok).toBe(false);
		if (early.ok) throw new Error("unreachable");
		expect(early.code).toBe("COHORT_NOT_READY");
		expect(wire.seen).toEqual([]);

		const accepted = await acceptExecutionOn(channel);
		if (!accepted.ok) throw new Error(`${accepted.code}: ${accepted.message}`);
		expect(channel.stage).toBe("execution-accepted");
		expect(accepted.value.acceptance.executionSha256).toBe(
			RIG_EXECUTION_SHA256,
		);
		expect(accepted.value.acceptance.measurementGrantSha256).toBe(
			sha256HexOfBytes(MAC_MEASUREMENT_GRANT_BYTES),
		);
		expect(accepted.value.acceptance.macExecutionGrantReceiptSha256).toBe(
			sha256HexOfBytes(MAC_EXECUTION_RECEIPT_BYTES),
		);
		expect(accepted.value.acceptance.macReceiptSignatureSha256).toBe(
			sha256HexOfBytes(MAC_EXECUTION_RECEIPT_SIGNATURE_BYTES),
		);
		expect(accepted.value.signature.signedSchema).toBe(
			"rig-execution-acceptance/v1",
		);
		// Once, per execution.
		const again = await acceptExecutionOn(channel);
		expect(again.ok).toBe(false);
	});

	it("refuses_an_acceptance_signed_by_a_key_that_is_not_the_staged_rig_key", async () => {
		const keys = generateEd25519KeyPair();
		const other = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(other));
		const channel = channelFor(wire, keys.publicRaw32);
		const accepted = await acceptExecutionOn(channel);
		expect(accepted.ok).toBe(false);
		if (accepted.ok) throw new Error("unreachable");
		expect(accepted.code).toBe("RIG_SIGNING_KEY_MISMATCH");
		expect(channel.stage).toBe("opened");
		expect(channel.executionAcceptance).toBeNull();
	});

	it("refuses_an_acceptance_that_names_another_grant_receipt_or_execution", async () => {
		for (const [field, value] of [
			["measurementGrantSha256", RIG_HEX("9")],
			["macExecutionGrantReceiptSha256", RIG_HEX("9")],
			["macReceiptSignatureSha256", RIG_HEX("9")],
			["executionSha256", RIG_HEX("2")],
		] as const) {
			const keys = generateEd25519KeyPair();
			const wire = serveScriptedRig((request) =>
				scriptedRigExecutionAcceptedAck({
					rigKeys: keys,
					request,
					executionSha256: RIG_EXECUTION_SHA256 as never,
					responseSeq: 0,
					nowMs: 1_000,
					mutate: (acceptance) => {
						acceptance[field] = value;
					},
				}),
			);
			const channel = channelFor(wire, keys.publicRaw32);
			const accepted = await acceptExecutionOn(channel);
			expect(accepted.ok).toBe(false);
			if (accepted.ok) throw new Error("unreachable");
			expect(accepted.code).toBe("CROSS_SUPERVISOR_MISMATCH");
			expect(channel.executionAcceptance).toBeNull();
		}
	});

	it("refuses_an_acceptance_whose_bytes_were_tampered_after_signing", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (
				reply !== "silence" &&
				reply.schema === "rig-execution-accepted-ack/v1"
			) {
				const bytes = Buffer.from(
					reply.rigExecutionAcceptanceBase64 as string,
					"base64",
				);
				const record = JSON.parse(bytes.toString("utf8"));
				record.rigExecutionIndex = 9;
				return {
					...reply,
					rigExecutionAcceptanceBase64: b64(bytesOfCanonical(record)),
				};
			}
			return reply;
		});
		const channel = channelFor(wire, keys.publicRaw32);
		const accepted = await acceptExecutionOn(channel);
		expect(accepted.ok).toBe(false);
		if (accepted.ok) throw new Error("unreachable");
		expect(accepted.code).toBe("RIG_RECEIPT_SIGNATURE_INVALID");
	});
});

describe("remote-supervisor: CohortRigChannel", () => {
	it("round_trips_every_cohort_frame_against_a_scripted_rig", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(keys));
		const channel = channelFor(wire, keys.publicRaw32);
		const walked = await runLifecycle(channel);
		if (walked.at !== "complete") {
			throw new Error(
				`${walked.at}: ${(walked.result as { code?: string; message?: string }).code} ${(walked.result as { message?: string }).message}`,
			);
		}
		expect(channel.stage).toBe("captured");
		expect(channel.cohortGrantSha256).toBe(GRANT_SHA256);
		expect(wire.seen.map((frame) => frame.schema)).toEqual([
			"rig-accept-execution-request/v1",
			"rig-accept-cohort-request/v1",
			"rig-spawn-server-request/v1",
			"rig-begin-warmup-request/v1",
			"rig-finish-warmup-request/v1",
			"rig-measure-start-request/v1",
			"rig-present-start-barrier-request/v1",
			"rig-stop-and-capture-request/v1",
		]);
		// The grant travels as the exact Mac bytes, not a controller rebuild.
		expect(wire.seen[1]?.cohortGrantBase64).toBe(b64(MAC_COHORT_GRANT_BYTES));
		// And the cohort accept carries exactly the acceptance the rig answered
		// RIG_EXECUTION_ACCEPTED with -- the channel's retained bytes, not a
		// record the caller supplied.
		const retained = channel.executionAcceptance;
		expect(retained).not.toBeNull();
		expect(wire.seen[1]?.rigExecutionAcceptanceBase64).toBe(
			b64(retained?.acceptanceBytes ?? new Uint8Array()),
		);
		expect(wire.seen[1]?.rigExecutionAcceptanceSignatureBase64).toBe(
			b64(retained?.signatureBytes ?? new Uint8Array()),
		);
		// The Phase-A trio went out as the exact bytes handed in.
		expect(wire.seen[0]?.measurementGrantBase64).toBe(
			b64(MAC_MEASUREMENT_GRANT_BYTES),
		);
		expect(wire.seen[0]?.macExecutionGrantReceiptBase64).toBe(
			b64(MAC_EXECUTION_RECEIPT_BYTES),
		);
		expect(walked.captured.value.relayObservationReceipt).not.toBeNull();
	});

	it("refuses_a_receipt_whose_bytes_were_tampered_after_signing", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (
				reply !== "silence" &&
				reply.schema === "rig-cohort-accepted-ack/v1"
			) {
				const bytes = Buffer.from(
					reply.rigCohortAcceptanceBase64 as string,
					"base64",
				);
				const record = JSON.parse(bytes.toString("utf8"));
				record.rigExecutionIndex = 9;
				return {
					...reply,
					rigCohortAcceptanceBase64: b64(bytesOfCanonical(record)),
				};
			}
			return reply;
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("acceptCohort");
		expect((walked.result as { code: string }).code).toBe(
			"RIG_RECEIPT_SIGNATURE_INVALID",
		);
	});

	it("refuses_an_unsigned_receipt", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (reply !== "silence" && reply.schema === "rig-warmup-drained-ack/v1") {
				return {
					...reply,
					rigWarmupDrainedReceiptSignatureBase64: b64(
						bytesOfCanonical({ schema: "not-a-signature/v1" }),
					),
				};
			}
			return reply;
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("finishWarmup");
		expect((walked.result as { code: string }).code).toBe("TRUST_PROTOCOL");
	});

	it("refuses_a_receipt_signed_by_a_key_the_campaign_did_not_stage", async () => {
		const keys = generateEd25519KeyPair();
		const staged = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(keys));
		const walked = await runLifecycle(channelFor(wire, staged.publicRaw32));
		// The first signed record on the channel is the execution acceptance.
		expect(walked.at).toBe("acceptExecution");
		expect((walked.result as { code: string }).code).toBe(
			"RIG_SIGNING_KEY_MISMATCH",
		);
	});

	it("refuses_a_genuine_signature_replayed_over_another_record_slot", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		let firstAcceptanceSignature: string | null = null;
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (reply === "silence") return reply;
			if (reply.schema === "rig-cohort-accepted-ack/v1") {
				firstAcceptanceSignature =
					reply.rigCohortAcceptanceSignatureBase64 as string;
			}
			if (
				reply.schema === "rig-warmup-drained-ack/v1" &&
				firstAcceptanceSignature !== null
			) {
				// A real, verifiable rig signature -- over the wrong record.
				return {
					...reply,
					rigWarmupDrainedReceiptSignatureBase64: firstAcceptanceSignature,
				};
			}
			return reply;
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("finishWarmup");
		expect((walked.result as { code: string }).code).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);
	});

	it("refuses_the_same_signed_record_presented_twice_on_one_channel", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		let firstAcceptance: Record<string, unknown> | null = null;
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (reply === "silence") return reply;
			if (reply.schema === "rig-cohort-accepted-ack/v1") {
				if (firstAcceptance === null) firstAcceptance = reply;
			}
			return reply;
		});
		const channel = channelFor(wire, keys.publicRaw32);
		const executionAccepted = await acceptExecutionOn(channel);
		expect(executionAccepted.ok).toBe(true);
		const first = await channel.acceptCohort({
			cohortGrantBytes: MAC_COHORT_GRANT_BYTES,
			cohortGrantSignatureBytes: MAC_COHORT_GRANT_SIGNATURE_BYTES,
		});
		expect(first.ok).toBe(true);
		const second = await channel.acceptCohort({
			cohortGrantBytes: MAC_COHORT_GRANT_BYTES,
			cohortGrantSignatureBytes: MAC_COHORT_GRANT_SIGNATURE_BYTES,
		});
		expect(second.ok).toBe(false);
		if (second.ok) return;
		// The stage guard fires before the wire does: a second accept is not a
		// replay to be detected downstream, it is not a legal request at all.
		expect(second.code).toBe("COHORT_NOT_READY");
	});

	it("refuses_an_ack_whose_response_sequence_does_not_echo_the_request", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (reply === "silence") return reply;
			if (reply.schema === "rig-warmup-ready-ack/v1") {
				return { ...reply, ackRequestSeq: 0, responseSeq: 0 };
			}
			return reply;
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("beginWarmup");
		expect((walked.result as { code: string }).code).toBe("TRUST_PROTOCOL");
	});

	it("refuses_an_ack_of_the_wrong_kind", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			if (request.schema === "rig-begin-warmup-request/v1") {
				return {
					schema: "rig-server-ready-ack/v1",
					responseSeq: 2,
					ackRequestSeq: request.requestSeq as number,
					executionSha256: RIG_EXECUTION_SHA256,
					childPid: 1,
					childPgid: 1,
					childInstanceNonce: RIG_HEX("d"),
					serverReadyFrameSha256: RIG_HEX("e"),
				};
			}
			return honest(request);
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("beginWarmup");
		expect((walked.result as { message: string }).message).toContain(
			"expected rig-warmup-ready-ack/v1",
		);
	});

	it("refuses_an_ack_that_names_another_execution", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (reply === "silence") return reply;
			if (reply.schema === "rig-server-ready-ack/v1") {
				return { ...reply, executionSha256: RIG_HEX("9") };
			}
			return reply;
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("spawnServer");
		expect((walked.result as { code: string }).code).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);
	});

	it("refuses_an_acceptance_bound_to_a_grant_this_channel_did_not_send", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (
				reply !== "silence" &&
				reply.schema === "rig-cohort-accepted-ack/v1"
			) {
				return { ...reply, cohortGrantSha256: RIG_HEX("8") };
			}
			return reply;
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("acceptCohort");
		expect((walked.result as { code: string }).code).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);
	});

	it("refuses_an_acceptance_joined_to_another_grant_or_grant_signature", async () => {
		for (const field of [
			"executionSha256",
			"cohortGrantSha256",
			"cohortGrantSignatureSha256",
		] as const) {
			const keys = generateEd25519KeyPair();
			const honest = honestRig(keys);
			const wire = serveScriptedRig((request) => {
				const reply = honest(request);
				if (
					reply === "silence" ||
					reply.schema !== "rig-cohort-accepted-ack/v1"
				) {
					return reply;
				}
				// A genuinely rig-signed acceptance -- of a different grant. Only
				// the join to the bytes this channel sent catches it.
				const record = JSON.parse(
					Buffer.from(
						reply.rigCohortAcceptanceBase64 as string,
						"base64",
					).toString("utf8"),
				);
				record[field] = RIG_HEX("0");
				const bytes = bytesOfCanonical(record);
				return {
					...reply,
					rigCohortAcceptanceBase64: b64(bytes),
					rigCohortAcceptanceSignatureBase64: b64(
						bytesOfCanonical(
							signRigReceipt({
								privatePkcs8Der: keys.privatePkcs8Der,
								publicRaw32: keys.publicRaw32,
								signedSchema: "rig-cohort-acceptance/v1",
								signedBytes: bytes,
							}),
						),
					),
				};
			});
			const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
			expect(walked.at).toBe("acceptCohort");
			expect((walked.result as { code: string }).code).toBe(
				"CROSS_SUPERVISOR_MISMATCH",
			);
		}
	});

	it("refuses_a_warmup_receipt_joined_to_records_this_channel_did_not_send", async () => {
		for (const field of [
			"cohortGrantSha256",
			"serverWarmupDrainedSha256",
			"cohortWarmupEpochSha256",
			"cohortWarmupEpochSignatureSha256",
			"roleWarmupCompletionManifestSha256",
			"roleWarmupCompletionManifestSignatureSha256",
		] as const) {
			const keys = generateEd25519KeyPair();
			const honest = honestRig(keys);
			const wire = serveScriptedRig((request) => {
				const reply = honest(request);
				if (
					reply === "silence" ||
					reply.schema !== "rig-warmup-drained-ack/v1"
				) {
					return reply;
				}
				const record = JSON.parse(
					Buffer.from(
						reply.rigWarmupDrainedReceiptBase64 as string,
						"base64",
					).toString("utf8"),
				);
				record[field] = RIG_HEX("0");
				const bytes = bytesOfCanonical(record);
				return {
					...reply,
					rigWarmupDrainedReceiptBase64: b64(bytes),
					rigWarmupDrainedReceiptSignatureBase64: b64(
						bytesOfCanonical(
							signRigReceipt({
								privatePkcs8Der: keys.privatePkcs8Der,
								publicRaw32: keys.publicRaw32,
								signedSchema: "rig-warmup-drained-receipt/v1",
								signedBytes: bytes,
							}),
						),
					),
				};
			});
			const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
			expect(walked.at).toBe("finishWarmup");
			expect((walked.result as { code: string }).code).toBe(
				"CROSS_SUPERVISOR_MISMATCH",
			);
		}
	});

	it("refuses_an_ack_whose_declared_digest_or_size_is_not_the_frame_it_carried", async () => {
		for (const patch of [
			{ serverWarmupDrainedSha256: RIG_HEX("0") },
			{ serverWarmupDrainedSize: 9_999 },
		]) {
			const keys = generateEd25519KeyPair();
			const honest = honestRig(keys);
			const wire = serveScriptedRig((request) => {
				const reply = honest(request);
				if (
					reply === "silence" ||
					reply.schema !== "rig-warmup-drained-ack/v1"
				) {
					return reply;
				}
				return { ...reply, ...patch };
			});
			const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
			expect(walked.at).toBe("finishWarmup");
			expect((walked.result as { message: string }).message).toContain(
				"is not the frame it carried",
			);
		}
	});

	it("refuses_a_measure_start_ack_naming_another_drained_receipt", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			if (request.schema === "rig-measure-start-request/v1") {
				return honest({
					...request,
					rigWarmupDrainedReceiptSha256: RIG_HEX("0"),
				});
			}
			return honest(request);
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("measureStart");
		expect((walked.result as { code: string }).code).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);
	});

	it("refuses_a_barrier_acceptance_naming_another_measure_start_ack", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (
				reply !== "silence" &&
				reply.schema === "rig-barrier-accepted-ack/v1"
			) {
				const record = JSON.parse(
					Buffer.from(
						reply.rigBarrierAcceptanceBase64 as string,
						"base64",
					).toString("utf8"),
				);
				record.rigMeasureStartAckSha256 = RIG_HEX("0");
				const bytes = bytesOfCanonical(record);
				return {
					...reply,
					rigBarrierAcceptanceBase64: b64(bytes),
					rigBarrierAcceptanceSignatureBase64: b64(
						bytesOfCanonical(
							signRigReceipt({
								privatePkcs8Der: keys.privatePkcs8Der,
								publicRaw32: keys.publicRaw32,
								signedSchema: "rig-barrier-acceptance/v1",
								signedBytes: bytes,
							}),
						),
					),
				};
			}
			return reply;
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("presentStartBarrier");
		expect((walked.result as { code: string }).code).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);
	});

	it("refuses_a_barrier_ack_whose_declared_digest_or_size_is_not_its_frame", async () => {
		for (const patch of [
			{ serverStartBarrierAcceptedSha256: RIG_HEX("0") },
			{ serverStartBarrierAcceptedSize: 9_999 },
		]) {
			const keys = generateEd25519KeyPair();
			const honest = honestRig(keys);
			const wire = serveScriptedRig((request) => {
				const reply = honest(request);
				if (
					reply === "silence" ||
					reply.schema !== "rig-barrier-accepted-ack/v1"
				) {
					return reply;
				}
				return { ...reply, ...patch };
			});
			const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
			expect(walked.at).toBe("presentStartBarrier");
			expect((walked.result as { message: string }).message).toContain(
				"is not the frame it carried",
			);
		}
	});

	it("refuses_a_barrier_acceptance_joined_to_records_this_channel_did_not_send", async () => {
		for (const field of [
			"serverStartBarrierAcceptedSha256",
			"cohortStartBarrierSha256",
			"cohortStartBarrierSignatureSha256",
			"cohortGrantSha256",
		]) {
			const keys = generateEd25519KeyPair();
			const honest = honestRig(keys);
			const wire = serveScriptedRig((request) => {
				const reply = honest(request);
				if (
					reply === "silence" ||
					reply.schema !== "rig-barrier-accepted-ack/v1"
				) {
					return reply;
				}
				return {
					...reply,
					...resignBarrierAcceptance(keys, reply, { [field]: RIG_HEX("0") }),
				};
			});
			const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
			expect(walked.at).toBe("presentStartBarrier");
			expect((walked.result as { code: string }).code).toBe(
				"CROSS_SUPERVISOR_MISMATCH",
			);
		}
	});

	it("refuses_a_relay_receipt_joined_to_another_execution_cohort_or_barrier", async () => {
		for (const field of [
			"executionSha256",
			"cohortGrantSha256",
			"cohortStartBarrierSha256",
		]) {
			const keys = generateEd25519KeyPair();
			const honest = honestRig(keys);
			const wire = serveScriptedRig((request) => {
				const reply = honest(request);
				if (
					reply === "silence" ||
					reply.schema !== "rig-capture-complete-ack/v1"
				) {
					return reply;
				}
				const record = JSON.parse(
					Buffer.from(
						reply.rigRelayObservationReceiptBase64 as string,
						"base64",
					).toString("utf8"),
				);
				record[field] = RIG_HEX("0");
				const bytes = bytesOfCanonical(record);
				return {
					...reply,
					rigRelayObservationReceiptBase64: b64(bytes),
					rigRelayObservationReceiptSignatureBase64: b64(
						bytesOfCanonical(
							signRigReceipt({
								privatePkcs8Der: keys.privatePkcs8Der,
								publicRaw32: keys.publicRaw32,
								signedSchema: "rig-relay-observation-receipt/v1",
								signedBytes: bytes,
							}),
						),
					),
				};
			});
			const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
			expect(walked.at).toBe("stopAndCapture");
			expect((walked.result as { code: string }).code).toBe(
				"CROSS_SUPERVISOR_MISMATCH",
			);
		}
	});

	it("refuses_an_oversize_measure_start_ack_or_relay_observation", async () => {
		for (const slot of [
			{
				ackSchema: "rig-measure-started-ack/v1",
				field: "rigMeasureStartAckBase64",
				at: "measureStart",
				pad: 40_000,
				expected: "rig measure-start ack exceeds its cap",
			},
			{
				ackSchema: "rig-capture-complete-ack/v1",
				field: "linuxRelayObservationBase64",
				at: "stopAndCapture",
				pad: 200_000,
				expected: "linux relay observation exceeds its cap",
			},
		] as const) {
			const keys = generateEd25519KeyPair();
			const honest = honestRig(keys);
			const wire = serveScriptedRig((request) => {
				const reply = honest(request);
				if (reply === "silence" || reply.schema !== slot.ackSchema) {
					return reply;
				}
				const record = JSON.parse(
					Buffer.from(reply[slot.field] as string, "base64").toString("utf8"),
				);
				record.padding = "p".repeat(slot.pad);
				return { ...reply, [slot.field]: b64(bytesOfCanonical(record)) };
			});
			const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
			expect(walked.at).toBe(slot.at);
			expect((walked.result as { message: string }).message).toContain(
				slot.expected,
			);
		}
	});

	it("refuses_a_carried_record_that_is_not_the_schema_its_slot_expects", async () => {
		for (const slot of [
			{
				ackSchema: "rig-measure-started-ack/v1",
				field: "rigMeasureStartAckBase64",
				signedSchema: "rig-measure-start-ack/v1",
				at: "measureStart",
			},
			{
				ackSchema: "rig-capture-complete-ack/v1",
				field: "rigServerSnapshotReceiptBase64",
				signedSchema: "rig-server-snapshot-receipt/v1",
				at: "stopAndCapture",
			},
		] as const) {
			const keys = generateEd25519KeyPair();
			const honest = honestRig(keys);
			const wire = serveScriptedRig((request) => {
				const reply = honest(request);
				if (reply === "silence" || reply.schema !== slot.ackSchema) {
					return reply;
				}
				const record = JSON.parse(
					Buffer.from(reply[slot.field] as string, "base64").toString("utf8"),
				);
				record.schema = "some-other-record/v1";
				const bytes = bytesOfCanonical(record);
				return {
					...reply,
					[slot.field]: b64(bytes),
					[`${slot.field.slice(0, -6)}SignatureBase64`]: b64(
						bytesOfCanonical(
							signRigReceipt({
								privatePkcs8Der: keys.privatePkcs8Der,
								publicRaw32: keys.publicRaw32,
								signedSchema: slot.signedSchema,
								signedBytes: bytes,
							}),
						),
					),
				};
			});
			const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
			expect(walked.at).toBe(slot.at);
			expect((walked.result as { message: string }).message).toContain(
				"carried record is not",
			);
		}
	});

	it("refuses_a_carried_record_that_names_another_execution", async () => {
		for (const slot of [
			{
				ackSchema: "rig-measure-started-ack/v1",
				field: "rigMeasureStartAckBase64",
				signatureField: "rigMeasureStartAckSignatureBase64",
				signedSchema: "rig-measure-start-ack/v1",
				at: "measureStart",
			},
			{
				ackSchema: "rig-capture-complete-ack/v1",
				field: "rigServerSnapshotReceiptBase64",
				signatureField: "rigServerSnapshotReceiptSignatureBase64",
				signedSchema: "rig-server-snapshot-receipt/v1",
				at: "stopAndCapture",
			},
		] as const) {
			const keys = generateEd25519KeyPair();
			const honest = honestRig(keys);
			const wire = serveScriptedRig((request) => {
				const reply = honest(request);
				if (reply === "silence" || reply.schema !== slot.ackSchema) {
					return reply;
				}
				const record = JSON.parse(
					Buffer.from(reply[slot.field] as string, "base64").toString("utf8"),
				);
				record.executionSha256 = RIG_HEX("9");
				const bytes = bytesOfCanonical(record);
				return {
					...reply,
					[slot.field]: b64(bytes),
					[slot.signatureField]: b64(
						bytesOfCanonical(
							signRigReceipt({
								privatePkcs8Der: keys.privatePkcs8Der,
								publicRaw32: keys.publicRaw32,
								signedSchema: slot.signedSchema,
								signedBytes: bytes,
							}),
						),
					),
				};
			});
			const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
			expect(walked.at).toBe(slot.at);
			expect((walked.result as { code: string }).code).toBe(
				"CROSS_SUPERVISOR_MISMATCH",
			);
		}
	});

	it("refuses_a_relay_receipt_that_does_not_cover_the_observation_it_came_with", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (
				reply === "silence" ||
				reply.schema !== "rig-capture-complete-ack/v1"
			) {
				return reply;
			}
			const record = JSON.parse(
				Buffer.from(
					reply.rigRelayObservationReceiptBase64 as string,
					"base64",
				).toString("utf8"),
			);
			record.linuxRelayObservationSha256 = RIG_HEX("0");
			const bytes = bytesOfCanonical(record);
			return {
				...reply,
				rigRelayObservationReceiptBase64: b64(bytes),
				rigRelayObservationReceiptSignatureBase64: b64(
					bytesOfCanonical(
						signRigReceipt({
							privatePkcs8Der: keys.privatePkcs8Der,
							publicRaw32: keys.publicRaw32,
							signedSchema: "rig-relay-observation-receipt/v1",
							signedBytes: bytes,
						}),
					),
				),
			};
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("stopAndCapture");
		expect((walked.result as { message: string }).message).toContain(
			"does not cover the observation",
		);
	});

	it("refuses_a_half_present_relay_observation_triple", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (
				reply !== "silence" &&
				reply.schema === "rig-capture-complete-ack/v1"
			) {
				return { ...reply, rigRelayObservationReceiptSignatureBase64: null };
			}
			return reply;
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("stopAndCapture");
		expect((walked.result as { message: string }).message).toContain(
			"wholly present nor wholly absent",
		);
	});

	it("refuses_a_lifecycle_step_taken_out_of_order", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(keys));
		const channel = channelFor(wire, keys.publicRaw32);
		const early = await channel.spawnServer(SPAWN_REQUEST);
		expect(early.ok).toBe(false);
		if (early.ok) return;
		expect(early.code).toBe("COHORT_NOT_READY");
		expect(wire.seen).toHaveLength(0);
	});

	it("refuses_a_spawn_naming_a_grant_this_channel_did_not_deliver", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(keys));
		const channel = channelFor(wire, keys.publicRaw32);
		const executionAccepted = await acceptExecutionOn(channel);
		expect(executionAccepted.ok).toBe(true);
		const accepted = await channel.acceptCohort({
			cohortGrantBytes: MAC_COHORT_GRANT_BYTES,
			cohortGrantSignatureBytes: MAC_COHORT_GRANT_SIGNATURE_BYTES,
		});
		expect(accepted.ok).toBe(true);
		const spawned = await channel.spawnServer({
			...SPAWN_REQUEST,
			cohortGrantSha256: RIG_HEX("7"),
		});
		expect(spawned.ok).toBe(false);
		if (spawned.ok) return;
		expect(spawned.code).toBe("CROSS_SUPERVISOR_MISMATCH");
		expect(wire.seen).toHaveLength(2);
	});

	it("surfaces_a_typed_remote_refusal_instead_of_a_frame_error", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig((request) => ({
			schema: "remote-supervisor-refusal/v1",
			responseSeq: 0,
			ackRequestSeq: request.requestSeq as number,
			executionSha256: RIG_EXECUTION_SHA256,
			code: "TRUST_PROTOCOL",
			campaignStatus: "FAIL",
			terminal: true,
		}));
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("acceptExecution");
		expect((walked.result as { code: string }).code).toBe("TRUST_PROTOCOL");
		expect((walked.result as { message: string }).message).toContain(
			"rig refused rig-accept-execution-request/v1",
		);
	});

	// B3.5 residual 2. The rig speaks two refusal vocabularies, and only one of
	// them was understood. A refused *transition* answers in the frozen
	// `remote-supervisor-refusal/v1` shape (the test above); a protocol
	// violation goes out through the binary's `terminate`, which writes the
	// Phase-A `admission-refusal` frame carrying `measurement-refusal/v1`. That
	// kind is not a registered remote kind, so the channel handed it to
	// `decodeRegisteredRemotePayload` and reported "unregistered remote kind"
	// over the top of whatever the rig was trying to say.
	function serveRawRefusal(code: string): RigWire {
		const controllerToRig = new PassThrough();
		const rigToController = new PassThrough();
		const seen: Record<string, unknown>[] = [];
		controllerToRig.on("data", () => {
			const framed = encodeSupervisorFrame(
				new TextEncoder().encode(
					`${JSON.stringify({
						kind: "admission-refusal",
						schema: "comparison-supervisor-frame/v1",
					})}\n`,
				),
				new TextEncoder().encode(
					`{"code":"${code}","schema":"measurement-refusal/v1"}\n`,
				),
				65_536,
			);
			if (!framed.ok) throw new Error("the refusal frame did not encode");
			rigToController.write(Buffer.from(framed.value));
		});
		return { controllerToRig, rigToController, seen };
	}

	it("reports_the_rigs_own_code_out_of_the_phase_a_refusal_shape", async () => {
		const keys = generateEd25519KeyPair();
		const channel = channelFor(
			serveRawRefusal("COHORT_NOT_READY"),
			keys.publicRaw32,
		);
		const accepted = await acceptExecutionOn(channel);
		expect(accepted.ok).toBe(false);
		if (accepted.ok) return;
		expect(accepted.code).toBe("COHORT_NOT_READY");
		expect(accepted.message).toContain(
			"rig refused rig-accept-execution-request/v1 with COHORT_NOT_READY",
		);
		// The failure this replaces: a decode complaint about the frame kind.
		expect(accepted.message).not.toContain("unregistered remote kind");
	});

	it("maps_the_supervisors_own_trust_record_codes_onto_the_section_7_set", async () => {
		// The `TRUST_RECORD_*` / `TRUST_CHILD_*` family is the supervisor's own
		// and §7 does not publish it. §7's row for "malformed, unknown-key,
		// oversize, sequence, EOF, digest, cross-run/transport/cohort protocol"
		// is `FAIL/TRUST_PROTOCOL`, so that is where they land -- with the rig's
		// exact literal kept in the message, which is the part an operator needs.
		const keys = generateEd25519KeyPair();
		const channel = channelFor(
			serveRawRefusal("TRUST_CHILD_FRAME_INVALID"),
			keys.publicRaw32,
		);
		const accepted = await acceptExecutionOn(channel);
		expect(accepted.ok).toBe(false);
		if (accepted.ok) return;
		expect(accepted.code).toBe("TRUST_PROTOCOL");
		expect(accepted.message).toContain("TRUST_CHILD_FRAME_INVALID");
	});

	it("every_code_the_rig_can_emit_maps_into_the_closed_section_7_set", () => {
		for (const code of [
			"TRUST_RECORD_MALFORMED",
			"TRUST_RECORD_DUPLICATE_FIELD",
			"TRUST_RECORD_UNKNOWN_FIELD",
			"TRUST_RECORD_MISSING_FIELD",
			"TRUST_RECORD_SCHEMA_INVALID",
			"TRUST_RECORD_BINDING_MISMATCH",
			"TRUST_CHILD_FRAME_INVALID",
			"FRAME_SESSION_LIMIT",
		]) {
			expect(mapRigRefusalCodeToIndexCode(code)).toBe("TRUST_PROTOCOL");
		}
		// The codes `CohortRefusal::code` already publishes as §7 literals pass
		// through unchanged rather than being flattened onto TRUST_PROTOCOL.
		for (const code of [
			"COHORT_NOT_READY",
			"COHORT_PROTOCOL",
			"WARMUP_PROTOCOL",
			"MEASUREMENT_WINDOW",
			"RELAY_DELIVERY",
			"CHILD_LIFECYCLE",
			"MAC_GRANT_SIGNATURE_INVALID",
			"MAC_SIGNING_KEY_MISMATCH",
		] as const) {
			expect(mapRigRefusalCodeToIndexCode(code)).toBe(code);
		}
	});

	it("refuses_eof_before_the_ack_rather_than_waiting_out_the_deadline", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig(() => "silence");
		const channel = channelFor(wire, keys.publicRaw32);
		const started = Date.now();
		const accepted = await acceptExecutionOn(channel);
		expect(accepted.ok).toBe(false);
		expect(Date.now() - started).toBeLessThan(RIG_DEADLINES.frameMs);
		if (accepted.ok) return;
		expect(accepted.code).toBe("COHORT_PROTOCOL");
	});

	it("rejects_a_staged_launch_record_over_the_64KiB_spawn_cap", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(keys));
		const channel = channelFor(wire, keys.publicRaw32);
		const executionAccepted = await acceptExecutionOn(channel);
		expect(executionAccepted.ok).toBe(true);
		const accepted = await channel.acceptCohort({
			cohortGrantBytes: MAC_COHORT_GRANT_BYTES,
			cohortGrantSignatureBytes: MAC_COHORT_GRANT_SIGNATURE_BYTES,
		});
		expect(accepted.ok).toBe(true);
		const spawned = await channel.spawnServer({
			...SPAWN_REQUEST,
			stagedServerLaunchRecordBytes: new Uint8Array(65_537),
		});
		expect(spawned.ok).toBe(false);
		if (spawned.ok) return;
		expect(spawned.message).toContain("64 KiB spawn cap");
	});

	it("refuses_a_non_canonically_encoded_carried_record", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (
				reply !== "silence" &&
				reply.schema === "rig-cohort-accepted-ack/v1"
			) {
				const record = JSON.parse(
					Buffer.from(
						reply.rigCohortAcceptanceBase64 as string,
						"base64",
					).toString("utf8"),
				);
				// Same record, keys out of canonical order: the digest the Mac would
				// sign is not the digest of any canonical encoding of it.
				const reordered = Object.fromEntries(Object.entries(record).reverse());
				return {
					...reply,
					rigCohortAcceptanceBase64: b64(
						new TextEncoder().encode(JSON.stringify(reordered)),
					),
				};
			}
			return reply;
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("acceptCohort");
		expect((walked.result as { message: string }).message).toContain(
			"canonically encoded",
		);
	});
});

// ---------------------------------------------------------------------------
// C4: the controller <-> Mac cohort channel
//
// The Mac supervisor is a process that alone holds the Mac key. These tests
// drive `MacCohortChannel` against a scripted Mac peer that speaks the
// registered frames byte-for-byte and signs with a test key, so every refusal
// below is one the wire would actually produce, and every acceptance is of
// bytes the channel verified under the staged key it was given.
// ---------------------------------------------------------------------------

const MAC_STAGED_RIG = generateEd25519KeyPair();
const MAC_WORKLOAD_BYTES = bytesOfCanonical({ plan: "channel-test" });

function macDraftBytes(): Uint8Array {
	return bytesOfCanonical({
		schema: "cross-supervisor-execution-draft/v1",
		authoritySha256: RIG_HEX("a"),
		campaignLockSha256: RIG_HEX("b"),
		stagedCapabilitySha256: RIG_HEX("c"),
		sourceArchiveSha256: RIG_HEX("d"),
		approvedPlanSha256: RIG_HEX("e"),
		approvalRecordSha256: RIG_HEX("f"),
		candidate: "cand",
		campaignId: "camp",
		runId: "camp/ticker-fanout/ws/measured-1",
		executionPurpose: "focused",
		cellId: "ticker-fanout/rate-10000",
		scenarioHash: RIG_HEX("5"),
		rolePlanHash: RIG_HEX("6"),
		workloadRolePlanInputSha256: sha256HexOfBytes(MAC_WORKLOAD_BYTES),
		stagedServerLaunchRecordSha256: RIG_HEX("7"),
		armKind: "primary",
		transport: "ws",
		repetitionKind: "measured",
		repetitionIndex: 1,
		repetitionTotal: 1,
		grantDeclaration: "fanout-expanded-deliveries",
		declaredMessageCount: 10_000_000,
		declaredMessageBytes: 100,
		requestedNotAfterMs: 17_000_000_000_000,
	});
}

function scriptedMac(options: Partial<ScriptedMacBinaryOptions> = {}): {
	binary: ScriptedMacCohortBinary;
	keys: ReturnType<typeof generateEd25519KeyPair>;
} {
	const keys = options.keys ?? generateEd25519KeyPair();
	const binary = new ScriptedMacCohortBinary({
		keys,
		stagedRigPublicRaw32: MAC_STAGED_RIG.publicRaw32,
		clock: { nowMs: () => 1_000, nowNs: () => "1000000000" },
		receiptValidityMs: 60_000,
		macClockId: "mac-clock-test",
		instanceNonce: RIG_HEX("7"),
		executableSha256: RIG_HEX("b"),
		grant: {
			transport: "ws",
			readinessDeadlineMs: 30_000,
			measuredDurationMs: 10_000,
			messageBytes: 100,
			expectedOfferedIngress: 10,
		},
		...options,
	});
	return { binary, keys };
}

function macChannelFor(
	wire: MacWire,
	stagedMacPublicRaw32: Uint8Array,
	budget?: CohortEvidenceBudget,
): MacCohortChannel {
	return new MacCohortChannel({
		controllerToMac: wire.controllerToMac,
		macToController: wire.macToController,
		stagedMacPublicRaw32,
		deadlineMs: 2_000,
		budget,
	});
}

/** The C1 open-cohort request for a tiny ticker cohort, from the real builder. */
function macOpenCohortRequest(executionSha256: string) {
	const tokens = buildFanoutCohortFixture({
		cohortId: "cohort-channel-test",
		publisherCount: 1,
		subscriberCount: 8,
	});
	const leafManifest = bytesOfCanonical({
		schema: "token-commitment-leaf-manifest/v1",
		executionSha256,
		cohortId: "cohort-channel-test",
		leafCount: tokens.leaves.length,
		leaves: [...tokens.leaves],
		roleTokenCommitmentRootSha256: tokens.roleTokenCommitmentRootSha256,
	});
	const workload = MAC_WORKLOAD_BYTES;
	return {
		schema: "mac-open-cohort-request/v1",
		executionSha256,
		scenarioHash: RIG_HEX("5"),
		rolePlanHash: RIG_HEX("6"),
		workloadRolePlanInputBase64: b64(workload),
		workloadRolePlanInputSha256: sha256HexOfBytes(workload),
		workloadRolePlanInputSize: workload.byteLength,
		tokenCommitmentLeafManifestBase64: b64(leafManifest),
		tokenCommitmentLeafManifestSha256: sha256HexOfBytes(leafManifest),
		publishersBase64: b64(bytesOfCanonical(tokens.publishers)),
		subscriberShardsBase64: b64(bytesOfCanonical(tokens.subscriberShards)),
	};
}

describe("remote-supervisor: MacCohortChannel", () => {
	it("opens_the_execution_and_the_cohort_against_a_scripted_mac_with_exact_bytes", async () => {
		const { binary, keys } = scriptedMac();
		const wire = serveScriptedMac(binary.respond);
		const channel = macChannelFor(wire, keys.publicRaw32);
		expect(channel.openedExecution).toBeNull();

		const opened = await channel.openExecution(macDraftBytes());
		expect(opened.ok).toBe(true);
		if (!opened.ok) throw new Error(`${opened.code} ${opened.message}`);
		// The receipt the binary signed names the draft, the grant and the
		// execution this channel now speaks for; nothing here was restated.
		expect(opened.value.receipt.execution.draftSha256).toBe(
			sha256HexOfBytes(macDraftBytes()),
		);
		expect(opened.value.receipt.measurementGrantSha256).toBe(
			opened.value.measurementGrantSha256,
		);
		expect(channel.executionSha256).toBe(opened.value.executionSha256);
		expect(channel.budget.openExecutionSha256).toBe(
			opened.value.executionSha256,
		);
		// The ack payload bytes are the binary's own canonical bytes, retained.
		expect(sha256HexOfBytes(opened.value.ackPayloadBytes)).toBe(
			sha256HexOfBytes(bytesOfCanonical(opened.value.ack)),
		);

		const request = macOpenCohortRequest(opened.value.executionSha256);
		const answered = await channel.request<MacCohortOpenedAckV1>(
			request,
			"mac-cohort-opened-ack/v1",
		);
		expect(answered.ok).toBe(true);
		if (!answered.ok) throw new Error(`${answered.code} ${answered.message}`);
		const signed = channel.signedRecord(
			answered.value.ack.cohortGrantBase64,
			answered.value.ack.cohortGrantSignatureBase64,
			"cohort-grant/v1",
		);
		expect(signed.ok).toBe(true);
		if (!signed.ok) throw new Error(signed.code);
		expect(sha256HexOfBytes(signed.value.bytes)).toBe(
			answered.value.ack.cohortGrantSha256,
		);
		// The grant is the binary's mint over what was presented: the manifest
		// digest it commits to is the one this request carried.
		const grant = JSON.parse(
			Buffer.from(signed.value.bytes).toString("utf8"),
		) as { tokenCommitmentLeafManifestSha256: string; cohortAttempt: number };
		expect(grant.tokenCommitmentLeafManifestSha256).toBe(
			request.tokenCommitmentLeafManifestSha256,
		);
		expect(grant.cohortAttempt).toBe(1);
		// Sequence: two requests, two acks, both correlated.
		expect(wire.seen.map((seen) => seen.requestSeq)).toEqual([0, 1]);
		expect(answered.value.ack.ackRequestSeq).toBe(1);
		expect(answered.value.ack.responseSeq).toBe(1);
		// And the budget charged exactly the four bulk fields of the open.
		expect(channel.budget.chargedBytes).toBe(
			[
				request.workloadRolePlanInputBase64,
				request.tokenCommitmentLeafManifestBase64,
				request.publishersBase64,
				request.subscriberShardsBase64,
			].reduce(
				(total, field) => total + Buffer.from(field, "base64").byteLength,
				0,
			),
		);
		expect(channel.isTerminal).toBe(false);
	});

	it("refuses_a_grant_the_staged_key_does_not_verify_and_is_terminal_after", async () => {
		// Same binary, same honest bytes; the controller was staged with some
		// other key. The execution receipt already fails, before any cohort.
		const { binary } = scriptedMac();
		const foreign = generateEd25519KeyPair();
		const wire = serveScriptedMac(binary.respond);
		const channel = macChannelFor(wire, foreign.publicRaw32);
		const opened = await channel.openExecution(macDraftBytes());
		expect(opened.ok).toBe(false);
		if (opened.ok) throw new Error("unreachable");
		expect(opened.code).toBe("MAC_SIGNING_KEY_MISMATCH");
		expect(channel.isTerminal).toBe(true);
		expect(channel.openedExecution).toBeNull();
		const again = await channel.openExecution(macDraftBytes());
		expect(again.ok).toBe(false);
		expect(wire.seen.length).toBe(1);
	});

	it("refuses_an_ack_whose_sequence_is_not_the_answer_to_its_request", async () => {
		const { binary, keys } = scriptedMac({
			mutate: (schema, payload) =>
				schema === "mac-execution-opened-ack/v1"
					? { ...payload, ackRequestSeq: 7 }
					: payload,
		});
		const wire = serveScriptedMac(binary.respond);
		const channel = macChannelFor(wire, keys.publicRaw32);
		const opened = await channel.openExecution(macDraftBytes());
		expect(opened.ok).toBe(false);
		if (opened.ok) throw new Error("unreachable");
		expect(opened.code).toBe("TRUST_PROTOCOL");
		expect(channel.isTerminal).toBe(true);
	});

	it("carries_the_binarys_closed_refusal_code_and_stops", async () => {
		const { binary, keys } = scriptedMac();
		const wire = serveScriptedMac(binary.respond);
		const channel = macChannelFor(wire, keys.publicRaw32);
		const opened = await channel.openExecution(macDraftBytes());
		expect(opened.ok).toBe(true);
		if (!opened.ok) throw new Error("unreachable");
		// A cohort request naming an execution the binary never opened is
		// refused by the binary with its own code, and the channel carries it.
		const request = macOpenCohortRequest(opened.value.executionSha256);
		const foreignExecution = await channel.request<MacCohortOpenedAckV1>(
			{ ...request, executionSha256: RIG_HEX("9") },
			"mac-cohort-opened-ack/v1",
		);
		expect(foreignExecution.ok).toBe(false);
		if (foreignExecution.ok) throw new Error("unreachable");
		expect(foreignExecution.code).toBe("CROSS_SUPERVISOR_MISMATCH");
		expect(channel.isTerminal).toBe(true);
	});

	it("charges_the_execution_budget_before_encoding_and_refuses_at_cap_plus_one", async () => {
		const { binary, keys } = scriptedMac();
		const wire = serveScriptedMac(binary.respond);
		// A budget far smaller than the open-cohort request's four bulk fields.
		const channel = macChannelFor(
			wire,
			keys.publicRaw32,
			new CohortEvidenceBudget(64),
		);
		const opened = await channel.openExecution(macDraftBytes());
		expect(opened.ok).toBe(true);
		if (!opened.ok) throw new Error("unreachable");
		// The open-execution frame has no debit fields: nothing was charged.
		expect(channel.budget.chargedBytes).toBe(0);
		const request = macOpenCohortRequest(opened.value.executionSha256);
		const refused = await channel.request<MacCohortOpenedAckV1>(
			request,
			"mac-cohort-opened-ack/v1",
		);
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("unreachable");
		expect(refused.code).toBe("RUNTIME_RESOURCE_EXHAUSTION");
		// Refused before the encode: the binary never saw the frame.
		expect(wire.seen.map((seen) => seen.schema)).toEqual([
			"mac-open-execution-request/v1",
		]);
		expect(channel.budget.chargedBytes).toBe(0);
	});

	it("refuses_an_oversize_role_child_bundle_before_it_reaches_the_wire", async () => {
		const { binary, keys } = scriptedMac();
		const wire = serveScriptedMac(binary.respond);
		const channel = macChannelFor(wire, keys.publicRaw32);
		const opened = await channel.openExecution(macDraftBytes());
		expect(opened.ok).toBe(true);
		const oversize = await channel.exportCohortEvidence({
			cohortAdmissionReceiptSha256: RIG_HEX("1"),
			roleChildEvidenceBundleBytes: new Uint8Array(9 * 1024 * 1024 + 1),
		});
		expect(oversize.ok).toBe(false);
		if (oversize.ok) throw new Error("unreachable");
		expect(oversize.code).toBe("RUNTIME_RESOURCE_EXHAUSTION");
		expect(wire.seen.length).toBe(1);
		// Not terminal: nothing was written, the channel is still usable.
		expect(channel.isTerminal).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// C4: production never signs and never reaches a fixture signer
// ---------------------------------------------------------------------------

/** Every non-test TypeScript module under tools/compare, recursively. */
function productionModulesUnderCompare(): string[] {
	const root = join(import.meta.dir);
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules") continue;
				walk(path);
				continue;
			}
			if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts"))
				continue;
			found.push(path);
		}
	};
	walk(root);
	return found.sort();
}

describe("remote-supervisor: the controller holds no Mac key", () => {
	it("no_production_module_imports_the_fixture_signing_module", () => {
		const offenders: string[] = [];
		for (const path of productionModulesUnderCompare()) {
			if (path.endsWith("/cohort-fixture-signing.ts")) continue;
			const source = readFileSync(path, "utf8");
			if (/from\s+["'][^"']*cohort-fixture-signing\.ts["']/u.test(source)) {
				offenders.push(relative(import.meta.dir, path));
			}
		}
		expect(offenders).toEqual([]);
	});

	it("no_typescript_production_path_constructs_a_cohort_grant", () => {
		// Design §2.9(2g), grep level. The one permitted occurrence class is a
		// parser's comparison; a constructed literal is the second encoder.
		const offenders: string[] = [];
		for (const path of productionModulesUnderCompare()) {
			if (path.endsWith("/cohort-fixture-signing.ts")) continue;
			const source = readFileSync(path, "utf8");
			for (const [index, line] of source.split("\n").entries()) {
				// A type declaration names the schema as a literal type, not a
				// constructed value; the parser compares against it. Neither is
				// an encoder. A constructed literal is `schema: "cohort-grant/v1"`
				// on a value, and that is what this refuses.
				if (
					/schema:\s*"cohort-grant\/v1"/u.test(line) &&
					!/readonly\s+schema:/u.test(line)
				) {
					offenders.push(`${relative(import.meta.dir, path)}:${index + 1}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("the_mac_supervisor_has_no_private_key_and_no_signing_call", () => {
		const source = readFileSync(
			join(import.meta.dir, "remote-supervisor.ts"),
			"utf8",
		);
		expect(source.includes("privatePkcs8Der")).toBe(false);
		expect(source.includes("signMacReceipt(")).toBe(false);
		expect(source.includes("macSign(")).toBe(false);
		expect(source.includes("macKeys")).toBe(false);
	});
});
