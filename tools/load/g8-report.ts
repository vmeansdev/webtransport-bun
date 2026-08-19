#!/usr/bin/env bun
/**
 * Read a `bench-g8.json` artifact and print the verdict every clause and
 * falsifier computes from it.
 *
 * It runs **off the runner**, on the artifact alone. That is the point: the
 * conductor records raw fields and decides nothing, and whoever stamps the gate
 * recomputes the verdict here rather than trusting a number the run printed
 * about itself. Feed it a fragment from any machine and it produces the same
 * answer.
 *
 *     bun tools/load/g8-report.ts tools/load/bench-g8.json
 */

import {
	type ArmVerdict,
	armVerdict,
	type RungRecord,
	rollUp,
} from "./g8-classify.ts";
import { isG8Arm } from "./g8-plan.ts";

type Artifact = { rungs: Array<RungRecord & Record<string, unknown>> };

function ms(ns: number): string {
	return `${(ns / 1e6).toFixed(3)} ms`;
}

export function readArms(artifact: Artifact): ArmVerdict[] {
	const byArm = new Map<string, RungRecord[]>();
	for (const rung of artifact.rungs) {
		if (!isG8Arm(rung.arm)) continue;
		const rec: RungRecord = {
			arm: rung.arm,
			rooms: rung.rooms,
			driveWindowSec: rung.driveWindowSec,
			roomRecords: rung.roomRecords,
			publisherRecords: rung.publisherRecords,
			conductor: rung.conductor,
			precheck: rung.precheck,
		};
		byArm.set(rung.arm, [...(byArm.get(rung.arm) ?? []), rec]);
	}
	return [...byArm].map(([arm, rungs]) =>
		armVerdict(isG8Arm(arm) ? arm : "voice", rungs),
	);
}

async function main(): Promise<void> {
	const path = process.argv[2];
	if (path === undefined) {
		console.error("usage: bun tools/load/g8-report.ts <bench-g8.json>");
		process.exit(2);
	}
	const artifact = JSON.parse(await Bun.file(path).text()) as Artifact;
	const arms = readArms(artifact);
	const verdict = rollUp(arms);

	console.log(`G8 ${verdict.status}`);
	console.log("");
	for (const arm of arms) {
		console.log(`## arm ${arm.arm}`);
		for (const rung of arm.rungs) {
			const flags = rung.complete
				? rung.pass
					? "PASS"
					: "MISS"
				: `INVALID [${rung.invalidReasons.join(", ")}]`;
			console.log(
				`  M=${rung.rooms}  ${flags}` +
					`  p99 ${ms(rung.aggregateOneWayP99Ns)} / bound ${ms(rung.plan.boundNs)}` +
					`  delivery ${rung.aggregateForwardDelivery?.toFixed(5) ?? "null"}` +
					`  rooms failing p99 ${rung.roomsFailingP99.length}/${rung.plan.rooms} (tol ${rung.plan.roomTolerance})` +
					`  delivery ${rung.roomsFailingDelivery.length}` +
					`  handlerToForward p99 ${(rung.handlerToForwardP99Ns / 1e3).toFixed(2)} µs` +
					`  loop lag p99 ${ms(rung.conductorLagP99Ns)}` +
					`  precheck ${rung.precheckOutcome}`,
			);
			if (!rung.clauses.c1) console.log("    C1 aggregate delivery: MISS");
			if (!rung.clauses.c1b) console.log("    C1b rooms out of spec: MISS");
			if (!rung.clauses.c2) console.log("    C2 aggregate tail: MISS");
			if (!rung.clauses.c2b) console.log("    C2b rooms out of spec: MISS");
		}
		const s = arm.scaling;
		console.log(
			`  C3 M-scaling: ${s.outcome}` +
				(s.spreadNs === null
					? ""
					: ` (spread ${ms(s.spreadNs)} vs band ${ms(s.bandNs ?? 0)})`) +
				`  — no expected form was registered; this is a description.`,
		);
		if (arm.handlerGrowth.fired) {
			console.log(
				`  V-H(b) FIRED: handlerToForward p99 grew ${arm.handlerGrowth.ratio?.toFixed(2)}x from M=${arm.handlerGrowth.lowRooms} to M=${arm.handlerGrowth.highRooms}`,
			);
		}
		console.log(`  C4 room count: ${arm.roomCount ?? "none"}`);
		console.log("");
	}

	console.log("## room counts, per arm, never combined");
	for (const c of verdict.roomCounts) {
		console.log(`  ${c.arm}: ${c.rooms ?? "none"} — ${c.shape}`);
	}
	if (verdict.notes.length > 0) {
		console.log("");
		console.log("## notes");
		for (const n of verdict.notes) console.log(`  - ${n}`);
	}
}

if (import.meta.main) await main();
