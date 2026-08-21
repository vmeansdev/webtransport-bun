/**
 * Gate G10's three emitter arms (§2), and §6.6a's stall instrument, over an
 * injected transport.
 *
 * The arms are the only part of this gate that is a *product* statement rather
 * than an arithmetic one, so they are the part most worth being able to test
 * without a cable, a Mac, or ten thousand sessions. Everything the arms depend
 * on — the send, the mirror entry point, the clock, the yield — arrives through
 * {@link EmitterTransport}, so `g10-emitter.test.ts` can drive a 10,000-target
 * broadcast in microseconds and assert the things that actually differ between
 * the arms: how often each one yields, how long each one holds the JS thread in
 * one uninterrupted span, and how each one's failures land in the ledger.
 *
 * The conductor supplies the real implementations. Nothing in this module
 * imports the product.
 */

import {
	A2_CHUNK_TARGETS,
	DATAGRAM_MIRROR_MAX,
	mirrorCapAgreesWithProduct,
} from "./g10-plan";

export type ArmId = "A1" | "A2" | "A3";

/** What one per-target send did. Mirrors the non-parking send's own outcomes. */
export type SendOutcome = "ok" | "would-block" | "error";

/** One target the mirror call did not deliver to. */
export type MirrorFailure = {
	index: number;
	/** `E_QUEUE_FULL` is backpressure; `E_SESSION_CLOSED` is a reaped target. */
	code: string;
};

/** M1's failures-only envelope, as the arm consumes it. */
export type MirrorEnvelope = {
	sent: number;
	failures: readonly MirrorFailure[];
};

/**
 * `sendDatagramMirrorPaced`'s envelope, as the arm consumes it.
 *
 * `admitted` is a schedule acceptance, not a delivery — nothing about a target
 * has been examined when the call returns. `refused` is admission backpressure
 * (the schedule was already holding its bound) and is a different signal from
 * the `E_QUEUE_FULL` reports that arrive later through {@link
 * EmitterTransport.readMirrorReports}.
 */
export type MirrorAdmission = {
	admitted: number;
	refused: readonly MirrorFailure[];
};

/** One deferred per-target failure, drained out of band after the pass. */
export type MirrorReportOutcome = {
	/** `E_QUEUE_FULL` (no byte budget at its turn) or `E_SESSION_CLOSED`. */
	code: string;
};

export interface EmitterTransport {
	/**
	 * A1 and A2's per-target send: the landed promise-free `trySendDatagram`
	 * fast path. Synchronous by contract — an arm that awaited here would be
	 * measuring the parking path, which is not what any of these arms are.
	 */
	trySend(target: string, payload: Uint8Array): SendOutcome;

	/**
	 * A3's one crossing, when the composed candidate has it (§11.1). Absent
	 * means composition option C, and the arm simply does not run.
	 */
	sendMirror?(targets: readonly string[], payload: Uint8Array): MirrorEnvelope;

	/**
	 * A3's one crossing in a **paced** cell.
	 *
	 * Present only when the composition ships `sendDatagramMirrorPaced` and the
	 * pacer knob is on. When it is present A3 takes it and never the synchronous
	 * entry: on the Candidate-C surface the pacer no longer lives inside
	 * `sendDatagramMirror`, so a paced cell that fell back to the sync path would
	 * produce an artifact with a `pacerStats` block full of zeroes and no way to
	 * tell it from a control.
	 */
	sendMirrorPaced?(
		targets: readonly string[],
		payload: Uint8Array,
	): MirrorAdmission;

	/**
	 * Drain the bounded reports ring. Failures only, oldest first; an empty
	 * result means nothing is pending.
	 */
	readMirrorReports?(max?: number): readonly MirrorReportOutcome[];

	/** The product's own `DATAGRAM_MIRROR_MAX`, when the entry point resolves. */
	mirrorCap?: number;

	/** Monotonic nanoseconds. Injected so a test can hold the clock still. */
	nowNs(): bigint;

	/** A2's yield between chunks. The whole difference between A2 and A1. */
	yieldToLoop(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Arm resolution (§2.3 / §11.1)                                              */
/* -------------------------------------------------------------------------- */

export type ArmResolution = {
	arms: ArmId[];
	dropped: ArmId[];
	/** Non-empty when an arm was asked for and could not be supplied. */
	warnings: string[];
};

/**
 * §2.3. A3 is optional *by construction*: the harness asks the candidate at
 * start-up and degrades to two arms if the mirror is not there.
 *
 * It never throws. A missing lever is a composition outcome (§11.1 option C),
 * not a harness fault, and a gate that refused to run without its optional arm
 * would have made the lever a blocker — which is exactly the inversion the
 * anti-inflation rule exists to prevent.
 */
export function resolveArms(
	requested: readonly ArmId[],
	transport: EmitterTransport,
): ArmResolution {
	const arms: ArmId[] = [];
	const dropped: ArmId[] = [];
	const warnings: string[] = [];
	for (const arm of requested) {
		if (
			arm === "A3" &&
			typeof transport.sendMirror !== "function" &&
			typeof transport.sendMirrorPaced !== "function"
		) {
			dropped.push(arm);
			warnings.push(
				"A3 requested but the candidate exposes no sendDatagramMirror; " +
					"running as a two-arm gate (prereg §2.3, composition option C)",
			);
			continue;
		}
		arms.push(arm);
	}
	if (
		arms.includes("A3") &&
		transport.mirrorCap !== undefined &&
		!mirrorCapAgreesWithProduct(transport.mirrorCap)
	) {
		// Not a drop: the arm still runs. But §1.11's whole derivation rests on
		// the cap being 10,000, so a disagreement has to reach the artifact
		// rather than be absorbed silently.
		warnings.push(
			`the candidate's mirror cap is ${transport.mirrorCap}, not ` +
				`${DATAGRAM_MIRROR_MAX}; §1.11's stall derivation was registered ` +
				"against the latter and the run must disclose the difference",
		);
	}
	return { arms, dropped, warnings };
}

/* -------------------------------------------------------------------------- */
/* One broadcast                                                              */
/* -------------------------------------------------------------------------- */

export type BroadcastResult = {
	arm: ArmId;
	/** Targets the arm attempted. C5 reads this against `broadcasts × fleet`. */
	attempts: number;
	ok: number;
	wouldBlock: number;
	errors: number;
	/**
	 * §6.6a. The longest **uninterrupted** span the emitter held the JS thread
	 * during this broadcast — A1's whole pass, A2's worst chunk, A3's one call.
	 * This is what C7 reads; a mean over chunks would let A2's own yields
	 * flatter it.
	 */
	stallNs: bigint;
	/** Spans the arm took. 1 for A1 and A3; ceil(fleet/256) for A2. */
	spans: number;
	/**
	 * Additive, paced-A3 only. Which mirror entry the arm took, and the
	 * admission split it came back with. Absent on every other arm and on the
	 * synchronous mirror, so an artifact from a control cell reads exactly as it
	 * did before.
	 */
	pacedApi?: "sendDatagramMirrorPaced";
	pacedAdmitted?: number;
	pacedRefused?: number;
};

function emptyResult(arm: ArmId): BroadcastResult {
	return {
		arm,
		attempts: 0,
		ok: 0,
		wouldBlock: 0,
		errors: 0,
		stallNs: 0n,
		spans: 0,
	};
}

function tally(result: BroadcastResult, outcome: SendOutcome): void {
	result.attempts += 1;
	if (outcome === "ok") result.ok += 1;
	else if (outcome === "would-block") result.wouldBlock += 1;
	else result.errors += 1;
}

/**
 * A1 — the tight per-target loop. One pass over every target, no yield inside
 * it, so the span is the pass and the loop is held for its whole duration.
 */
export function broadcastA1(
	targets: readonly string[],
	payload: Uint8Array,
	transport: EmitterTransport,
): BroadcastResult {
	const result = emptyResult("A1");
	const started = transport.nowNs();
	for (const target of targets)
		tally(result, transport.trySend(target, payload));
	result.stallNs = transport.nowNs() - started;
	result.spans = 1;
	return result;
}

/**
 * A2 — the same pass cut into 256-target chunks with a yield between them.
 *
 * 256 is the datagram-batch machinery's own chunk size and K14's boundary. The
 * arm differs from A1 in yield discipline alone, which is precisely the variable
 * the RTT clause is sensitive to: a server that will not yield for 3.4 ms cannot
 * also be an ingest path.
 */
export async function broadcastA2(
	targets: readonly string[],
	payload: Uint8Array,
	transport: EmitterTransport,
	chunkSize = A2_CHUNK_TARGETS,
): Promise<BroadcastResult> {
	const result = emptyResult("A2");
	const size = Math.max(1, chunkSize);
	for (let start = 0; start < targets.length; start += size) {
		const end = Math.min(start + size, targets.length);
		const spanStart = transport.nowNs();
		for (let i = start; i < end; i += 1) {
			tally(result, transport.trySend(targets[i] as string, payload));
		}
		const span = transport.nowNs() - spanStart;
		if (span > result.stallNs) result.stallNs = span;
		result.spans += 1;
		if (end < targets.length) await transport.yieldToLoop();
	}
	return result;
}

/**
 * A3 — one `sendDatagramMirror` call over the whole fleet.
 *
 * The over-cap check is the product's own behaviour reproduced deliberately
 * rather than delegated: the TS wrapper throws `RangeError` above the cap
 * instead of chunking, and §2.3 registers a chunked mirror as a *different arm*.
 * Silently splitting here would substitute that different arm for this one and
 * nothing downstream would be able to tell.
 *
 * Failures are folded into the ledger and **not retried inside the arm** — a
 * retry would make A3 a different emitter from A1 and A2, and C5 would then be
 * comparing a persistent sender against two non-persistent ones.
 */
function assertUnderCap(
	targets: readonly string[],
	transport: EmitterTransport,
): void {
	const cap = transport.mirrorCap ?? DATAGRAM_MIRROR_MAX;
	if (targets.length > cap) {
		throw new RangeError(
			`A3 cannot mirror ${targets.length} targets past the ${cap} cap; a ` +
				"chunked mirror is a different arm (prereg §2.3)",
		);
	}
}

export function broadcastA3(
	targets: readonly string[],
	payload: Uint8Array,
	transport: EmitterTransport,
): BroadcastResult {
	const sendMirror = transport.sendMirror;
	if (!sendMirror) {
		throw new Error(
			"A3 ran without a mirror entry point; resolveArms missed it",
		);
	}
	assertUnderCap(targets, transport);
	const result = emptyResult("A3");
	const started = transport.nowNs();
	const envelope = sendMirror.call(transport, targets, payload);
	result.stallNs = transport.nowNs() - started;
	result.spans = 1;
	result.attempts = targets.length;
	result.ok = envelope.sent;
	for (const failure of envelope.failures) {
		if (failure.code === "E_QUEUE_FULL") result.wouldBlock += 1;
		else result.errors += 1;
	}
	return result;
}

/**
 * A3 in a paced cell — one `sendDatagramMirrorPaced` call over the whole fleet.
 *
 * The same arm as {@link broadcastA3} in shape (one crossing, one span, no
 * retry) and deliberately different in what it can claim. The paced envelope
 * carries no delivery count, so `ok` here is **admission** — targets the
 * schedule accepted — and `wouldBlock` is admission refusal. That is exactly
 * what the old in-`sendDatagramMirror` pacer's `sent` meant, so the ledger
 * fields keep the meaning the sweep's artifacts gave them.
 *
 * What the arm cannot see at the call — a target that had no byte budget when
 * its turn came, or had gone away — arrives later through
 * `readMirrorReports()`. The conductor drains that ring; folding it in here
 * would put an out-of-band cost inside the span C7 reads.
 */
export function broadcastA3Paced(
	targets: readonly string[],
	payload: Uint8Array,
	transport: EmitterTransport,
): BroadcastResult {
	const sendMirrorPaced = transport.sendMirrorPaced;
	if (!sendMirrorPaced) {
		throw new Error(
			"A3 ran the paced path without a paced mirror entry point; resolveArms missed it",
		);
	}
	assertUnderCap(targets, transport);
	const result = emptyResult("A3");
	const started = transport.nowNs();
	const admission = sendMirrorPaced.call(transport, targets, payload);
	result.stallNs = transport.nowNs() - started;
	result.spans = 1;
	result.attempts = targets.length;
	result.ok = admission.admitted;
	// Every admission refusal is `E_QUEUE_FULL` by construction: the schedule
	// was holding its bound. It is backpressure, so it lands in `wouldBlock`
	// beside A1's and A2's, never in `errors`.
	result.wouldBlock = admission.refused.length;
	result.pacedApi = "sendDatagramMirrorPaced";
	result.pacedAdmitted = admission.admitted;
	result.pacedRefused = admission.refused.length;
	return result;
}

/** Dispatch by arm, so the conductor holds one call site and no branch. */
export async function broadcast(
	arm: ArmId,
	targets: readonly string[],
	payload: Uint8Array,
	transport: EmitterTransport,
): Promise<BroadcastResult> {
	if (arm === "A1") return broadcastA1(targets, payload, transport);
	if (arm === "A3") {
		// A paced cell takes the paced entry whenever it exists. The conductor
		// only installs `sendMirrorPaced` when the pacer knob is on, so this is
		// the paced/control switch and there is no third state.
		return typeof transport.sendMirrorPaced === "function"
			? broadcastA3Paced(targets, payload, transport)
			: broadcastA3(targets, payload, transport);
	}
	return broadcastA2(targets, payload, transport);
}

/** One drain of the reports ring, tallied by error identity. */
export type MirrorReportTally = {
	drained: number;
	queueFull: number;
	sessionClosed: number;
	other: number;
};

export function emptyReportTally(): MirrorReportTally {
	return { drained: 0, queueFull: 0, sessionClosed: 0, other: 0 };
}

/**
 * Drain the paced reports ring into a running tally.
 *
 * Called by the conductor after each broadcast, outside the span C7 reads. A
 * no-op when the transport has no ring, so a control cell pays nothing.
 */
export function drainMirrorReports(
	transport: EmitterTransport,
	into: MirrorReportTally,
	max?: number,
): void {
	const read = transport.readMirrorReports;
	if (!read) return;
	for (const report of read.call(transport, max)) {
		into.drained += 1;
		if (report.code === "E_QUEUE_FULL") into.queueFull += 1;
		else if (report.code === "E_SESSION_CLOSED") into.sessionClosed += 1;
		else into.other += 1;
	}
}

/* -------------------------------------------------------------------------- */
/* The interleave (§2)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * §2. Which arm owns a given instant, round-robin at 10 s granularity.
 *
 * Arms are interleaved rather than run back to back so a drift in host
 * conditions cannot be read as an arm effect — K5 is the whole reason, and P7
 * predicts V-A will not fire because of it. The block index comes from elapsed
 * time, so the schedule is a pure function of the clock and a test can walk it.
 */
export function armForElapsed(
	elapsedMs: number,
	arms: readonly ArmId[],
	blockMs = 10_000,
): ArmId {
	if (arms.length === 0) throw new Error("no arms to interleave");
	const block = Math.max(0, Math.floor(elapsedMs / blockMs));
	return arms[block % arms.length] as ArmId;
}

/**
 * How many whole blocks each arm gets in a window. The conductor reports it so
 * an interleave that gave one arm fewer blocks than another is visible in the
 * artifact rather than inferred from sample counts.
 */
export function blocksPerArm(
	windowMs: number,
	arms: readonly ArmId[],
	blockMs = 10_000,
): Map<ArmId, number> {
	const counts = new Map<ArmId, number>(arms.map((a) => [a, 0]));
	const blocks = Math.floor(windowMs / blockMs);
	for (let b = 0; b < blocks; b += 1) {
		const arm = arms[b % arms.length] as ArmId;
		counts.set(arm, (counts.get(arm) ?? 0) + 1);
	}
	return counts;
}

/* -------------------------------------------------------------------------- */
/* §6.6b — the loop-lag sampler                                               */
/* -------------------------------------------------------------------------- */

export type LoopLagSample = { lagNs: bigint };

/**
 * An event-loop lag sampler: re-armed from inside its own callback so a stalled
 * loop delays the next arm rather than queueing a backlog of them.
 *
 * It is a **disclosure**, never C7's input (§6.6). It sees GC and native
 * callbacks the emitter's own instrument cannot, and it aliases stalls shorter
 * than its period — which is exactly why the clause reads `passStallNs` instead.
 */
export function startLoopLagSampler(
	periodMs: number,
	nowNs: () => bigint,
	record: (sample: LoopLagSample) => void,
): () => number {
	let ticks = 0;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const periodNs = BigInt(Math.round(periodMs * 1e6));
	const arm = (): void => {
		const scheduledAt = nowNs() + periodNs;
		timer = setTimeout(() => {
			if (stopped) return;
			const lag = nowNs() - scheduledAt;
			ticks += 1;
			record({ lagNs: lag > 0n ? lag : 0n });
			arm();
		}, periodMs);
		if (typeof timer === "object" && timer !== null && "unref" in timer) {
			(timer as { unref: () => void }).unref();
		}
	};
	arm();
	return () => {
		stopped = true;
		if (timer !== null) clearTimeout(timer);
		return ticks;
	};
}
