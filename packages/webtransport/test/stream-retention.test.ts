import { describe, expect, test } from "bun:test";
import { connect, createServer, WT_STOP_SENDING } from "../src/index.js";

// Regression falsifier for the 24h-soak OOM (run 31134714109): Bun <=1.3.13
// retained one WritableStream + one rejection Error for every server bidi
// stream whose writer.close() rejected — the exact teardown path taken when
// a peer drops its receive half (quinn sends STOP_SENDING immediately, as
// the Rust load-client does by design). Under load that compounded at
// ~670MB/h committed until the kernel OOM-killed the soak. On a healthy
// runtime the count stays flat no matter how many streams have churned.
describe("server stream retention", () => {
	test("bidi streams torn down by peer STOP_SENDING do not accumulate WritableStreams", async () => {
		const { heapStats } = await import("bun:jsc");
		const port = 40000 + Math.floor(Math.random() * 20000);
		const ROUNDS = 400;

		let handled = 0;
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (session) => {
				void (async () => {
					const reader = session.incomingBidirectionalStreams.getReader();
					try {
						while (true) {
							const next = await reader.read();
							if (next.done) return;
							const duplex = next.value;
							void (async () => {
								try {
									const bodyReader = duplex.readable.getReader();
									try {
										while (true) {
											const chunk = await bodyReader.read();
											if (chunk.done) break;
										}
									} finally {
										bodyReader.releaseLock();
									}
									const writer = duplex.writable.getWriter();
									try {
										await writer.close();
									} catch {
										// Peer STOP_SENDING races this close — expected.
									} finally {
										writer.releaseLock();
									}
								} finally {
									handled++;
								}
							})();
						}
					} catch {
						// session teardown
					} finally {
						try {
							reader.releaseLock();
						} catch {}
					}
				})();
			},
		});

		const client = await connect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const payload = Buffer.from(`load:bidi:${"x".repeat(64)}`);
			for (let i = 0; i < ROUNDS; i++) {
				const stream = await client.createBidirectionalStream();
				// Mirror the Rust load-client dropping `_recv` at open.
				(stream as unknown as { [WT_STOP_SENDING]?: (code?: number) => void })[
					WT_STOP_SENDING
				]?.(0);
				await new Promise<void>((res, rej) =>
					stream.write(payload, (e: Error | null | undefined) =>
						e ? rej(e) : res(),
					),
				);
				await new Promise<void>((res, rej) =>
					stream.end((e?: Error | null) => (e ? rej(e) : res())),
				);
				// Never read the receive half.
			}

			const deadline = Date.now() + 15_000;
			while (handled < ROUNDS && Date.now() < deadline) {
				await Bun.sleep(50);
			}
			expect(handled).toBeGreaterThanOrEqual(ROUNDS * 0.95);

			Bun.gc(true);
			await Bun.sleep(100);
			Bun.gc(true);
			const counts = heapStats().objectTypeCounts as Record<string, number>;
			// Leaking runtimes retain ~1 per handled stream (400 here); a healthy
			// one keeps a handful of transient instances.
			expect(counts.WritableStream ?? 0).toBeLessThan(50);
			expect(counts.WritableStreamDefaultController ?? 0).toBeLessThan(50);
		} finally {
			client.close();
			await server.close();
		}
	}, 60_000);
});
