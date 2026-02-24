import { describe, it, expect } from "bun:test";
import { connect, createServer } from "../src/index.js";

describe("webtransport client", () => {
	it("exports connect function", () => {
		expect(typeof connect).toBe("function");
	});

	it("connect rejects when server unreachable", async () => {
		await expect(connect("https://127.0.0.1:19999")).rejects.toThrow();
	}, 15000);

	it("connect rejects self-signed cert when not using insecureSkipVerify (P0-3)", async () => {
		const server = createServer({
			port: 14452,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		await Bun.sleep(2000);

		await expect(
			connect("https://127.0.0.1:14452", {
				/* no tls.insecureSkipVerify - cert verification enabled */
			}),
		).rejects.toThrow();

		await server.close();
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
		const server = createServer({
			port: 14450,
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
		});
		await Bun.sleep(2000);

		const client = await connect("https://127.0.0.1:14450", {
			tls: { insecureSkipVerify: true },
		});
		expect(client.id).toBeDefined();
		expect(client.peer).toBeDefined();
		expect(client.peer.port).toBeGreaterThan(0);

		await client.sendDatagram(new Uint8Array([1, 2, 3]));
		const iter = client.incomingDatagrams()[Symbol.asyncIterator]();
		const first = await iter.next();
		expect(first.done).toBe(false);
		expect(new Uint8Array(first.value!)).toEqual(new Uint8Array([1, 2, 3]));

		await server.close();
	}, 20000);

	it("bidi stream echo works", async () => {
		const server = createServer({
			port: 14451,
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
		});
		await Bun.sleep(2000);

		const client = await connect("https://127.0.0.1:14451", {
			tls: { insecureSkipVerify: true },
		});

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

		await server.close();
	}, 10000);
});
