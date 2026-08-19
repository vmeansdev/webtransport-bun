/**
 * Bidi teardown with a slow reader (issue 02 — the G11 Arm-D teardown hang).
 *
 * Three G11 D-arm cells drove for their full window and then never exited, with
 * a slow reader present in every hanging cell. These tests pin the close paths
 * that shape implicates, each with an explicit deadline, so a regression shows
 * up as a failing assertion rather than as a wedged process:
 *
 *  1. `end()` on the write half settles while inbound bytes sit unread against
 *     the shared per-stream budget.
 *  2. the read half reaches EOF after the reader resumes from a stall that
 *     spanned the entire teardown.
 *  3. `session.close()` with a native read still outstanding settles that read,
 *     so a reader parked on the stream cannot outlive its session.
 *
 * (3) is the one that matches the failure's signature — a process whose JS
 * awaits are all outstanding while every native worker is idle.
 */

import { describe, expect, it } from "bun:test";
import type { Duplex } from "node:stream";
import { connect, createServer } from "../src/index.js";
import { nextPort } from "./helpers/network.js";

const FRAME_BYTES = 1402;
const FRAMES_PER_BURST = 400;

/** Fail loudly with the step's name instead of hanging the suite. */
async function within<T>(
	label: string,
	ms: number,
	promise: Promise<T>,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} did not settle within ${ms}ms`)),
					ms,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

type ServerBidi = {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
};

/**
 * A server that pushes a burst down every accepted bidi stream and drains the
 * upstream as fast as it arrives. The slow reader under test is always the
 * client; the server exists to keep inbound bytes arriving while it stalls.
 */
function startPushServer(port: number, opts: { closeAfterBurst: boolean }) {
	return createServer({
		port,
		tls: { certPem: "", keyPem: "" },
		onSession: async (session: any) => {
			const accepted = (
				session.incomingBidirectionalStreams as ReadableStream<ServerBidi>
			).getReader();
			for (;;) {
				const next = await accepted.read();
				if (next.done || !next.value) break;
				const stream = next.value;
				void (async () => {
					const reader = stream.readable.getReader();
					for (;;) {
						const chunk = await reader.read();
						if (chunk.done) break;
					}
				})().catch(() => undefined);
				void (async () => {
					const writer = stream.writable.getWriter();
					const frame = new Uint8Array(FRAME_BYTES);
					for (let i = 0; i < FRAMES_PER_BURST; i += 1)
						await writer.write(frame);
					// Holding the write half open is what leaves the client's reader
					// parked in a native read rather than at EOF — the state the
					// third test needs to close a session underneath.
					if (opts.closeAfterBurst) await writer.close();
				})().catch(() => undefined);
			}
		},
	});
}

describe("bidi teardown with a slow reader (issue 02)", () => {
	it("end() settles while inbound bytes sit unread against the stream budget", async () => {
		const port = nextPort(26800, 400);
		const server = startPushServer(port, { closeAfterBurst: true });
		const client: any = await connect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const duplex = (await client.createBidirectionalStream()) as Duplex;
			// Write enough to matter, then finish the write half without ever
			// having touched the read half: the server's burst is in flight and
			// unread, holding the shared per-stream budget the write half charges.
			await new Promise<void>((resolve, reject) => {
				duplex.write(Buffer.alloc(FRAME_BYTES), (err) =>
					err ? reject(err) : resolve(),
				);
			});
			await Bun.sleep(300);
			await within(
				"end() with unread inbound",
				10_000,
				new Promise<void>((resolve) => duplex.end(() => resolve())),
			);
			expect(duplex.writableFinished).toBe(true);
		} finally {
			client.close?.();
			await server.close();
		}
	}, 30_000);

	it("the read half reaches EOF after a stall that spanned teardown", async () => {
		const port = nextPort(26800, 400);
		const server = startPushServer(port, { closeAfterBurst: true });
		const client: any = await connect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const duplex = (await client.createBidirectionalStream()) as Duplex;
			let bytesRead = 0;
			const reader = (async () => {
				let stalled = false;
				for await (const chunk of duplex as AsyncIterable<Uint8Array>) {
					bytesRead += chunk.byteLength;
					if (!stalled) {
						stalled = true;
						// Long enough to cover the write-half teardown below.
						await Bun.sleep(2000);
					}
				}
			})();

			await new Promise<void>((resolve, reject) => {
				duplex.write(Buffer.alloc(FRAME_BYTES), (err) =>
					err ? reject(err) : resolve(),
				);
			});
			await new Promise<void>((resolve) => duplex.end(() => resolve()));

			await within("read half EOF after stall", 20_000, reader);
			expect(bytesRead).toBeGreaterThan(0);
		} finally {
			client.close?.();
			await server.close();
		}
	}, 40_000);

	it("a write issued after a write error still calls back", async () => {
		const port = nextPort(26800, 400);
		// A server that accepts the stream and never reads it, so the client's
		// writes run the flow-control window down and then fail the backpressure
		// deadline. That first failure is the trigger; the write after it is the
		// regression.
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (session: any) => {
				const accepted = (
					session.incomingBidirectionalStreams as ReadableStream<ServerBidi>
				).getReader();
				for (;;) {
					const next = await accepted.read();
					if (next.done || !next.value) break;
				}
			},
		});
		const client: any = await connect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
			limits: { backpressureTimeoutMs: 1000 },
		});
		try {
			const duplex = (await client.createBidirectionalStream()) as Duplex;
			const write = () =>
				new Promise<Error | null>((resolve) => {
					duplex.write(Buffer.alloc(FRAME_BYTES), (err) =>
						resolve(err ?? null),
					);
				});

			let firstError: Error | null = null;
			for (let i = 0; i < 20_000 && !firstError; i += 1)
				firstError = await write();
			expect(firstError?.message).toContain("E_BACKPRESSURE_TIMEOUT");

			// The defect: `BidiStream` is a Duplex with `autoDestroy: false`, so a
			// `_write` error leaves the writable `errored` but not `destroyed`.
			// Node buffers every later chunk without ever calling `_write` or the
			// per-write callback, so an application that keeps writing after an
			// error — as a paced driver does — waits forever, with no native work
			// outstanding to show for it.
			const after = await within("write after a write error", 10_000, write());
			expect(after).toBeInstanceOf(Error);
		} finally {
			client.close?.();
			await server.close();
		}
	}, 60_000);

	it("session.close() settles a read outstanding on a stalled stream", async () => {
		const port = nextPort(26800, 400);
		const server = startPushServer(port, { closeAfterBurst: false });
		const client: any = await connect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		let settled = false;
		try {
			const duplex = (await client.createBidirectionalStream()) as Duplex;
			// The server holds its write half open, so this loop drains the burst
			// and then parks in a native read — the state the close below has to
			// terminate.
			const reader = (async () => {
				for await (const _chunk of duplex as AsyncIterable<Uint8Array>) {
					// Drain as fast as it arrives; the park happens at the read.
				}
			})()
				.catch(() => undefined)
				.finally(() => {
					settled = true;
				});

			await new Promise<void>((resolve, reject) => {
				duplex.write(Buffer.alloc(FRAME_BYTES), (err) =>
					err ? reject(err) : resolve(),
				);
			});
			await Bun.sleep(500);

			client.close?.();
			// The contract this pins: a session close must terminate the streams it
			// owns, so a reader parked on one cannot outlive it. Without this, a
			// driver that closes its session and then awaits its reader — which is
			// what the G11 client does — waits forever.
			await within("reader after session.close()", 15_000, reader);
			expect(settled).toBe(true);
		} finally {
			await server.close();
		}
	}, 40_000);
});
