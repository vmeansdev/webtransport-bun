/** Synthetic raw probe records for parser/evaluator tests, never live proof. */
export function linuxProbeFixture(shardCount = 1) {
	const phases = ["connect", "steady", "drain", "idle"] as const;
	const rows: Record<string, any>[] = [
		{
			schema: "g6-c32-linux-probe-header/2",
			startedAt: "2026-09-04T00:00:00.000Z",
			queueCadenceMs: 10,
			schedCadenceMs: 50,
			measurementMode: { detail: "on", phaseAware: true },
			producerSha256: "a".repeat(64),
			phaseOrder: phases,
			clkTck: 100,
			probeCpuStart: { userJiffies: 20, systemJiffies: 3 },
			shards: [
				{
					serverId: 1,
					pid: 101,
					inodes: ["111"],
					socketMemory: {
						receiveBufferBytes: 212_992,
						sendBufferBytes: 212_992,
					},
				},
			],
		},
	];
	const boundaries: Record<string, unknown> = {};
	const coverage: Record<string, unknown> = {};
	for (const [i, phase] of phases.entries()) {
		const start = 100_000_000 + i * 50_000_000;
		boundaries[phase] = { monotonicNs: String(start), requestId: i + 1 };
		coverage[phase] = { queueSamples: 5, schedSamples: 1 };
		rows.push({
			schema: "g6-c32-linux-probe-phase/1",
			phase,
			...(boundaries[phase] as object),
		});
		for (let tick = 0; tick < 5; tick++) {
			const monotonicNs = String(start + 5_000_000 + tick * 10_000_000);
			rows.push({
				schema: "g6-c32-linux-probe-queue/2",
				phase,
				monotonicNs,
				shards: [
					{
						serverId: 1,
						pid: 101,
						inodes: ["111"],
						socketCount: 1,
						udp4SocketCount: 1,
						udp6SocketCount: 0,
						txQueueBytes: 0,
						rxQueueBytes: [5, 9, 7, 1][i],
						drops: [0, 1, 2, 2][i],
					},
				],
			});
			if (tick === 0)
				rows.push({
					schema: "g6-c32-linux-probe-sched/2",
					phase,
					monotonicNs,
					netRx: 10 + i,
					softnet: { processed: 10 + i, dropped: 0, timeSqueeze: 0 },
					sched: [
						{
							serverId: 1,
							pid: 101,
							runtimeNs: 11 + i,
							waitNs: 1 + i,
							timeslices: 1 + i,
						},
					],
					load1: [0.1, 0.2, 0.2, 0.1][i],
					procsRunning: [1, 2, 2, 1][i],
				});
		}
	}
	rows.push({
		schema: "g6-c32-linux-probe/2",
		complete: true,
		endedAt: "2026-09-04T00:00:00.200Z",
		monotonicNs: "300000000",
		queueCadenceMs: 10,
		schedCadenceMs: 50,
		queueSamples: 20,
		schedSamples: 4,
		artifactBytes: 0,
		truncated: false,
		measurementMode: { detail: "on", phaseAware: true },
		producerSha256: "a".repeat(64),
		childExit: { code: 0, signal: null },
		problems: [],
		phaseBoundaries: boundaries,
		phaseCoverage: coverage,
		probeCpuEnd: { userJiffies: 30, systemJiffies: 4 },
		summary: {
			peakReceiveQueueBytes: 9,
			peakDrops: 2,
			effectiveReceiveBufferBytes: 212_992,
			effectiveSendBufferBytes: 212_992,
			drainStallAligned: true,
			pressureAlignments: 2,
			probeUserSec: 0.1,
			probeSysSec: 0.01,
			peakProcsRunning: 2,
			peakLoad1: 0.2,
			clkTck: 100,
		},
		historicalConnectSummary: {
			peakReceiveQueueBytes: 5,
			peakDrops: 0,
			queueSamples: 5,
			schedSamples: 1,
			pressureAlignments: 0,
			drainStallAligned: false,
		},
	});
	if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 64)
		throw new Error("fixture requires 1..64 shards");
	for (const row of rows) {
		for (const field of ["shards", "sched"]) {
			if (!Array.isArray(row[field])) continue;
			const template = row[field][0];
			row[field] = Array.from({ length: shardCount }, (_, index) => ({
				...structuredClone(template),
				serverId: index + 1,
				pid: 101 + index,
				...(template.inodes ? { inodes: [String(111 + index)] } : {}),
			}));
		}
	}
	for (const field of ["summary", "historicalConnectSummary"]) {
		rows.at(-1)![field].peakReceiveQueueBytes *= shardCount;
		rows.at(-1)![field].peakDrops *= shardCount;
	}
	return rows;
}

export function linuxProbeFixtureText(rows = linuxProbeFixture()): string {
	// The producer's artifactBytes is the byte count immediately before its footer.
	let bytes = 0;
	return rows
		.map((row) => {
			const encoded =
				JSON.stringify(
					row.schema === "g6-c32-linux-probe/2"
						? { ...row, artifactBytes: bytes }
						: row,
				) + "\n";
			bytes += Buffer.byteLength(encoded);
			return encoded;
		})
		.join("");
}
