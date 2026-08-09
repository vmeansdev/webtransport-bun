#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Env = Record<string, string | undefined>;

export type PayloadSoakConfig = {
	packageRoot: string;
	durationMs: number;
	operationTimeoutMs: number;
	sampleMs: number;
	streamEvery: number;
	batchSize: number;
	datagramsPerSecond: number;
	port: number;
	outputPath: string;
};

function positiveInteger(env: Env, name: string, fallback: number): number {
	const raw = env[name];
	const value = raw == null || raw === "" ? fallback : Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

export function parsePayloadSoakConfig(env: Env): PayloadSoakConfig {
	const packageRoot = env.PAYLOAD_SOAK_PACKAGE_ROOT?.trim();
	if (!packageRoot) throw new Error("PAYLOAD_SOAK_PACKAGE_ROOT is required");
	const durationMs =
		positiveInteger(env, "PAYLOAD_SOAK_DURATION_SECONDS", 30) * 1000;
	const sampleMs = positiveInteger(env, "PAYLOAD_SOAK_SAMPLE_MS", 1000);
	if (durationMs > 6 * 60 * 60 * 1000) {
		throw new Error("PAYLOAD_SOAK_DURATION_SECONDS exceeds the 6 hour bound");
	}
	if (Math.ceil(durationMs / sampleMs) + 2 > 10_000) {
		throw new Error("payload soak sample count exceeds the 10000 sample bound");
	}
	return {
		packageRoot: resolve(packageRoot),
		durationMs,
		operationTimeoutMs: positiveInteger(env, "PAYLOAD_SOAK_TIMEOUT_MS", 5000),
		sampleMs,
		streamEvery: positiveInteger(env, "PAYLOAD_SOAK_STREAM_EVERY", 1000),
		batchSize: positiveInteger(env, "PAYLOAD_SOAK_BATCH_SIZE", 32),
		datagramsPerSecond: positiveInteger(
			env,
			"PAYLOAD_SOAK_DATAGRAMS_PER_SECOND",
			1000,
		),
		port: positiveInteger(
			env,
			"PAYLOAD_SOAK_PORT",
			30_000 + Math.floor(Math.random() * 20_000),
		),
		outputPath: resolve(env.PAYLOAD_SOAK_OUTPUT ?? "/tmp/payload-soak.json"),
	};
}

export async function withTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function p99(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return (
		sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)] ??
		0
	);
}

function slopeMbPerMinute(
	samples: Array<{ elapsedMs: number; chargedMb: number }>,
): number {
	if (samples.length < 2) return 0;
	const tail = samples.slice(Math.floor(samples.length / 3));
	const meanX =
		tail.reduce((sum, sample) => sum + sample.elapsedMs, 0) / tail.length;
	const meanY =
		tail.reduce((sum, sample) => sum + sample.chargedMb, 0) / tail.length;
	let numerator = 0;
	let denominator = 0;
	for (const sample of tail) {
		numerator += (sample.elapsedMs - meanX) * (sample.chargedMb - meanY);
		denominator += (sample.elapsedMs - meanX) ** 2;
	}
	return denominator === 0 ? 0 : (numerator / denominator) * 60_000;
}

function writeNodeStream(
	stream: NodeJS.WritableStream,
	bytes: Uint8Array,
): Promise<void> {
	return new Promise((resolveWrite, reject) => {
		stream.write(bytes, (error?: Error | null) =>
			error ? reject(error) : resolveWrite(),
		);
	});
}

function endNodeStream(stream: NodeJS.WritableStream): Promise<void> {
	return new Promise((resolveEnd, reject) => {
		stream.end((error?: Error | null) =>
			error ? reject(error) : resolveEnd(),
		);
	});
}

export async function runPayloadOwnershipSoak(config: PayloadSoakConfig) {
	const entry = join(config.packageRoot, "dist/index.js");
	if (!existsSync(entry))
		throw new Error(`paired package entry missing: ${entry}`);
	const addonCandidates = [
		`webtransport-native.${process.platform}-${process.arch}.node`,
		`webtransport-native.${process.platform}-${process.arch}-msvc.node`,
		`webtransport-native.${process.platform}-${process.arch}-gnu.node`,
		`webtransport-native.${process.platform}-${process.arch}-musl.node`,
	].map((name) => join(config.packageRoot, "prebuilds", name));
	const addon = addonCandidates.find(existsSync);
	if (!addon) throw new Error("paired package native addon is missing");

	const api = (await import(pathToFileURL(entry).href)) as any;
	let serverSession: any;
	let stopped = false;
	let serverError: unknown;
	const serverTasks: Promise<void>[] = [];
	const server = api.createServer({
		port: config.port,
		tls: { certPem: "", keyPem: "" },
		onSession(session: any) {
			serverSession = session;
			serverTasks.push(
				(async () => {
					const iterator = session.incomingDatagrams()[Symbol.asyncIterator]();
					while (!stopped) {
						const next: any = await withTimeout<any>(
							iterator.next(),
							config.operationTimeoutMs,
							"server datagram receive",
						);
						if (next.done) break;
						await withTimeout(
							session.sendDatagram(next.value),
							config.operationTimeoutMs,
							"server datagram echo",
						);
					}
				})().catch((error) => {
					if (!stopped) serverError = error;
				}),
			);
			serverTasks.push(
				(async () => {
					const iterator =
						session.incomingBidirectionalStreams[Symbol.asyncIterator]();
					while (!stopped) {
						const next: any = await withTimeout<any>(
							iterator.next(),
							config.operationTimeoutMs,
							"server bidi accept",
						);
						if (next.done) break;
						const reader = next.value.readable.getReader();
						const writer = next.value.writable.getWriter();
						try {
							while (true) {
								const chunk: any = await withTimeout<any>(
									reader.read(),
									config.operationTimeoutMs,
									"server bidi read",
								);
								if (chunk.done) break;
								await withTimeout(
									writer.write(chunk.value),
									config.operationTimeoutMs,
									"server bidi write",
								);
							}
							await withTimeout(
								writer.close(),
								config.operationTimeoutMs,
								"server bidi close",
							);
						} finally {
							reader.releaseLock();
							writer.releaseLock();
						}
					}
				})().catch((error) => {
					if (!stopped) serverError = error;
				}),
			);
		},
	});

	const client: any = await withTimeout<any>(
		api.connect(`https://127.0.0.1:${config.port}`, {
			tls: { insecureSkipVerify: true },
		}),
		config.operationTimeoutMs,
		"client connect",
	);
	const incoming = client.incomingDatagrams()[Symbol.asyncIterator]();
	const payload = new Uint8Array(1200);
	for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

	const samples: Array<Record<string, number>> = [];
	const latenciesMs: number[] = [];
	const maxLatencySamples = 50_000;
	let latencySampleCursor = 0;
	let sentDatagrams = 0;
	let datagrams = 0;
	let streams = 0;
	let errors = 0;
	const startedAt = Date.now();
	const startedCpu = process.cpuUsage();
	let clientError: unknown;
	const clientReceiveTask = (async () => {
		while (!stopped) {
			try {
				const next: any = await withTimeout<any>(
					incoming.next(),
					config.operationTimeoutMs,
					"client datagram receive",
				);
				if (next.done) break;
				datagrams++;
				const sentAt = new DataView(
					next.value.buffer,
					next.value.byteOffset,
					next.value.byteLength,
				).getFloat64(0, true);
				const latency = Math.max(0, performance.now() - sentAt);
				if (latenciesMs.length < maxLatencySamples) latenciesMs.push(latency);
				else {
					latenciesMs[latencySampleCursor % maxLatencySamples] = latency;
					latencySampleCursor++;
				}
			} catch (error) {
				if (!stopped) {
					clientError = error;
					break;
				}
			}
		}
	})();
	const sample = () => {
		const memory = process.memoryUsage();
		samples.push({
			elapsedMs: Date.now() - startedAt,
			rssMb: memory.rss / 1048576,
			chargedMb: memory.rss / 1048576,
			heapUsedMb: memory.heapUsed / 1048576,
			externalMb: memory.external / 1048576,
			arrayBuffersMb: memory.arrayBuffers / 1048576,
			datagrams,
			streams,
		});
	};
	sample();
	const sampler = setInterval(sample, config.sampleMs);

	try {
		while (Date.now() - startedAt < config.durationMs) {
			if (serverError) throw serverError;
			if (clientError) throw clientError;
			for (let i = 0; i < config.batchSize; i++) {
				new DataView(payload.buffer).setFloat64(0, performance.now(), true);
				await withTimeout(
					client.sendDatagram(payload),
					config.operationTimeoutMs,
					"client datagram send",
				);
				sentDatagrams++;
			}
			const targetElapsedMs =
				(sentDatagrams / config.datagramsPerSecond) * 1000;
			const pacingDelayMs = targetElapsedMs - (Date.now() - startedAt);
			if (pacingDelayMs > 0) {
				await new Promise((resolveDelay) =>
					setTimeout(resolveDelay, pacingDelayMs),
				);
			}

			if (Math.floor(sentDatagrams / config.streamEvery) > streams) {
				const bidi: any = await withTimeout<any>(
					client.createBidirectionalStream(),
					config.operationTimeoutMs,
					"client bidi open",
				);
				await withTimeout(
					writeNodeStream(bidi, payload.subarray(0, 256)),
					config.operationTimeoutMs,
					"client bidi write",
				);
				await withTimeout(
					endNodeStream(bidi),
					config.operationTimeoutMs,
					"client bidi finish",
				);
				const iterator = bidi[Symbol.asyncIterator]();
				let received = 0;
				while (true) {
					const next: any = await withTimeout<any>(
						iterator.next(),
						config.operationTimeoutMs,
						"client bidi echo read",
					);
					if (next.done) break;
					received += next.value.length;
				}
				if (received !== 256)
					throw new Error(`bidi echo length ${received} != 256`);
				streams++;
			}
		}
	} catch (error) {
		errors++;
		throw error;
	} finally {
		clearInterval(sampler);
		sample();
		stopped = true;
		client.close();
		serverSession?.close?.(0, "payload soak complete");
		await withTimeout(
			server.close(),
			config.operationTimeoutMs,
			"server close",
		);
		await withTimeout(
			clientReceiveTask,
			config.operationTimeoutMs,
			"client reader close",
		);
		await Promise.allSettled(serverTasks);
	}
	if (datagrams === 0) throw new Error("no echoed datagrams were delivered");

	const elapsedMs = Date.now() - startedAt;
	const cpu = process.cpuUsage(startedCpu);
	const summary = {
		schemaVersion: 1,
		packageRoot: config.packageRoot,
		packageJsSha256: sha256(entry),
		addonSha256: sha256(addon),
		runtime:
			typeof (globalThis as any).Bun?.version === "string"
				? `bun ${(globalThis as any).Bun.version}`
				: `node ${process.version}`,
		memoryMetric: "rss-fallback",
		durationMs: elapsedMs,
		sentDatagrams,
		datagrams,
		streams,
		errors,
		throughputDatagramsPerSecond: datagrams / (elapsedMs / 1000),
		p99LatencyMs: p99(latenciesMs),
		cpuPercent: ((cpu.user + cpu.system) / 1000 / elapsedMs) * 100,
		chargedSlopeMbPerMinute: slopeMbPerMinute(
			samples as Array<{ elapsedMs: number; chargedMb: number }>,
		),
		first: samples[0],
		last: samples.at(-1),
		peakRssMb: Math.max(...samples.map((sample) => sample.rssMb!)),
		samples,
	};
	writeFileSync(config.outputPath, JSON.stringify(summary, null, 2));
	process.stdout.write(`${JSON.stringify(summary)}\n`);
	return summary;
}

const invokedPath = process.argv[1]
	? pathToFileURL(resolve(process.argv[1])).href
	: "";
if (invokedPath === import.meta.url) {
	runPayloadOwnershipSoak(parsePayloadSoakConfig(process.env)).catch(
		(error) => {
			process.stderr.write(`payload-ownership-soak: ${String(error)}\n`);
			process.exitCode = 1;
		},
	);
}
