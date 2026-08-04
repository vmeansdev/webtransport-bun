import { runScaleCampaign } from "./distributed-scale.ts";

const summary = await runScaleCampaign({
	label: process.env.LOAD_SCALE_LABEL ?? "rss-hold",
	sessions: Number(process.env.LOAD_SCALE_SESSIONS ?? "200"),
	durationSec: Number(process.env.LOAD_SCALE_DURATION ?? "5"),
	serverCount: 1,
	clientCount: 1,
	basePort: Number(process.env.LOAD_SCALE_BASE_PORT ?? "5400"),
	datagramsPerSec: 0,
	streamsPerSec: Number(process.env.LOAD_SCALE_STREAMS_PER_SEC ?? "5"),
	workloadMode: (process.env.LOAD_SCALE_WORKLOAD_MODE ?? "drain-all") as
		| "probe"
		| "drain-all"
		| "single-reader",
	minDeliveryRatio: 0.01,
	minSuccessRate: 0.01,
	maxRssMb: 4096,
	maxRecoveryRssRatio: 100,
	maxFairnessGap: 1,
	p99HandshakeMs: 100000,
	p99DatagramEnqueueMs: 100000,
	p99StreamOpenMs: 100000,
	minLiveSessions: 1,
	minLiveSetHoldMs: 1,
	minSourceIdentityCount: 1,
	overloadSessionsPerServer: 1,
	overloadRecoveryTimeoutMs: 1000,
	artifactPath:
		process.env.LOAD_SCALE_ARTIFACT_OUT ?? "/private/tmp/rss-hold.json",
});
console.log(JSON.stringify(summary));
await Bun.sleep(Number(process.env.LOAD_SCALE_HOLD_MS ?? "60000"));
