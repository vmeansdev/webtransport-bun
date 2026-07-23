import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
	BROWSER_READ_WITH_TIMEOUT_INIT_SCRIPT,
	resolveInteropHealthUrl,
} from "../browser-helpers.js";
import { getCertHashBase64 } from "../cert-hash.js";
import {
	RELEASE_FAULT_PROFILES,
	type UdpFaultProfile,
	UdpFaultProxy,
} from "../udp-fault-proxy.js";

const proxyPort = Number(process.env.WEBTRANSPORT_FAULT_PROXY_PORT ?? "4443");
const upstreamPort = Number(
	process.env.WEBTRANSPORT_INTEROP_QUIC_PORT ?? "4433",
);
const evidencePath = resolve(
	process.env.WT_FAULT_EVIDENCE_PATH ??
		"../../.release-evidence/interop/fault-matrix.json",
);

type ScenarioEvidence = {
	profile: UdpFaultProfile;
	stats: ReturnType<UdpFaultProxy["engine"]["evidence"]>["stats"];
	payload: string;
	durationMs: number;
};

function assertEffectWasInjected(scenario: ScenarioEvidence): void {
	const { profile, stats } = scenario;
	if (profile.lossRate) expect(stats.dropped).toBeGreaterThan(0);
	if (profile.duplicateRate) expect(stats.duplicated).toBeGreaterThan(0);
	if (profile.reorderRate) expect(stats.reordered).toBeGreaterThan(0);
	if (profile.delayMs || profile.jitterMs)
		expect(stats.delayed).toBeGreaterThan(0);
	if (profile.burstLoss) expect(stats.burstDropped).toBeGreaterThan(0);
	if (profile.blackHole) expect(stats.blackHoled).toBeGreaterThan(0);
}

test("seeded UDP fault matrix recovers without privileged network mutation", async ({
	page,
}) => {
	await page.addInitScript({ content: BROWSER_READ_WITH_TIMEOUT_INIT_SCRIPT });
	await page.goto(resolveInteropHealthUrl());
	const sourceCommit =
		process.env.GITHUB_SHA ?? process.env.WT_CANDIDATE_SHA ?? "local-unbound";
	if (process.env.CI === "true") {
		expect(sourceCommit).not.toBe("local-unbound");
	}
	const evidence: {
		schemaVersion: number;
		status: "running" | "passed" | "failed";
		sourceCommit: string;
		startedAt: string;
		finishedAt?: string;
		scenarios: ScenarioEvidence[];
		error?: string;
	} = {
		schemaVersion: 1,
		status: "running",
		sourceCommit,
		startedAt: new Date().toISOString(),
		scenarios: [],
	};

	try {
		for (const profile of RELEASE_FAULT_PROFILES) {
			const started = Date.now();
			const proxy = new UdpFaultProxy({
				listenPort: proxyPort,
				upstreamPort,
				profile,
			});
			await proxy.start();
			try {
				const result = await page.evaluate(
					async ({ hash, port, profileName, blackHole }) => {
						const helpers = globalThis as typeof globalThis & {
							__wtReadWithTimeout?: <T>(
								reader: ReadableStreamDefaultReader<T>,
								timeoutMs: number,
								label: string,
							) => Promise<ReadableStreamReadResult<T>>;
							__wtWithTimeout?: <T>(
								promise: PromiseLike<T>,
								timeoutMs: number,
								label: string,
							) => Promise<T>;
						};
						const readWithTimeout = helpers.__wtReadWithTimeout;
						const withTimeout = helpers.__wtWithTimeout;
						if (!readWithTimeout || !withTimeout)
							throw new Error("bounded browser helpers missing");
						const value = Uint8Array.from(atob(hash), (char) =>
							char.charCodeAt(0),
						);
						const transport = new WebTransport(`https://127.0.0.1:${port}`, {
							serverCertificateHashes: [{ algorithm: "sha-256", value }],
						});
						await withTimeout(
							transport.ready,
							15_000,
							`fault matrix ${profileName} ready`,
						);

						const datagrams = transport.datagrams.writable.getWriter();
						const noise = new Uint8Array(900);
						for (let index = 0; index < 64; index += 1) {
							noise[0] = index;
							await datagrams.write(noise);
						}
						datagrams.releaseLock();
						if (blackHole) {
							await new Promise((resolve) => setTimeout(resolve, 800));
							const outageWriter = transport.datagrams.writable.getWriter();
							for (let index = 0; index < 20; index += 1) {
								await outageWriter.write(noise);
								await new Promise((resolve) => setTimeout(resolve, 20));
							}
							outageWriter.releaseLock();
							await new Promise((resolve) => setTimeout(resolve, 350));
						}

						const stream = await transport.createBidirectionalStream();
						const writer = stream.writable.getWriter();
						const reader = stream.readable.getReader();
						const payload = `fault-matrix-${profileName}`;
						await writer.write(new TextEncoder().encode(payload));
						await writer.close();
						const chunks: Uint8Array[] = [];
						for (;;) {
							const read = await readWithTimeout(
								reader,
								15_000,
								`fault matrix ${profileName} bidi read`,
							);
							if (read.done) break;
							if (read.value) chunks.push(read.value);
						}
						const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
						const joined = new Uint8Array(length);
						let offset = 0;
						for (const chunk of chunks) {
							joined.set(chunk, offset);
							offset += chunk.length;
						}
						transport.close({ closeCode: 4300, reason: "fault-matrix" });
						await withTimeout(
							transport.closed,
							15_000,
							`fault matrix ${profileName} closed`,
						);
						return new TextDecoder().decode(joined);
					},
					{
						hash: getCertHashBase64(),
						port: proxyPort,
						profileName: profile.name,
						blackHole: Boolean(profile.blackHole),
					},
				);
				const expected = `fault-matrix-${profile.name}`;
				expect(result).toBe(expected);
				const snapshot = proxy.engine.evidence();
				const scenario = {
					profile: { ...profile },
					stats: snapshot.stats,
					payload: result,
					durationMs: Date.now() - started,
				};
				assertEffectWasInjected(scenario);
				evidence.scenarios.push(scenario);
			} finally {
				proxy.close();
			}
		}
		evidence.status = "passed";
	} catch (error) {
		evidence.status = "failed";
		evidence.error =
			error instanceof Error ? (error.stack ?? error.message) : String(error);
		throw error;
	} finally {
		evidence.finishedAt = new Date().toISOString();
		await mkdir(resolve(evidencePath, ".."), { recursive: true });
		await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
	}

	expect(evidence.status).toBe("passed");
	expect(evidence.scenarios).toHaveLength(RELEASE_FAULT_PROFILES.length);
});
