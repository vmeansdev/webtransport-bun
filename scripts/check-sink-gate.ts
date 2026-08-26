/**
 * Sink latency gate check (RFC_STREAM_SINK §9.4), run by the bench-bandwidth
 * workflow's sink_gate mode. Reads the saturated bench-sink JSON and holds
 * the sink path to the RFC envelope: app-observed p99 at or under 5 ms at
 * the dispatched saturation level. The facade numbers are printed for the
 * comparison record but are not gated — the facade is EXPECTED to degrade.
 */

const idlePath = process.env.IDLE_JSON;
const satPath = process.env.SAT_JSON;
if (!satPath) {
	console.error("check-sink-gate: SAT_JSON is required");
	process.exit(2);
}

type BenchRow = {
	mode: string;
	saturatePct: number;
	samples: number;
	latencyMs: { p50: number; p90: number; p99: number; max: number };
};

const sat = (await Bun.file(satPath).json()) as BenchRow[];
const idle = idlePath ? ((await Bun.file(idlePath).json()) as BenchRow[]) : [];
const row = (rows: BenchRow[], mode: string) =>
	rows.find((r) => r.mode === mode);

for (const [label, rows] of [
	["idle", idle],
	["saturated", sat],
] as const) {
	for (const mode of ["facade", "sink"]) {
		const r = row(rows, mode);
		if (r) {
			console.log(
				`${label} ${mode}: p50=${r.latencyMs.p50.toFixed(2)}ms p90=${r.latencyMs.p90.toFixed(2)}ms p99=${r.latencyMs.p99.toFixed(2)}ms max=${r.latencyMs.max.toFixed(2)}ms samples=${r.samples}`,
			);
		}
	}
}

const sink = row(sat, "sink");
if (!sink) {
	console.error("check-sink-gate: no saturated sink row");
	process.exit(2);
}
if (sink.samples < 1000) {
	console.error(
		`check-sink-gate: FAIL — only ${sink.samples} saturated sink samples`,
	);
	process.exit(1);
}
if (sink.latencyMs.p99 > 5) {
	console.error(
		`check-sink-gate: FAIL — saturated sink p99 ${sink.latencyMs.p99.toFixed(2)}ms exceeds the 5ms envelope`,
	);
	process.exit(1);
}
console.log(
	`check-sink-gate: PASS — saturated sink p99 ${sink.latencyMs.p99.toFixed(2)}ms within the 5ms envelope`,
);
