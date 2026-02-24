/**
 * Phase 4: Robustness - lifecycle edge cases, cancel iterators, random action sequences.
 */

import { describe, it, expect } from "bun:test";
import { connect, createServer } from "../src/index.js";

const BASE_PORT = 14500;

function nextPort(): number {
	return BASE_PORT + Math.floor(Math.random() * 1000);
}

describe("robustness (Phase 4)", () => {
	it("close during write does not hang", async () => {
		const port = nextPort();
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		await Bun.sleep(2000);

		const client = await connect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});

		let stream;
		try {
			stream = await client.createBidirectionalStream();
		} catch {
			client.close();
			await server.close();
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
		await server.close();
	}, 10000);

	it("abandon datagram iterator (close while iterating)", async () => {
		const port = nextPort();
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				for await (const d of s.incomingDatagrams()) {
					await s.sendDatagram(d);
				}
			},
		});
		await Bun.sleep(2000);

		const client = await connect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});

		await client.sendDatagram(new Uint8Array([1, 2, 3]));
		let count = 0;
		const iter = client.incomingDatagrams()[Symbol.asyncIterator]();
		const first = (await Promise.race([
			iter.next(),
			Bun.sleep(1500).then(() => ({ done: true as const, value: undefined })),
		])) as IteratorResult<Uint8Array>;
		if (!first.done) {
			count++;
			client.close();
		}
		expect(count).toBeGreaterThanOrEqual(1);
		await server.close();
	}, 8000);

	it("random action sequence does not crash", async () => {
		const port = nextPort();
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
		await Bun.sleep(2000);

		const client = await connect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});

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

		client.close();
		await server.close();
	}, 15000);
});
