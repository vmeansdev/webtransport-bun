#!/usr/bin/env bun
/**
 * Stream throughput benchmark: MB/s using addon server (bidi echo) + client.
 * Opens bidi streams, writes payloads, reads echo, measures total bytes / elapsed time.
 */

import {
	createServer,
	connect,
} from "../../packages/webtransport/src/index.ts";
import type { Duplex } from "node:stream";

const PORT = Number(process.env.BENCH_PORT ?? 4445);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 50);
const PAYLOAD_SIZE = 1024; // 1 KiB per write (server reads 1024 max)

function writeAsync(stream: Duplex, chunk: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		stream.write(chunk, (err) => (err ? reject(err) : resolve()));
	});
}

function readExactly(stream: Duplex, n: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	return new Promise((resolve, reject) => {
		const onData = (chunk: Buffer) => {
			chunks.push(chunk);
			total += chunk.length;
			if (total >= n) {
				stream.off("data", onData);
				stream.off("error", onError);
				resolve(Buffer.concat(chunks).subarray(0, n));
			}
		};
		const onError = (e: Error) => {
			stream.off("data", onData);
			stream.off("error", onError);
			reject(e);
		};
		stream.on("data", onData);
		stream.on("error", onError);
	});
}

async function main() {
	const server = createServer({
		port: PORT,
		tls: { certPem: "", keyPem: "" },
		onSession: async (session) => {
			for await (const duplex of session.incomingBidirectionalStreams) {
				void (async () => {
					await duplex.readable.pipeTo(duplex.writable);
				})().catch((err) => {
					console.warn("[stream-throughput] bidi echo pipe failed:", err);
				});
			}
		},
	});
	await Bun.sleep(2000);

	const url = `https://127.0.0.1:${PORT}`;
	const client = await connect(url, { tls: { insecureSkipVerify: true } });

	const payload = Buffer.alloc(PAYLOAD_SIZE, "x");
	const stream = await client.createBidirectionalStream();

	const start = performance.now();
	let bytesWritten = 0;

	for (let i = 0; i < ROUNDS; i++) {
		await writeAsync(stream, payload);
		await readExactly(stream, payload.length);
		bytesWritten += payload.length;
	}

	const elapsed = (performance.now() - start) / 1000;
	const mbps = bytesWritten / (1024 * 1024) / elapsed;

	client.close();
	await server.close();

	const result = {
		name: "stream-throughput",
		rounds: ROUNDS,
		bytes: bytesWritten,
		elapsed_s: Number(elapsed.toFixed(3)),
		throughput_mbps: Number(mbps.toFixed(2)),
	};
	console.log(JSON.stringify(result));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
