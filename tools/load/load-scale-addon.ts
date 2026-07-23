#!/usr/bin/env bun

import { resolve } from "node:path";

import { runScaleCampaign } from "./distributed-scale.ts";

async function main() {
	const summary = await runScaleCampaign({
		label: process.env.LOAD_SCALE_LABEL ?? "load-scale-addon",
		sessions: Number(process.env.LOAD_SCALE_SESSIONS ?? "200"),
		durationSec: Number(process.env.LOAD_SCALE_DURATION ?? "30"),
		serverCount: Number(process.env.LOAD_SCALE_SERVER_COUNT ?? "1"),
		clientCount: Number(process.env.LOAD_SCALE_CLIENT_COUNT ?? "1"),
		basePort: Number(process.env.LOAD_SCALE_BASE_PORT ?? "4433"),
		datagramsPerSec: Number(process.env.LOAD_SCALE_DATAGRAMS_PER_SEC ?? "1000"),
		streamsPerSec: Number(process.env.LOAD_SCALE_STREAMS_PER_SEC ?? "5"),
		minSuccessRate: Number(process.env.LOAD_SCALE_MIN_SUCCESS_RATE ?? "1"),
		maxRssMb: Number(process.env.LOAD_SCALE_MAX_RSS_MB ?? "768"),
		maxRecoveryRssRatio: Number(
			process.env.LOAD_SCALE_MAX_RECOVERY_RSS_RATIO ?? "1.25",
		),
		maxFairnessGap: Number(process.env.LOAD_SCALE_MAX_FAIRNESS_GAP ?? "0.05"),
		p99HandshakeMs: Number(process.env.LOAD_SCALE_P99_HANDSHAKE_MS ?? "300"),
		p99DatagramEnqueueMs: Number(
			process.env.LOAD_SCALE_P99_DATAGRAM_MS ?? "10",
		),
		p99StreamOpenMs: Number(process.env.LOAD_SCALE_P99_STREAM_OPEN_MS ?? "20"),
		minLiveSessions: Number(process.env.LOAD_SCALE_MIN_LIVE_SESSIONS ?? "180"),
		minLiveSetHoldMs: Number(
			process.env.LOAD_SCALE_MIN_LIVE_SET_HOLD_MS ?? "1000",
		),
		minSourceIdentityCount: Number(
			process.env.LOAD_SCALE_MIN_SOURCE_IDENTITIES ?? "1",
		),
		overloadSessionsPerServer: Number(
			process.env.LOAD_SCALE_OVERLOAD_SESSIONS_PER_SERVER ?? "32",
		),
		overloadRecoveryTimeoutMs: Number(
			process.env.LOAD_SCALE_OVERLOAD_RECOVERY_TIMEOUT_MS ?? "15000",
		),
		artifactPath:
			process.env.LOAD_SCALE_ARTIFACT_OUT ??
			resolve(process.cwd(), ".release-evidence/load/load-scale-artifact.json"),
	});

	console.log(JSON.stringify(summary, null, 2));
	if (summary.failures.length > 0) {
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
