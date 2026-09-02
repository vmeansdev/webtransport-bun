/**
 * Kill gate for the native ack reflector: the premise that the shard's JS
 * loop owns the ack tail stands only if reflecting natively cuts the
 * client-measured ack p99 to a quarter or less at the same load.
 *
 *   bun tools/load/g6-ack-reflector-gate.ts --js <scan.json> --native <scan.json> --out <gate.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { LatencyHistogram } from "./latency-histogram.ts";

export const ACK_REFLECTOR_GATE_THRESHOLD = 0.25;

export function gradeAckReflectorGate(jsP99Ms: number, nativeP99Ms: number) {
	if (
		!Number.isFinite(jsP99Ms) ||
		!Number.isFinite(nativeP99Ms) ||
		jsP99Ms <= 0 ||
		nativeP99Ms < 0
	) {
		throw new Error("ack reflector gate needs finite, positive p99 inputs");
	}
	const ratio = nativeP99Ms / jsP99Ms;
	return {
		schema: "g6-ack-reflector-gate/1" as const,
		jsP99Ms,
		nativeP99Ms,
		ratio,
		threshold: ACK_REFLECTOR_GATE_THRESHOLD,
		pass: ratio <= ACK_REFLECTOR_GATE_THRESHOLD,
	};
}

function ackP99Ms(scanPath: string): number {
	const scan = JSON.parse(readFileSync(scanPath, "utf8")) as {
		clientStdout: string;
	};
	const line = scan.clientStdout
		.split("\n")
		.find((l) => l.includes('"schema":"mmo-client/2"'));
	if (!line) throw new Error(`${scanPath}: no mmo-client/2 report`);
	const report = JSON.parse(line.slice(line.indexOf("{"))) as {
		windows: { steadyDrain: { rtt: unknown } };
	};
	const summary = LatencyHistogram.fromJson(
		report.windows.steadyDrain.rtt as never,
	).summary();
	if (summary.count === 0)
		throw new Error(`${scanPath}: empty ack RTT histogram`);
	return summary.p99Ns / 1e6;
}

function flag(name: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index === -1 ? undefined : process.argv[index + 1];
	if (!value) throw new Error(`--${name} is required`);
	return value;
}

if (import.meta.main) {
	try {
		const verdict = gradeAckReflectorGate(
			ackP99Ms(flag("js")),
			ackP99Ms(flag("native")),
		);
		writeFileSync(flag("out"), `${JSON.stringify(verdict, null, 2)}\n`);
		console.log(JSON.stringify(verdict));
		process.exit(verdict.pass ? 0 : 3);
	} catch (error) {
		console.error(String(error));
		process.exit(2);
	}
}
