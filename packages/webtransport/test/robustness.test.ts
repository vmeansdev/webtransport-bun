/**
 * Phase 4: Robustness - lifecycle edge cases, cancel iterators, random action sequences.
 */

import { describe, it, expect } from "bun:test";
import { connect, createServer } from "../src/index.js";
import { connectWithRetry, nextPort } from "./helpers/network.js";

const BASE_PORT = 14500;

describe("robustness (Phase 4)", () => {
	it("close during write does not hang", async () => {
		const port = nextPort(BASE_PORT, 1000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		try {
			const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
			});
			try {
				let stream;
				try {
					stream = await client.createBidirectionalStream();
				} catch {
					return;
				}

				stream.on("error", () => {});

				const writes = Array.from(
					{ length: 20 },
					() =>
						new Promise<void>((resolve, reject) => {
							stream!.write(Buffer.alloc(512, "x"), (err) =>
								err ? reject(err) : resolve(),
							);
						}),
				);

				client.close();
				await Promise.allSettled(writes);
			} finally {
				client.close();
			}
		} finally {
			await server.close();
		}
	}, 10000);

	it("abandon datagram iterator (close while iterating)", async () => {
		const port = nextPort(BASE_PORT, 1000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				for await (const d of s.incomingDatagrams()) {
					await s.sendDatagram(d);
				}
			},
		});
		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			await client.sendDatagram(new Uint8Array([1, 2, 3]));
			const iter = client.incomingDatagrams()[Symbol.asyncIterator]();
			const pendingNext = iter.next();

			// Abandon iteration by closing while a next() is pending; it must settle.
			client.close();

			const settled = await Promise.race([
				pendingNext.then(() => true).catch(() => true),
				Bun.sleep(2000).then(() => false),
			]);
			expect(settled).toBe(true);
		} finally {
			client.close();
			await server.close();
		}
	}, 8000);

	it("random action sequence does not crash", async () => {
		const port = nextPort(BASE_PORT, 1000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				(async () => {
					for await (const _ of s.incomingDatagrams()) {
					}
				})().catch(() => {});
			},
		});
		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const actions: Array<() => Promise<void>> = [
				() => client.sendDatagram(new Uint8Array(10)),
				() => client.sendDatagram(new Uint8Array(100)),
				async () => {
					const s = await client.createBidirectionalStream();
					s.write(Buffer.alloc(50), () => {});
				},
			];

			for (let i = 0; i < 15; i++) {
				const act = actions[Math.floor(Math.random() * actions.length)];
				if (!act) continue;
				await act().catch(() => {});
			}
		} finally {
			client.close();
			await server.close();
		}
	}, 15000);
});
