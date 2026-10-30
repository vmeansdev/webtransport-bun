/**
 * A peer RESET_STREAM must never be downgraded to a clean EOF by the receive
 * batching lever (T07).
 *
 * The lever shipped with a bytes-then-terminal contract — "a batch that runs
 * into one delivers its bytes and leaves the terminal event to be observed by
 * the next call" — justified by the claim that quinn keeps both terminal events
 * sticky. It does not. `quinn-0.11.11/src/recv_stream.rs:401-405` sets
 * `all_data_read = true` *alongside* `reset = Some(code)` on the no-data reset
 * branch, and :361 short-circuits on `all_data_read` before the stored-reset
 * check at :372 — so the read after a consumed reset reports `Ok(None)`, a
 * clean EOF, forever. FIN is genuinely sticky; a reset is not. The batch loop
 * polled `read_chunk` to completion and dropped the `Err`, which consumed the
 * only report of the reset that would ever be made.
 *
 * ## Why this test is sound but only probabilistically sensitive
 *
 * Soundness: the writer below never finishes a stream, it only resets it, so a
 * clean EOF is wrong on every iteration. This test cannot fail spuriously.
 *
 * Sensitivity: the window is narrow and cannot be closed by any black-box
 * driver. `quinn-proto` clears the assembler the instant RESET_STREAM is
 * processed (`connection/streams/recv.rs:199`, and the `debug_assert` at :307
 * that reset streams have empty buffers), so a reset that lands *before* a
 * batch begins is reported correctly by the parking read, and a batch can only
 * hold bytes *and* meet a reset if the connection driver processes the frame
 * concurrently, between two polls of the synchronous drain loop. Measured on
 * the unfixed addon this configuration produced 1/20, 1/200 and 2/200 clean
 * EOFs; the fixed addon produced 0/400. The iteration count is sized to make
 * a regression likely to be caught, not certain — the deterministic guard for
 * the same defect is `classify_batch_poll` / `TerminalLatch` in
 * `crates/native/src/client_stream.rs`, which are unit-tested directly.
 *
 * ## Accounting
 *
 * A reset can overtake the stream's WebTransport header: the client resets
 * one macrotask after opening, and RESET_STREAM discards whatever of the
 * stream was still unsent, header included. The server then cannot attribute
 * the stream to a session and drops it without surfacing it, so it is never
 * accepted (observed 1/20 runs under CPU load, 1 of 200 streams; macOS CI run
 * 41070430710). Every stream the server *accepted* must still reach a
 * terminal — that is what keeps the EOF assertion from being vacuous — and
 * almost all streams must be accepted, so the race is still exercised.
 */

import { describe, expect, it } from "bun:test";
import { childResult, runChild } from "./helpers/child.js";
import { nextPort } from "./helpers/network.js";

const body = `
	const { connect, createServer, WT_RESET } = await import(PUBLIC_MODULE);
	const port = Number(process.env.WT_TEST_PORT);
	const STREAMS = Number(process.env.WT_TEST_STREAMS);
	const CHUNKS = 4000;
	const CHUNK = 512;

	const outcomes = [];
	let accepted = 0;
	const note = (o) => {
		outcomes.push(o);
	};

	const server = createServer({
		port,
		host: "127.0.0.1",
		tls: { certPem: "", keyPem: "" },
		onSession: async (session) => {
			for await (const duplex of session.incomingBidirectionalStreams) {
				accepted++;
				// Drain concurrently: the swallow needs the batch loop to be
				// running when the reset is processed, so the reader must not
				// wait for the writer.
				(async () => {
					const reader = duplex.readable.getReader();
					let bytes = 0;
					try {
						for (;;) {
							const next = await reader.read();
							if (next.done) { note({ end: "eof", bytes }); return; }
							bytes += next.value.byteLength;
						}
					} catch (err) {
						note({ end: "error", bytes, code: String((err && err.message) || err) });
					}
				})();
			}
		},
	});

	const client = await connect("https://127.0.0.1:" + port, {
		tls: { insecureSkipVerify: true },
	});

	const payload = new Uint8Array(CHUNK).fill(7);
	for (let s = 0; s < STREAMS; s++) {
		const stream = await client.createBidirectionalStream();
		for (let i = 0; i < CHUNKS; i++) stream.write(payload);
		// One macrotask only: the peer is mid-drain of the burst, which is
		// where the reset has to land.
		await new Promise((r) => setTimeout(r, 0));
		stream[WT_RESET](42);
	}

	// Done when every stream is accounted for, or when every accepted stream
	// has reached a terminal and nothing new has arrived for two seconds.
	const deadline = Date.now() + 30000;
	let settledSince = 0;
	let settledAt = -1;
	while (Date.now() < deadline && outcomes.length < STREAMS) {
		if (outcomes.length === accepted) {
			if (settledAt !== accepted) { settledAt = accepted; settledSince = Date.now(); }
			else if (Date.now() - settledSince >= 2000) break;
		} else {
			settledAt = -1;
		}
		await Bun.sleep(25);
	}
	report({ outcomes, streams: STREAMS, accepted });
	client.close();
	server.close();
	process.exit(0);
`;

describe("receive batching and a peer reset", () => {
	it("never turns a RESET_STREAM into a clean EOF", async () => {
		const res = childResult(
			await runChild(
				body,
				{
					WT_TEST_PORT: String(nextPort(28700, 300)),
					WT_TEST_STREAMS: "200",
					WEBTRANSPORT_STREAM_BATCH_BYTES: "1048576",
				},
				120_000,
			),
		) as {
			outcomes: { end: string; bytes: number; code?: string }[];
			streams: number;
			accepted: number;
		};

		// Every accepted stream must have been accounted for: a silent hang
		// would make the EOF assertion vacuous rather than satisfied. Only a
		// stream whose reset overtook its header may go unaccepted (see the
		// header), and those must stay rare or the race is not exercised.
		expect(res.outcomes.length).toBe(res.accepted);
		expect(res.accepted).toBeGreaterThanOrEqual(res.streams - 5);

		const clean = res.outcomes.filter((o) => o.end === "eof");
		expect(clean).toEqual([]);
		// And the reported terminal is the peer's reset, not some other error.
		const codes = new Set(res.outcomes.map((o) => o.code));
		for (const code of codes) expect(code).toContain("E_STREAM_RESET");
	}, 180_000);
});
