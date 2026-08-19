/**
 * Receive-side stream chunk batching (T07): knob resolution, the crossing
 * itself, the mandatory diagnostics counter, and an end-to-end proof that a
 * batched transfer delivers exactly the bytes an unbatched one does.
 *
 * Every environment case runs in a fresh bounded child process — the knob is
 * resolved once per process, so comparing settings means comparing processes.
 */

import { describe, expect, it } from "bun:test";
import { __TESTING__ } from "../src/internal.js";
import { childResult, runChild } from "./helpers/child.js";
import { nextPort } from "./helpers/network.js";

const parse = __TESTING__.parseStreamBatchBytesForTests;

// Control arms pin the knob off explicitly: inheriting an ambient value would
// silently turn a control into a second batched arm.
const KNOB_OFF = { WEBTRANSPORT_STREAM_BATCH_BYTES: undefined };

describe("stream batch knob resolution", () => {
	it("is off unless a positive decimal integer asks for it", () => {
		expect(parse(undefined)).toBe(0);
		expect(parse("")).toBe(0);
		expect(parse("  ")).toBe(0);
		expect(parse("nope")).toBe(0);
		expect(parse("1.5")).toBe(0);
		expect(parse("0x1000")).toBe(0);
		expect(parse("1e4")).toBe(0);
		expect(parse("Infinity")).toBe(0);
		expect(parse("0")).toBe(0);
		expect(parse("-1")).toBe(0);
		// A decimal-integer string long enough to overflow a double still
		// matches the shape test and must not become Infinity bytes.
		expect(parse("9".repeat(400))).toBe(0);
	});

	it("takes positive values and clamps them to the addon ceiling", () => {
		expect(parse("1")).toBe(1);
		expect(parse(" 65536 ")).toBe(65536);
		expect(parse(String(1024 * 1024))).toBe(1024 * 1024);
		expect(parse(String(64 * 1024 * 1024))).toBe(1024 * 1024);
	});

	it("lands OFF: a process with no knob set resolves zero", async () => {
		const res = childResult(
			await runChild(
				`const { __TESTING__ } = await import(INTERNAL_MODULE);
				 report(__TESTING__.streamBatchConfigForTests());`,
				KNOB_OFF,
			),
		);
		expect(res.batchBytes).toBe(0);
		expect(res.diagnosticsEnabled).toBe(false);
	});
});

// The crossing is driven against fake handles so these assertions do not
// depend on network timing; the function under test is the one both incoming
// stream readables and both Node adapters call.
const crossingBody = `
	const { __TESTING__ } = await import(INTERNAL_MODULE);
	const readStreamChunk = __TESTING__.readStreamChunkForTests;
	const calls = [];
	const handle = {
		read: async () => { calls.push(["read"]); return new Uint8Array([1, 2, 3]); },
		readBatch: async (maxBytes) => {
			calls.push(["readBatch", maxBytes]);
			return new Uint8Array(new Array(10).fill(7));
		},
	};
	const legacyOnly = {
		read: async () => { calls.push(["legacy-read"]); return new Uint8Array([9]); },
	};
	const eof = { read: async () => null, readBatch: async () => null };
	const failing = {
		read: async () => "E_STREAM_RESET",
		readBatch: async () => "E_STREAM_RESET",
	};
	const first = await readStreamChunk(handle);
	const fallback = await readStreamChunk(legacyOnly);
	const atEof = await readStreamChunk(eof);
	const failed = await readStreamChunk(failing);
	report({
		cfg: __TESTING__.streamBatchConfigForTests(),
		calls,
		first: Array.from(first),
		fallback: Array.from(fallback),
		atEof,
		failed,
		diag: __TESTING__.streamBatchDiagnosticsSnapshotForTests(),
	});
`;

describe("the receive-side crossing", () => {
	it("uses the legacy read when the knob is off", async () => {
		const res = childResult(await runChild(crossingBody, KNOB_OFF));
		expect(res.cfg.batchBytes).toBe(0);
		expect(res.calls).toEqual([["read"], ["legacy-read"]]);
		expect(res.first).toEqual([1, 2, 3]);
	});

	it("uses readBatch with the resolved budget when the knob is on", async () => {
		const res = childResult(
			await runChild(crossingBody, {
				WEBTRANSPORT_STREAM_BATCH_BYTES: "65536",
			}),
		);
		expect(res.cfg.batchBytes).toBe(65536);
		expect(res.calls).toEqual([["readBatch", 65536], ["legacy-read"]]);
		expect(res.first).toEqual([7, 7, 7, 7, 7, 7, 7, 7, 7, 7]);
	});

	it("passes EOF and the never-reject error sentinel straight through", async () => {
		for (const env of [KNOB_OFF, { WEBTRANSPORT_STREAM_BATCH_BYTES: "4096" }]) {
			const res = childResult(await runChild(crossingBody, env));
			expect(res.atEof).toBe(null);
			expect(res.failed).toBe("E_STREAM_RESET");
		}
	});

	it("counts nothing while diagnostics are disabled", async () => {
		const res = childResult(await runChild(crossingBody, KNOB_OFF));
		expect(res.cfg.diagnosticsEnabled).toBe(false);
		expect(res.diag.dataCrossings).toBe(0);
		expect(res.diag.terminalCrossings).toBe(0);
		expect(res.diag.bytes).toBe(0);
		expect(res.diag.maxBatchBytes).toBe(0);
		expect(res.diag.meanBytesPerCrossing).toBe(0);
	});

	it("measures crossings, bytes and the largest batch when enabled", async () => {
		const res = childResult(
			await runChild(crossingBody, {
				WEBTRANSPORT_STREAM_BATCH_BYTES: "65536",
				WEBTRANSPORT_STREAM_BATCH_DIAGNOSTICS: "1",
			}),
		);
		expect(res.cfg.diagnosticsEnabled).toBe(true);
		// Two data crossings (10 bytes batched, 1 byte via the legacy fallback)
		// and two terminal ones (EOF, error sentinel).
		expect(res.diag.dataCrossings).toBe(2);
		expect(res.diag.terminalCrossings).toBe(2);
		expect(res.diag.batchedCrossings).toBe(3);
		expect(res.diag.bytes).toBe(11);
		expect(res.diag.maxBatchBytes).toBe(10);
		expect(res.diag.meanBytesPerCrossing).toBeCloseTo(5.5, 10);
		expect(res.diag.crossingsPerSecond).toBeGreaterThan(0);
	});

	it("measures the unbatched control arm with the same counter", async () => {
		const res = childResult(
			await runChild(crossingBody, {
				...KNOB_OFF,
				WEBTRANSPORT_STREAM_BATCH_DIAGNOSTICS: "1",
			}),
		);
		expect(res.cfg.batchBytes).toBe(0);
		expect(res.diag.batchedCrossings).toBe(0);
		expect(res.diag.dataCrossings).toBe(2);
		expect(res.diag.bytes).toBe(4);
	});
});

// One real transfer over a real stream, in-process client and server, so the
// batched arm is compared against the control on identical bytes.
const transferBody = `
	const { connect, createServer } = await import(PUBLIC_MODULE);
	const { __TESTING__ } = await import(INTERNAL_MODULE);
	const port = Number(process.env.WT_TEST_PORT);
	const TOTAL = 512 * 1024;
	const CHUNK = 1024;

	let resolveDone;
	const done = new Promise((r) => { resolveDone = r; });
	const server = createServer({
		port,
		host: "127.0.0.1",
		tls: { certPem: "", keyPem: "" },
		onSession: async (session) => {
			const reader = session.incomingBidirectionalStreams.getReader();
			const { value: duplex } = await reader.read();
			reader.releaseLock();
			// Let the burst pile up first: coalescing is opportunistic by
			// design, so a reader that keeps pace with a slow sender would make
			// the comparison a race instead of a measurement.
			await Bun.sleep(200);
			const body = duplex.readable.getReader();
			let received = 0;
			let sum = 0;
			let sizes = [];
			for (;;) {
				const next = await body.read();
				if (next.done) break;
				sizes.push(next.value.byteLength);
				received += next.value.byteLength;
				for (let i = 0; i < next.value.length; i++) sum = (sum + next.value[i]) % 65521;
			}
			resolveDone({ received, sum, chunks: sizes.length, maxChunk: Math.max(...sizes) });
			// Echo back so the client's own receive path — the bridged lane,
			// through the Node adapter — is exercised too.
			const writer = duplex.writable.getWriter();
			for (let sent = 0; sent < TOTAL; sent += CHUNK) {
				await writer.write(new Uint8Array(CHUNK).fill(7));
			}
			await writer.close();
		},
	});

	__TESTING__.resetStreamBatchDiagnosticsForTests();
	const client = await connect("https://127.0.0.1:" + port, {
		tls: { insecureSkipVerify: true },
	});
	const stream = await client.createBidirectionalStream();
	let expectedSum = 0;
	for (let sent = 0; sent < TOTAL; sent += CHUNK) {
		const buf = Buffer.alloc(CHUNK);
		for (let i = 0; i < CHUNK; i++) {
			buf[i] = (sent + i) % 251;
			expectedSum = (expectedSum + buf[i]) % 65521;
		}
		stream.write(buf);
	}
	stream.end();
	const result = await done;
	let echoed = 0;
	let echoSum = 0;
	const echoSizes = [];
	await Bun.sleep(200);
	for await (const chunk of stream) {
		echoSizes.push(chunk.byteLength);
		echoed += chunk.byteLength;
		for (let i = 0; i < chunk.length; i++) echoSum = (echoSum + chunk[i]) % 65521;
	}
	report({
		cfg: __TESTING__.streamBatchConfigForTests(),
		expected: { received: TOTAL, sum: expectedSum },
		actual: result,
		echo: {
			received: echoed,
			sum: echoSum,
			chunks: echoSizes.length,
			maxChunk: Math.max(...echoSizes),
		},
		diag: __TESTING__.streamBatchDiagnosticsSnapshotForTests(),
	});
	client.close();
	server.close();
	// The driver exits explicitly: an abandoned session keeps the loop
	// referenced, which is a separate (recorded) liveness defect.
	process.exit(0);
`;

describe("a real transfer", () => {
	it("delivers identical bytes batched and unbatched, with larger crossings", async () => {
		const control = childResult(
			await runChild(transferBody, {
				...KNOB_OFF,
				WT_TEST_PORT: String(nextPort(28400, 200)),
				WEBTRANSPORT_STREAM_BATCH_DIAGNOSTICS: "1",
			}),
		);
		const batched = childResult(
			await runChild(transferBody, {
				WT_TEST_PORT: String(nextPort(28400, 200)),
				WEBTRANSPORT_STREAM_BATCH_BYTES: "65536",
				WEBTRANSPORT_STREAM_BATCH_DIAGNOSTICS: "1",
			}),
		);

		// Same bytes, same order, both arms.
		expect(control.actual.received).toBe(control.expected.received);
		expect(control.actual.sum).toBe(control.expected.sum);
		expect(batched.actual.received).toBe(batched.expected.received);
		expect(batched.actual.sum).toBe(batched.expected.sum);

		// The control arm cannot exceed one quinn assembler chunk per crossing.
		expect(control.cfg.batchBytes).toBe(0);
		expect(control.diag.maxBatchBytes).toBeLessThanOrEqual(4096);

		// The batched arm coalesces: fewer, larger crossings for the same bytes.
		expect(batched.cfg.batchBytes).toBe(65536);
		expect(batched.diag.maxBatchBytes).toBeGreaterThan(4096);
		expect(batched.diag.meanBytesPerCrossing).toBeGreaterThan(
			control.diag.meanBytesPerCrossing,
		);
		expect(batched.actual.chunks).toBeLessThan(control.actual.chunks);

		// The bridged lane, seen through the client's Node adapter: same bytes,
		// and batching coalesces there too.
		expect(control.echo.received).toBe(512 * 1024);
		expect(batched.echo.received).toBe(512 * 1024);
		expect(control.echo.sum).toBe(batched.echo.sum);
		expect(batched.echo.maxChunk).toBeGreaterThan(control.echo.maxChunk);
		expect(batched.echo.chunks).toBeLessThan(control.echo.chunks);
	}, 120_000);
});
