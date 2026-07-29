#!/usr/bin/env bun

/**
 * Stream throughput benchmark: MB/s using addon server (bidi echo) + client.
 * Opens bidi streams, writes payloads, reads echo, measures total bytes / elapsed time.
 */

import type { Duplex } from "node:stream";
import {
	connect,
	createServer,
} from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";

const PORT = Number(process.env.BENCH_PORT ?? 4445);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 50);
const PAYLOAD_SIZE = 1024; // 1 KiB per write (server reads 1024 max)
const CLOSE_TIMEOUT_MS = Number(process.env.BENCH_CLOSE_TIMEOUT_MS ?? 5_000);

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

async function finishStream(stream: Duplex): Promise<void> {
	const ended = new Promise<void>((resolve, reject) => {
		stream.once("end", resolve);
		stream.once("error", reject);
		stream.end();
		stream.resume();
	});
	await Promise.race([
		ended,
		Bun.sleep(CLOSE_TIMEOUT_MS).then(() => {
			throw new Error("stream-throughput: timed out waiting for clean FIN");
		}),
	]);
}

async function main() {
	const cert = generateLocalhostCert();
	if (!cert) {
		throw new Error("stream-throughput: failed to generate localhost TLS cert");
	}
	const server = createServer({
		port: PORT,
		tls: { certPem: cert.certPem, keyPem: cert.keyPem },
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
	const client = await connect(url, {
		tls: { caPem: cert.certPem, serverName: "localhost" },
	});

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
	await finishStream(stream);

	client.close();
	await server.close();
	cert.cleanup();

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
