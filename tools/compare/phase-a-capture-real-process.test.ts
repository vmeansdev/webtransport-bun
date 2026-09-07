/**
 * The ordinary A5 capture, driven over real processes.
 *
 * The eighth staged A5 run sealed `bulk-one-way/physical/ws` and refused
 * `bulk-one-way/physical/wt` at the rig's capture, with a phrase -- `rig
 * refused rig-stop-and-capture-request/v1 with CHILD_LIFECYCLE: server capture
 * ack` -- that nine different conditions produce. Nothing in the suite drove
 * the wt capture against a real child, so nothing could say which of them it
 * was, or that the wt capture worked at all.
 *
 * This drives it: a real `server.ts` child, spawned the way the rig spawns it
 * (staged argv, FD 3/4 control pipes, the staged TLS identity and Mac key in
 * the environment), a real Mac-signed execution on the bind frame, a real
 * client leg over the wire under test, and the production
 * `server-stop-and-capture/v1` exchange. The capture frame is asserted field
 * by field against what the transfer actually did.
 *
 * What it does NOT cover is written at the bottom of this file.
 */

import { describe, expect, test } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import {
	createReadStream,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { systemTransportClock } from "./adapters/transport.ts";
import {
	buildServerBindExecution,
	buildServerMeasureStart,
	buildServerStopAndCapture,
	buildServerTeardown,
	decodeChildPipeFrame,
	encodeChildPipeFrame,
} from "./child-pipe-protocol.ts";
import { adapterForTransport, measureLegOverAdapter } from "./client.ts";
import {
	bytesOfCanonical,
	generateEd25519KeyPair,
	macConstructFinalExecution,
	signMacReceipt,
} from "./cross-supervisor-protocol.ts";
import { createCloexecPipe } from "./remote-supervisor.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "./scenario-registry.ts";
import { sha256HexOfBytes } from "./secure-fs.ts";
import { stagedServerLaunchArgv } from "./server.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const LINUX_CLOCK_ID = "c".repeat(64);
const HEX = (character: string): string => character.repeat(64);
const CELL_ID = "bulk-one-way/physical";

/** A CA and the leaf it signs: WT refuses a CA certificate used end-entity. */
function caSignedTls(dir: string): {
	cert: string;
	key: string;
	ca: string;
} {
	const run = (cmd: string[]): void => {
		const made = Bun.spawnSync({
			cmd,
			stdout: "pipe",
			stderr: "pipe",
			cwd: dir,
		});
		if (made.exitCode !== 0) {
			throw new Error(`${cmd[1]}: ${made.stderr.toString().slice(-500)}`);
		}
	};
	const p = (leaf: string): string => join(dir, leaf);
	run([
		"openssl",
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-days",
		"1",
		"-keyout",
		p("ca.key"),
		"-out",
		p("ca.crt"),
		"-subj",
		"/CN=wt-compare-ca",
	]);
	run([
		"openssl",
		"req",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		p("server.key"),
		"-out",
		p("server.csr"),
		"-subj",
		"/CN=wt-compare.local",
	]);
	writeFileSync(
		p("ext.cnf"),
		"basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n" +
			"extendedKeyUsage=serverAuth\nsubjectAltName=DNS:wt-compare.local,IP:127.0.0.1\n",
	);
	run([
		"openssl",
		"x509",
		"-req",
		"-in",
		p("server.csr"),
		"-CA",
		p("ca.crt"),
		"-CAkey",
		p("ca.key"),
		"-CAcreateserial",
		"-days",
		"1",
		"-extfile",
		p("ext.cnf"),
		"-out",
		p("server.crt"),
	]);
	return {
		cert: readFileSync(p("server.crt"), "utf8"),
		key: readFileSync(p("server.key"), "utf8"),
		ca: readFileSync(p("ca.crt"), "utf8"),
	};
}

/**
 * One ordinary Phase-A arm against a real child, from bind to teardown.
 *
 * Every frame on the wire is the production builder's; every answer is
 * decoded with the production decoder. The only thing this stands in for is
 * the rig supervisor's own bookkeeping, which is Rust and has its own tests.
 */
async function driveOrdinaryArm(wire: "ws" | "wt"): Promise<{
	readonly answers: Record<string, unknown>[];
	readonly snapshot: Record<string, unknown>;
	readonly deliveredBytes: number;
	readonly exitCode: number;
}> {
	const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
		(candidate) => candidate.cellId === CELL_ID,
	);
	if (cell === undefined) throw new Error(`${CELL_ID} is not registered`);
	const bulk = cell.parameters as { bytes: number; chunkBytes: number };

	const mac = generateEd25519KeyPair();
	const dir = mkdtempSync(join(tmpdir(), "phase-a-capture-"));
	let child: ReturnType<typeof nodeSpawn> | null = null;
	try {
		const tls = caSignedTls(dir);
		const issuedAtMs = Date.now();
		const notAfterMs = issuedAtMs + 600_000;
		const argv = stagedServerLaunchArgv(
			wire,
			"bulk-source",
			"local-acceptance",
		);
		const port = 20_000 + Math.floor(Math.random() * 20_000);
		const stagedLaunchRecordSha256 = HEX("2");

		const built = macConstructFinalExecution({
			draft: {
				schema: "cross-supervisor-execution-draft/v1",
				authoritySha256: HEX("a"),
				campaignLockSha256: HEX("b"),
				stagedCapabilitySha256: HEX("c"),
				sourceArchiveSha256: HEX("d"),
				approvedPlanSha256: HEX("e"),
				approvalRecordSha256: HEX("f"),
				candidate: "phase-a-capture",
				campaignId: "phase-a-capture",
				runId: `phase-a-capture/${CELL_ID}/${wire}/measured-1`,
				executionPurpose: "focused",
				cellId: CELL_ID,
				scenarioHash: cell.scenarioHash,
				rolePlanHash: HEX("6"),
				workloadRolePlanInputSha256: HEX("8"),
				stagedServerLaunchRecordSha256: stagedLaunchRecordSha256,
				armKind: "primary",
				transport: wire,
				repetitionKind: "measured",
				repetitionIndex: 1,
				repetitionTotal: 1,
				grantDeclaration: "phase-a-completed-transfer",
				declaredMessageCount: 1_600,
				declaredMessageBytes: bulk.bytes,
				requestedNotAfterMs: notAfterMs,
			},
			executionIndex: 1,
			macSupervisorInstanceNonce: HEX("7"),
			issuedAtMs,
			notAfterMs,
			grantNonceSha256: HEX("9"),
		});
		if (!built.ok) throw new Error(`execution: ${built.code}`);
		const executionSha256 = built.value.executionSha256;
		const receiptBytes = bytesOfCanonical({
			schema: "mac-execution-grant-receipt/v1",
			execution: built.value.execution,
			executionSha256,
			measurementGrantSha256: built.value.grantSha256,
			approvedPlanSha256: HEX("e"),
			approvalRecordSha256: HEX("f"),
			macSupervisorExecutableSha256: HEX("d"),
			macSupervisorInstanceNonce: HEX("7"),
			signingPublicKeySha256: sha256HexOfBytes(mac.publicRaw32),
			receiptSequence: 0,
			issuedAtMs,
			notAfterMs,
		});
		const receiptSignature = signMacReceipt({
			privatePkcs8Der: mac.privatePkcs8Der,
			publicRaw32: mac.publicRaw32,
			signedSchema: "mac-execution-grant-receipt/v1",
			signedBytes: receiptBytes,
		});

		const inbound = createCloexecPipe({ parentKeeps: "write" });
		const outbound = createCloexecPipe({ parentKeeps: "read" });
		if (!inbound.ok || !outbound.ok) throw new Error("pipe(2) failed");

		child = nodeSpawn(
			"bun",
			[
				join(REPO_ROOT, "tools", "compare", argv[0] as string),
				...argv.slice(1),
				`--port=${port}`,
			],
			{
				cwd: REPO_ROOT,
				stdio: [
					"ignore",
					"pipe",
					"pipe",
					inbound.pipe.childFd,
					outbound.pipe.childFd,
				],
				env: {
					...process.env,
					WS_WT_COHORT_STAGED_MAC_PUBLIC_KEY_BASE64: Buffer.from(
						mac.publicRaw32,
					).toString("base64"),
					WS_WT_COHORT_LINUX_CLOCK_ID: LINUX_CLOCK_ID,
					WS_WT_COHORT_RECEIPT_VALIDITY_MS: "600000",
					WS_WT_TLS_CERT_CONTENT: tls.cert,
					WS_WT_TLS_KEY_CONTENT: tls.key,
					WS_WT_TLS_SERVER_NAME: "wt-compare.local",
				},
			},
		);
		const stderr: Buffer[] = [];
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.stdout?.resume();
		const exited = new Promise<number>((done) => {
			child?.once("exit", (code) => done(code ?? -1));
		});

		const answers: Record<string, unknown>[] = [];
		let buffered = Buffer.alloc(0);
		const reader = createReadStream("", {
			fd: outbound.pipe.parentFd,
			autoClose: true,
		});
		reader.on("data", (chunk: Buffer | string) => {
			buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
			for (;;) {
				if (buffered.byteLength < 4) break;
				const length = buffered.readUInt32BE(0);
				if (buffered.byteLength < 4 + length) break;
				const frame = buffered.subarray(0, 4 + length);
				buffered = buffered.subarray(4 + length);
				const decoded = decodeChildPipeFrame(new Uint8Array(frame));
				if (decoded.ok) answers.push(decoded.value as Record<string, unknown>);
			}
		});

		const send = (frame: { schema: string }): void => {
			const encoded = encodeChildPipeFrame(
				frame as unknown as Parameters<typeof encodeChildPipeFrame>[0],
			);
			if (!encoded.ok)
				throw new Error(`encode ${frame.schema}: ${encoded.code}`);
			// The parent end is a real descriptor this process owns for the
			// life of the arm, which is what makes this the rig's own write.
			writeSync(inbound.pipe.parentFd, Buffer.from(encoded.value));
		};
		const awaitAnswer = async (schema: string, timeoutMs: number) => {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const found = answers.find((answer) => answer.schema === schema);
				if (found !== undefined) return found;
				// A child that refuses says so on the same pipe, once, and then
				// stops answering. Waiting out the deadline for a frame that is
				// never coming would report a timeout and lose the one thing the
				// child said -- which is the failure this whole file is about.
				const refusal = answers.find(
					(answer) => answer.schema === "child-pipe-refusal/v1",
				);
				if (refusal !== undefined) {
					throw new Error(
						`the child refused ${schema} with ${String(refusal.code)}; ` +
							`stderr: ${Buffer.concat(stderr).toString().slice(-1200)}`,
					);
				}
				if (Date.now() > deadline) {
					throw new Error(
						`no ${schema} within ${timeoutMs}ms; child stderr: ${Buffer.concat(stderr).toString().slice(-1200)}`,
					);
				}
				await Bun.sleep(25);
			}
		};

		const bind = buildServerBindExecution({
			sequence: 0,
			executionSha256,
			rigExecutionAcceptanceSha256: HEX("e"),
			cohortGrantBase64: null,
			cohortGrantSignatureBase64: null,
			macExecutionGrantReceiptBase64:
				Buffer.from(receiptBytes).toString("base64"),
			macExecutionGrantSignatureBase64: Buffer.from(
				bytesOfCanonical(receiptSignature),
			).toString("base64"),
		});
		if (!bind.ok) throw new Error(`bind frame: ${bind.code}`);
		send(bind.value);
		await awaitAnswer("server-ready/v1", 60_000);

		const measureStart = buildServerMeasureStart({
			sequence: 1,
			executionSha256,
			warmupCompleteSha256: null,
		});
		if (!measureStart.ok)
			throw new Error(`measure start: ${measureStart.code}`);
		send(measureStart.value);
		await awaitAnswer("server-measure-start-ack/v1", 30_000);

		const adapter = await adapterForTransport(wire);
		const leg = await measureLegOverAdapter({
			adapter,
			cell,
			serverUrl: `${wire === "ws" ? "wss" : "https"}://127.0.0.1:${port}`,
			role: "publisher",
			driverRunId: `phase-a-capture/${wire}`,
			runId: `phase-a-capture/${wire}`,
			sessionId: `phase-a-capture/${wire}-s1`,
			clock: systemTransportClock,
			connectTimeoutMs: 30_000,
			perMessageTimeoutMs: 60_000,
			armKind: "primary",
			tls: {
				ca: tls.ca,
				serverName: "wt-compare.local",
				rejectUnauthorized: true,
			},
		});

		const capture = buildServerStopAndCapture({
			sequence: 2,
			executionSha256,
			cohortStartBarrierSha256: null,
			drainDeadlineMs: 30_000,
		});
		if (!capture.ok) throw new Error(`capture frame: ${capture.code}`);
		send(capture.value);
		const ack = await awaitAnswer("server-capture-ack/v1", 60_000);

		const teardown = buildServerTeardown({ sequence: 3, executionSha256 });
		if (!teardown.ok) throw new Error(`teardown frame: ${teardown.code}`);
		send(teardown.value);
		await awaitAnswer("server-stopped/v1", 30_000);

		const snapshot = JSON.parse(
			Buffer.from(ack.snapshotFrameBase64 as string, "base64").toString("utf8"),
		) as Record<string, unknown>;
		return {
			answers,
			snapshot,
			deliveredBytes: leg.deliveredBytes ?? 0,
			exitCode: await exited,
		};
	} finally {
		try {
			child?.kill("SIGKILL");
		} catch {
			// the child is already gone
		}
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("the ordinary A5 capture over real processes", () => {
	for (const wire of ["wt", "ws"] as const) {
		test(`the ${wire} child answers server-stop-and-capture with the transfer it actually ran`, async () => {
			const arm = await driveOrdinaryArm(wire);

			// The child refused nothing: a `child-pipe-refusal/v1` anywhere in
			// the answers is the live failure this test exists to catch, and
			// the refusal's own code says which of the nine conditions fired.
			const refusal = arm.answers.find(
				(answer) => answer.schema === "child-pipe-refusal/v1",
			);
			expect(refusal?.code ?? null).toBeNull();

			expect(arm.answers.map((answer) => answer.schema)).toEqual([
				"server-ready/v1",
				"server-measure-start-ack/v1",
				"server-capture-ack/v1",
				"server-stopped/v1",
			]);
			expect(arm.deliveredBytes).toBe(104_857_600);

			const snapshot = arm.snapshot;
			expect(snapshot.schema).toBe("server-loop-utilization/v1");
			expect(snapshot.transport).toBe(wire);
			expect(snapshot.allMeasuredSessionsClosed).toBe(true);
			expect(snapshot.linuxClockId).toBe(LINUX_CLOCK_ID);
			// The measured window is a real interval and the busy reading
			// never went backwards across it -- the two conditions the child
			// refuses `CHILD_LIFECYCLE` for before it can build this frame.
			expect(snapshot.windowMs as number).toBeGreaterThan(0);
			expect(snapshot.finalBusyMs as number).toBeGreaterThanOrEqual(
				snapshot.baselineBusyMs as number,
			);

			const completion = snapshot.bulkSourceCompletion as Record<
				string,
				unknown
			>;
			expect(completion.bytesWritten).toBe(104_857_600);
			expect(completion.chunksWritten).toBe(1_600);
			expect(completion.scheduledChunkCount).toBe(1_600);
			expect(completion.channelEnded).toBe(true);
			expect(completion.channelMapping).toBe("server-opened-uni");
			expect(arm.exitCode).toBe(0);
		}, 240_000);
	}
});

/**
 * What this does not cover.
 *
 * - The rig supervisor. The frames here are driven by the test, so nothing
 *   asserts the Rust side's sequencing, its receipt signing, or the process
 *   group it reaps. `child_pipe_refusal_detail_tests` in
 *   `comparison-supervisor.rs` covers the rig's half of this exchange, over
 *   real pipes but against a scripted child.
 * - The physical path. Both arms run on loopback, so the transfer never meets
 *   the cable's RTT, its MTU, or a real network's loss. A capture condition
 *   that only appears at 10.99.0.2 will not appear here.
 * - The campaign. One execution, one repetition, one child: this says nothing
 *   about the warmup repetition, about a second arm on the same supervisor
 *   session and port, or about anything the controller does around the leg.
 * - The failure the eighth run hit. The arm passes, so this pins the working
 *   shape rather than reproducing a break; what it will do is fail loudly, and
 *   name the child's own refusal code, if the capture ever stops working.
 */
