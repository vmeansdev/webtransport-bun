import { describe, it, expect } from "bun:test";
import { connect, createServer } from "../src/index.js";
import { withHarness } from "./helpers/harness.js";
import { nextPort } from "./helpers/network.js";

async function connectWithRetry(
	url: string,
	opts: Parameters<typeof connect>[1],
	timeoutMs = 6000,
): Promise<Awaited<ReturnType<typeof connect>>> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			return await connect(url, opts);
		} catch (err) {
			lastErr = err;
			await Bun.sleep(100);
		}
	}
	throw lastErr ?? new Error("connectWithRetry: timed out");
}

describe("webtransport client", () => {
	it("exports connect function", () => {
		expect(typeof connect).toBe("function");
	});

	it("connect rejects when server unreachable", async () => {
		await expect(connect("https://127.0.0.1:19999")).rejects.toThrow();
	}, 15000);

	it("connect rejects self-signed cert when not using insecureSkipVerify (P0-3)", async () => {
		await withHarness(async (h) => {
			const port = nextPort(22450, 2000);
			h.track(
				createServer({
					port,
					tls: { certPem: "", keyPem: "" },
					onSession: () => {},
				}),
			);
			await expect(
				connectWithRetry(`https://127.0.0.1:${port}`, {
					/* no tls.insecureSkipVerify - cert verification enabled */
				}),
			).rejects.toThrow();
		});
	}, 15000);

	it("connect with insecureSkipVerify emits warning log", async () => {
		const logs: Array<{ level: string; msg: string }> = [];
		const connectPromise = connect("https://127.0.0.1:19998", {
			tls: { insecureSkipVerify: true },
			log: (e) => logs.push(e),
		});
		await Bun.sleep(100);
		expect(logs.length).toBeGreaterThanOrEqual(1);
		const entry = logs.find((e) => e.msg?.includes("insecureSkipVerify"));
		expect(entry).toBeDefined();
		expect(entry!.msg).toContain("dev only");
		try {
			await Promise.race([connectPromise, Bun.sleep(3000)]);
		} catch {
			// connection fails, ignore
		}
	}, 5000);

	it("connect succeeds when server is running and datagrams work", async () => {
		await withHarness(async (h) => {
			const port = nextPort(22450, 2000);
			h.track(
				createServer({
					port,
					tls: { certPem: "", keyPem: "" },
					onSession: async (s) => {
						void (async () => {
							for await (const d of s.incomingDatagrams()) {
								await s.sendDatagram(d);
							}
						})();
						void (async () => {
							for await (const duplex of s.incomingBidirectionalStreams) {
								const reader = duplex.readable.getReader();
								const chunks: Uint8Array[] = [];
								while (true) {
									const { done, value } = await reader.read();
									if (done) break;
									chunks.push(value);
								}
								if (chunks.length > 0) {
									const writer = duplex.writable.getWriter();
									await writer.write(
										Buffer.concat(chunks.map((c) => Buffer.from(c))),
									);
									await writer.close();
								}
							}
						})().catch(() => {});
					},
				}),
			);

			const client = h.track(
				await connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				}),
			);
			expect(client.id).toBeDefined();
			expect(client.peer).toBeDefined();
			expect(client.peer.port).toBeGreaterThan(0);

			await client.sendDatagram(new Uint8Array([1, 2, 3]));
			const iter = client.incomingDatagrams()[Symbol.asyncIterator]();
			const first = (await Promise.race([
				iter.next(),
				Bun.sleep(2000).then(() => ({ done: true as const, value: undefined })),
			])) as IteratorResult<Uint8Array>;
			expect(first.done).toBe(false);
			expect(new Uint8Array(first.value!)).toEqual(new Uint8Array([1, 2, 3]));
		});
	}, 20000);

	it("bidi stream echo works", async () => {
		await withHarness(async (h) => {
			const port = nextPort(22450, 2000);
			h.track(
				createServer({
					port,
					tls: { certPem: "", keyPem: "" },
					onSession: async (s) => {
						void (async () => {
							for await (const duplex of s.incomingBidirectionalStreams) {
								const reader = duplex.readable.getReader();
								const chunks: Uint8Array[] = [];
								while (true) {
									const { done, value } = await reader.read();
									if (done) break;
									chunks.push(value);
								}
								if (chunks.length > 0) {
									const writer = duplex.writable.getWriter();
									await writer.write(
										Buffer.concat(chunks.map((c) => Buffer.from(c))),
									);
									await writer.close();
								}
							}
						})().catch(() => {});
					},
				}),
			);

			const client = h.track(
				await connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				}),
			);
			const bidi = await client.createBidirectionalStream();
			const payload = Buffer.from("bidi-test");
			await new Promise<void>((resolve, reject) => {
				bidi.write(payload, (err: Error | null | undefined) =>
					err ? reject(err) : resolve(),
				);
			});
			await new Promise<void>((resolve, reject) => {
				bidi.end((err: Error | null | undefined) =>
					err ? reject(err) : resolve(),
				);
			});
			const chunks: Buffer[] = [];
			for await (const c of bidi) chunks.push(c);
			expect(Buffer.concat(chunks)).toEqual(payload);
		});
	}, 10000);
});
