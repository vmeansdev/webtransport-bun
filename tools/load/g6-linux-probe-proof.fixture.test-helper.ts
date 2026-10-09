/** Synthetic raw receipt for offline verifier tests, never live Linux evidence. */
import type { LinuxProbeProof } from "./g6-linux-probe-proof.ts";
export function linuxProbeProofFixture(input: {
	bootId: string;
	startedAt: string;
	finishedAt: string;
	proofSourceSha256: string;
	producerSha256: string;
	diagnosticSourceSha256: string;
}): LinuxProbeProof {
	const stat = (pid: number) =>
		`${pid} (target) ${["S", ...Array(18).fill("0"), "12345", ...Array(5).fill("0")].join(" ")}`;
	return {
		schema: "g6-linux-probe-proof/1",
		platform: "linux",
		arch: "x64",
		hostname: "fixture",
		...input,
		cases: ["mixed", "replace"].map((mode, index) => {
			const targetPid = 10001 + index * 2,
				probePid = targetPid + 1,
				shard = { pid: targetPid, serverId: 1, inodes: ["111"] };
			const measurementMode = { detail: "on", phaseAware: true };
			const rows: unknown[] = [
				{
					schema: "g6-c32-linux-probe-header/2",
					startedAt: input.startedAt,
					producerSha256: input.producerSha256,
					shards: [
						{
							...shard,
							socketMemory: {
								receiveBufferBytes: 229376,
								sendBufferBytes: 229376,
							},
						},
					],
					queueCadenceMs: 10,
					schedCadenceMs: 50,
					measurementMode,
					phaseOrder: ["connect", "steady", "drain", "idle"],
					clkTck: 100,
					probeCpuStart: { userJiffies: 1, systemJiffies: 1 },
				},
			];
			const phaseCoverage: Record<string, unknown> = {},
				phaseBoundaries: Record<string, unknown> = {};
			let stdout = "g6-linux-probe: ready\n";
			for (const [i, phase] of [
				"connect",
				"steady",
				"drain",
				"idle",
			].entries()) {
				const monotonicNs = String((i + 1) * 1000000),
					requestId = i + 1;
				phaseBoundaries[phase] = { monotonicNs, requestId };
				rows.push({
					schema: "g6-c32-linux-probe-phase/1",
					phase,
					monotonicNs,
					requestId,
				});
				stdout +=
					JSON.stringify({
						ev: "phase-ack",
						phase,
						requestId,
						monotonicNs,
						duplicate: false,
					}) + "\n";
				const queue = {
					schema: "g6-c32-linux-probe-queue/2",
					phase,
					monotonicNs: String((i + 1) * 1000000 + 1),
					shards: [
						{
							...shard,
							socketCount: index && i >= 2 ? 0 : 1,
							...(index && i >= 2
								? {}
								: { udp4SocketCount: 1, udp6SocketCount: 0 }),
							txQueueBytes: index && i >= 2 ? 0 : 10,
							rxQueueBytes: index && i >= 2 ? 0 : 20,
							drops: index && i >= 2 ? 0 : 3,
						},
					],
				};
				rows.push(queue);
				rows.push({
					schema: "g6-c32-linux-probe-sched/2",
					netRx: 1,
					softnet: { processed: 1, dropped: 0, timeSqueeze: 0 },
					load1: 0,
					procsRunning: 1,
					phase,
					monotonicNs: String((i + 1) * 1000000 + 1),
					sched: [
						{
							pid: targetPid,
							serverId: 1,
							runtimeNs: 1,
							waitNs: 0,
							timeslices: 1,
						},
					],
				});
				for (let extra = 2; extra <= 5; extra++)
					rows.push({
						...queue,
						monotonicNs: String((i + 1) * 1000000 + extra),
					});
				phaseCoverage[phase] = { queueSamples: 5, schedSamples: 1 };
			}
			rows.push({
				schema: "g6-c32-linux-probe/2",
				endedAt: input.finishedAt,
				monotonicNs: "5000000",
				artifactBytes: Buffer.byteLength(
					rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
				),
				producerSha256: input.producerSha256,
				complete: index === 0,
				truncated: false,
				phaseCoverage,
				phaseBoundaries,
				queueCadenceMs: 10,
				schedCadenceMs: 50,
				measurementMode,
				queueSamples: 20,
				schedSamples: 4,
				childExit: { code: index === 0 ? 0 : 2, signal: null },
				probeCpuEnd: { userJiffies: 2, systemJiffies: 2 },
				summary: {
					peakReceiveQueueBytes: 20,
					peakDrops: 3,
					pressureAlignments: 0,
					drainStallAligned: false,
					peakProcsRunning: 1,
					peakLoad1: 0,
					effectiveReceiveBufferBytes: 229376,
					effectiveSendBufferBytes: 229376,
					clkTck: 100,
					probeUserSec: 0.01,
					probeSysSec: 0.01,
				},
				historicalConnectSummary: {
					peakReceiveQueueBytes: 20,
					peakDrops: 3,
					queueSamples: 5,
					schedSamples: 1,
					pressureAlignments: 0,
					drainStallAligned: false,
				},
				problems: index
					? [
							"server 1 socket sample failed: frozen process/UDP socket identity changed",
						]
					: [],
			});
			return {
				mode: mode as "mixed" | "replace",
				targetPid,
				probePid,
				genericInodes: ["111", "900", "901"],
				stdout,
				stderr: "",
				raw: rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
				exitCode: index ? 2 : 0,
				targetAbsent: true,
				probeAbsent: true,
				targetBeforeStat: stat(targetPid),
				targetAfterStat: stat(targetPid),
				replacementInodes: index ? ["222"] : [],
			};
		}),
	};
}
