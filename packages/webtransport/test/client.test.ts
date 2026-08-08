import { describe, expect, it } from "bun:test";
import {
	connect,
	createServer,
	E_INVALID_ARGUMENT,
	E_UNSUPPORTED_ARGUMENT,
} from "../src/index.js";
import {
	forEachWithTimeout,
	nextWithTimeout,
	readWithTimeout,
	withTimeout,
	withHarness,
} from "./helpers/harness.js";
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

	it("connect rejects malformed URL with E_INVALID_ARGUMENT", async () => {
		await expect(connect("https://")).rejects.toMatchObject({
			code: E_INVALID_ARGUMENT,
		});
		await expect(connect("not-a-url")).rejects.toMatchObject({
			code: E_INVALID_ARGUMENT,
		});
	}, 15000);

	it("connect rejects non-https URL with E_UNSUPPORTED_ARGUMENT", async () => {
		await expect(connect("http://127.0.0.1:19999")).rejects.toMatchObject({
			code: E_UNSUPPORTED_ARGUMENT,
		});
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
		expect(entry?.msg).toContain("dev only");
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
						void forEachWithTimeout(
							s.incomingDatagrams(),
							5000,
							"client server incoming datagram echo",
							async (d) => {
								await s.sendDatagram(d);
							},
						).catch(() => {});
						void forEachWithTimeout(
							s.incomingBidirectionalStreams,
							5000,
							"client server incoming bidi stream",
							async (duplex) => {
								const reader = duplex.readable.getReader();
								const chunks: Uint8Array[] = [];
								try {
									while (true) {
										const { done, value } = await readWithTimeout(
											reader,
											5000,
											"client server bidi payload read",
										);
										if (done || value === undefined) break;
										chunks.push(value);
									}
								} finally {
									reader.releaseLock();
								}
								if (chunks.length > 0) {
									const writer = duplex.writable.getWriter();
									await writer.write(
										Buffer.concat(chunks.map((c) => Buffer.from(c))),
									);
									await writer.close();
								}
							},
						).catch(() => {});
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
			const first = await nextWithTimeout(
				iter,
				2000,
				"client incoming datagram read",
			);
			expect(first.done).toBe(false);
			expect(first.value).toBeDefined();
			expect(new Uint8Array(first.value ?? [])).toEqual(
				new Uint8Array([1, 2, 3]),
			);
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
						void forEachWithTimeout(
							s.incomingBidirectionalStreams,
							5000,
							"client bidi echo incoming stream",
							async (duplex) => {
								const reader = duplex.readable.getReader();
								const chunks: Uint8Array[] = [];
								try {
									while (true) {
										const { done, value } = await readWithTimeout(
											reader,
											5000,
											"client bidi echo payload read",
										);
										if (done || value === undefined) break;
										chunks.push(value);
									}
								} finally {
									reader.releaseLock();
								}
								if (chunks.length > 0) {
									const writer = duplex.writable.getWriter();
									await writer.write(
										Buffer.concat(chunks.map((c) => Buffer.from(c))),
									);
									await writer.close();
								}
							},
						).catch(() => {});
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
			await forEachWithTimeout(
				bidi,
				5000,
				"client bidi echo response stream",
				async (chunk) => {
					chunks.push(Buffer.from(chunk));
				},
			);
			expect(Buffer.concat(chunks)).toEqual(payload);
		});
	}, 10000);

	it("server bidi close resolves without a peer reader", async () => {
		await withHarness(async (h) => {
			const port = nextPort(22450, 2000);
			let resolveServerClose!: () => void;
			const serverClose = new Promise<void>((resolve) => {
				resolveServerClose = resolve;
			});
			h.track(
				createServer({
					port,
					tls: { certPem: "", keyPem: "" },
					onSession: async (s) => {
						void forEachWithTimeout(
							s.incomingBidirectionalStreams,
							5000,
							"server bidi close without peer reader",
							async (duplex) => {
								const reader = duplex.readable.getReader();
								try {
									await readWithTimeout(
										reader,
										5000,
										"server bidi close payload read",
									);
								} finally {
									reader.releaseLock();
								}
								const writer = duplex.writable.getWriter();
								try {
									await writer.close();
								} finally {
									writer.releaseLock();
								}
								resolveServerClose();
							},
						).catch(() => {});
					},
				}),
			);

			const client = h.track(
				await connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				}),
			);
			const bidi = await client.createBidirectionalStream();
			await new Promise<void>((resolve, reject) => {
				bidi.write(Buffer.from("close-without-reader"), (err) =>
					err ? reject(err) : resolve(),
				);
			});
			await new Promise<void>((resolve, reject) => {
				bidi.end((err: Error | null | undefined) =>
					err ? reject(err) : resolve(),
				);
			});

			await withTimeout(
				serverClose,
				1000,
				"server bidi close without peer reader completion",
			);
		});
	}, 10000);
});
