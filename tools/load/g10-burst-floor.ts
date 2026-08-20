/**
 * The machine-readable path from the burst probe to V-SP.
 *
 * Amendment 4 rewrote V-SP around `tools/offbox/burst-probe.ts` and stopped
 * there: the probe printed JSON to stdout, nothing wrote it down, and
 * `spreadFloorFalsifier` had no caller outside its own unit test. The gate
 * would then have graded C1 — its headline clause — against the 119.91 ms
 * bound with the Mac sink's own dispersion folded into the number, which is
 * precisely the G3b defect the amendment cites as its motivation.
 *
 * This module is the missing link, and it is deliberately pure: it takes two
 * already-parsed artifacts and returns the facts `spreadFloorFalsifier` grades.
 * Anything absent, unparseable or non-finite becomes `null`, and `null` fires
 * the falsifier — an unmeasured sink is never a cleared sink.
 */

import type { PrecheckFacts } from "./g10-classify.ts";

export type BurstFloorFacts = PrecheckFacts & {
	burstDrainMaxMs: number | null;
	burstEmitNetMaxMs: number | null;
	burstEmitMaxMs: number | null;
	burstCompletenessMin: number | null;
};

/** A finite number, or `null`. `percentile()` of an empty sample is NaN. */
function finite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Fold the recv and send artifacts into V-SP's facts.
 *
 * The **recv** artifact carries the provenance, because the sink is the host
 * whose drain the falsifier is about: its `date` and `host` are what
 * `sameDayOnExpectedHost` checks. A missing recv artifact therefore reads as
 * "no artifact" and fires, which is the behaviour the gate needs on a day when
 * no burst probe ran.
 */
export function burstFloorFacts(input: {
	recv: unknown;
	send: unknown;
	runDate: string;
	expectedHost: string;
}): BurstFloorFacts {
	const recv = (input.recv ?? null) as Record<string, unknown> | null;
	const send = (input.send ?? null) as Record<string, unknown> | null;
	return {
		artifactDate: recv ? str(recv.date) : null,
		runDate: input.runDate,
		host: recv ? str(recv.host) : null,
		expectedHost: input.expectedHost,
		// Amendment 5: the drain is the worst burst, and the emission the sender's
		// own work net of its backoff sleeps. An artifact written before the
		// amendment carries neither field, so it reads as null and fires — which
		// is right: V-SP's ceiling is not computable from a pre-amendment probe.
		burstDrainMaxMs: recv ? finite(recv.drainMsMax) : null,
		burstEmitNetMaxMs: send ? finite(send.emitMsNetMax) : null,
		burstEmitMaxMs: send ? finite(send.emitMsMax) : null,
		burstCompletenessMin: recv ? finite(recv.completenessMin) : null,
	};
}
