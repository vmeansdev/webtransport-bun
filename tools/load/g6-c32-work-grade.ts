/** Online branch grading from raw artifacts. Stored PASS/MISS is never authority. */

import {
	evaluateCell,
	evaluateSessionScaleCell,
} from "./g6-c32-rca-evaluate.ts";
import { gradeSuccessorRung } from "./g6-c32-successor-grade.ts";
import type { WorkOutcome } from "./g6-c32-work-plan.ts";
import {
	type CapacityRawCellInput,
	validateCapacityRawCell,
} from "./g6-capacity-raw-cell.ts";
import { assertGeneratorDatagramDriver } from "./g6-datagram-driver.ts";
import { G6_SHARDED_CLAUSES } from "./g6-sharded-grade.ts";

export type WorkGradeInput = CapacityRawCellInput;
export type WorkGrade = {
	schema: "g6-c32-work-grade/1";
	nodeId: string;
	outcome: WorkOutcome;
	reasons: string[];
};
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("missing structured evidence");
	return value as RecordValue;
}

export function gradeWorkCell(input: WorkGradeInput): WorkGrade {
	const reasons: string[] = [];
	const { node, profile: p, scan } = input;
	try {
		const { diagnostic, report } = validateCapacityRawCell(input);
		if (p.datagramPump !== undefined) {
			// The arm's datagram read path must be the one both roles actually ran.
			if ((scan.config as RecordValue).datagramPump !== p.datagramPump)
				throw Error("scan datagramPump differs from the work profile");
			assertGeneratorDatagramDriver(report, p.datagramPump);
			const spawned = (
				scan.aggregate.lifetime?.metrics as RecordValue | undefined
			)?.datagramPumpsSpawned;
			if (
				typeof spawned !== "number" ||
				!Number.isSafeInteger(spawned) ||
				(p.datagramPump === "pump" ? spawned < 1 : spawned !== 0)
			)
				throw Error(
					"server datagram pump counters contradict the work profile",
				);
		}
		for (const field of [
			"udpSendBatchErrors",
			"udpSendBatchCongestionDropped",
			"datagramReflectRingDirectErrors",
		]) {
			if (
				scan.aggregate.lifetime?.metrics?.[field] !== 0 ||
				scan.shards.some(
					(shard) => shard.windows?.lifetime?.metrics?.[field] !== 0,
				)
			)
				throw Error(`unsafe output or missing ${field}`);
		}
		const qualityRequest = {
			rung: node.requestedSessions,
			scan,
			postRunSteeringText: input.postRunSteeringText,
			expectCandidate: input.expectCandidate,
			registrationSha256: input.registrationSha256,
			expectedEndpoints: p.endpoints,
			expectedConnectConcurrency: p.connectConcurrency,
			expectedConnectRate: p.connectRatePerSec,
			expectedFixedSourcePortBase: p.fixedSourcePortBase,
			expectedAckReflector: p.ackReflector,
			expectedServerWorkers: p.serverWorkers,
			expectedServerGro: p.serverGro,
			expectedServerRecvRuntime: p.serverRecvRuntime,
			expectedAckCadence: p.ackCadence,
			expectedServerUdpSendBufferBytes: p.serverUdpSendBufferBytes,
			expectedServerUdpSendEagainMode: p.serverUdpSendEagainMode,
			expectedReflectRingBypass: p.reflectRingBypass,
			expectedPacerPps: p.pacerPps,
			expectedUdpSendBatch: p.udpSendBatch,
		};
		const cell = evaluateCell({
			cell: node.label,
			gradeMode: p.gradeMode,
			expectedShards: p.shards,
			qualityRequest,
			diagnostic,
			probe: input.probe,
			probeRequired: p.detailedProbe,
		});
		const grade = gradeSuccessorRung({
			rung: node.requestedSessions,
			scan,
			postRunSteeringText: input.postRunSteeringText,
			expectCandidate: input.expectCandidate,
			registrationSha256: input.registrationSha256,
			profile: p,
		});
		if (!cell.complete || !grade.valid)
			throw Error([...cell.reasons, ...grade.invalidReasons].join("; "));
		if (
			Object.values(grade.clauses).some(
				(clause) => !Number.isFinite(clause.value),
			)
		)
			throw Error("quality clauses require finite arithmetic");
		if (!(cell.connectWallSec > 0))
			throw Error("connect wall time must be positive");
		let pass =
			grade.gate === "PASS" &&
			(node.kind !== "ladder" ||
				(cell.functionalPass && cell.ingressCleanPass));
		if (node.kind === "attribution-r4") {
			// r5 paired attribution: S1-S4 MISS (including delivery) is the
			// measured quantity and continues; only session loss stops the run.
			if (grade.clauses.S5_sessionsLost?.pass !== true)
				throw Error("attribution-r4 S5 session loss");
			if (
				report.sessionsErr !== 0 ||
				object(object(report.windows).steady).sessionsLost !== 0
			)
				throw Error("attribution-r4 lost sessions");
			// Host UDP counters are recorded pressure here, not INVALID, but they
			// must still be well-formed and monotonic evidence.
			for (const host of [diagnostic.serverHostUdp, report.hostUdp])
				for (const field of ["InErrors", "RcvbufErrors", "SndbufErrors"]) {
					const before = object(object(host).connect)[field],
						after = object(object(host).idle)[field];
					if (
						typeof before !== "number" ||
						typeof after !== "number" ||
						!Number.isSafeInteger(before) ||
						!Number.isSafeInteger(after) ||
						before < 0 ||
						after < before
					)
						throw Error("attribution-r4 malformed host UDP counters");
				}
		} else if (node.kind === "attribution") {
			if (
				Object.entries(grade.clauses).some(
					([key, clause]) => key !== "S4_ackRttP99Ms" && !clause.pass,
				)
			)
				throw Error("attribution has non-ACK unsafe loss/quality MISS");
			if (
				report.sessionsErr !== 0 ||
				object(object(report.windows).steady).sessionsLost !== 0
			)
				throw Error("attribution lost sessions");
			for (const host of [diagnostic.serverHostUdp, report.hostUdp])
				for (const field of ["InErrors", "RcvbufErrors", "SndbufErrors"]) {
					const before = object(object(host).connect)[field],
						after = object(object(host).idle)[field];
					if (
						typeof before !== "number" ||
						typeof after !== "number" ||
						!Number.isSafeInteger(before) ||
						!Number.isSafeInteger(after) ||
						before < 0 ||
						after < before ||
						(field !== "SndbufErrors" && after !== before)
					)
						throw Error("attribution unsafe host UDP loss");
					// SndbufErrors includes both retries and potentially silent ENOBUFS.
					// Retain it as ambiguous pressure; actual quality/error gates above
					// remain authority. Neither its sign nor its count proves delivery.
				}
		} else if (node.kind === "companion") {
			const scale = evaluateSessionScaleCell({
				label: node.label,
				scan,
				diagnostic,
				expectCandidate: input.expectCandidate,
				expectedShards: p.shards,
				expectedRequestedSessions: node.requestedSessions,
				expectedActiveWorkloadSessions: node.activeWorkloadSessions,
				probe: input.probe,
				probeRequired: p.detailedProbe,
			});
			if (!scale.complete || !scale.lifecycleClean)
				throw Error(
					scale.reasons.join("; ") || "companion lifecycle incomplete",
				);
			if (
				![scale.ingestRatio, scale.deliveryRatio, scale.dutyRatio].every(
					Number.isFinite,
				)
			)
				throw Error("companion ratios require finite arithmetic");
			pass =
				scale.sessionsOk === node.requestedSessions &&
				scale.sessionsErr === 0 &&
				scale.steadySessionsLost === 0 &&
				scale.hostClean &&
				scale.passiveJoinCount >=
					node.requestedSessions - node.activeWorkloadSessions &&
				scale.ingestRatio >= G6_SHARDED_CLAUSES.ingestFloor &&
				scale.deliveryRatio >= G6_SHARDED_CLAUSES.deliveryFloor &&
				scale.dutyRatio >= G6_SHARDED_CLAUSES.dutyFloor &&
				grade.clauses.S4_ackRttP99Ms?.pass === true;
		}
		return {
			schema: "g6-c32-work-grade/1",
			nodeId: node.id,
			outcome: pass ? "PASS" : "MISS",
			reasons,
		};
	} catch (error) {
		reasons.push(error instanceof Error ? error.message : String(error));
		return {
			schema: "g6-c32-work-grade/1",
			nodeId: node.id,
			outcome: "INVALID",
			reasons,
		};
	}
}
