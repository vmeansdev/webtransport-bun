/**
 * Gate G5 (bulk stream throughput): the per-socket drop parsers and the gate's
 * verdict rules, separated from the harness that drives them so they run
 * without a runner.
 *
 * The contract is docs/research/preregistrations/gate-g5-bulk.md, committed
 * before this file existed. Every threshold here — 1 Gbps, 8192 B per crossing,
 * the 0.95 match band, the 1% instrument-agreement band, the 0.1% co-resident
 * disclosure threshold, the A6 10% rule — is quoted from that document and
 * nothing here looks at a number to decide which question to ask of it.
 *
 * The gate spans three harness invocations (the batching knob is read once at
 * module init, so knob-off and knob-on cells cannot share a process). The
 * cross-invocation comparison lives here, in code fixed before the dispatch,
 * rather than in whatever a reader makes of two artifacts.
 */

// --- Thresholds, all pre-registered ----------------------------------------

/** Clause 2. */
export const GATE_THROUGHPUT_GBPS = 1.0;
/** Clause 4: mean bytes per receive-side JS crossing. */
export const GATE_CROSSING_BYTES = 8192;
/** Clause 5: how close to the raised-window control counts as matched. */
export const GATE_MATCH_RATIO = 0.95;
/** The pre-registered batch budget. Justified in the pre-registration, §"Why 65,536". */
export const GATE_BATCH_BYTES = 65536;
/** Two crossing instruments disagreeing by more than this is not a measurement. */
export const CROSSING_INSTRUMENT_TOLERANCE = 0.01;
/** Co-resident drops above this share of socket-layer receives are MATERIAL. */
export const CO_RESIDENT_DROP_DISCLOSURE_RATIO = 0.001;
/** Arm A's falsifier rule, unchanged. */
export const A6_WINDOW_BOUND_RATIO = 1.1;
/** The shipped governors the gate config must stay inside. */
export const SHIPPED_QUEUED_BYTES_PER_STREAM = 256 * 1024;
export const SHIPPED_QUEUED_BYTES_PER_SESSION = 2 * 1024 * 1024;

export const CROSSING_CLAUSE_NOTE =
	"mean bytes per receive-side JS crossing is evaluated on the package-side " +
	"diagnostics counter (WEBTRANSPORT_STREAM_BATCH_DIAGNOSTICS), which records " +
	"on the unbatched path too so control and gate arms share one instrument. " +
	"The harness-side figure (serverBytes/serverChunks, counted by the consuming " +
	"reader) is the cross-check, not the claim. crates/native/src/client_stream.rs " +
	"fixes each underlying read_chunk at STREAM_READ_BUFFER_BYTES = 4096, so the " +
	"unbatched path cannot exceed 4096 B per crossing by construction and the " +
	"8192 B clause means, mechanically, >= 2 underlying chunks coalesced per " +
	"crossing on average. Mean bytes per crossing carries no time denominator. " +
	"crossingsPerSecond does, and it is the counter's own window (step start to " +
	"post-settle snapshot, i.e. driveSec + settleSec), NOT the harness's " +
	"windowSec that boundaryEventsPerSec uses — the two rates are not comparable " +
	"and neither carries a threshold";

export const SERVER_SOCKET_DROP_NOTE =
	"/proc/net/snmp Udp.RcvbufErrors is host-wide and on this on-box rig sums " +
	"the server's and the co-resident client's drops, so it cannot answer a " +
	"clause that says 'on the server side'. serverSocketDrops is the delta over " +
	"the drops column of the /proc/net/udp{,6} rows whose local port is the " +
	"cell's server port; coResidentDrops is the host-wide delta minus that, " +
	"floored at 0, and is disclosed rather than failed";

// --- /proc/net/udp parsing --------------------------------------------------

export type SocketDropRow = {
	localPort: number;
	rxQueueBytes: number;
	drops: number;
};

/**
 * Rows of /proc/net/udp or /proc/net/udp6 for one local port.
 *
 * Layout (both files): `sl local_address rem_address st tx_queue:rx_queue
 * tr:tm->when retrnsmt uid timeout inode ref pointer drops`, with
 * `local_address` as `HEXIP:HEXPORT` and `drops` last. A row that does not
 * parse is skipped rather than counted as zero — a silently-zero drop count is
 * the one failure mode this instrument must not have.
 */
export function parseUdpSocketRows(
	text: string,
	localPort: number,
): SocketDropRow[] {
	const out: SocketDropRow[] = [];
	for (const line of text.split("\n").slice(1)) {
		const f = line.trim().split(/\s+/);
		// 13 fields with a trailing drops column; anything shorter is a header
		// remnant or a kernel without the column, and is not evidence of zero.
		if (f.length < 13) continue;
		const local = f[1] ?? "";
		const colon = local.lastIndexOf(":");
		if (colon < 0) continue;
		const port = Number.parseInt(local.slice(colon + 1), 16);
		if (!Number.isFinite(port) || port !== localPort) continue;
		const queues = (f[4] ?? "").split(":");
		const rxQueueBytes = Number.parseInt(queues[1] ?? "", 16);
		const drops = Number.parseInt(f[f.length - 1] ?? "", 10);
		if (!Number.isFinite(drops)) continue;
		out.push({
			localPort: port,
			rxQueueBytes: Number.isFinite(rxQueueBytes) ? rxQueueBytes : 0,
			drops,
		});
	}
	return out;
}

export type ServerSocketSnapshot = {
	/** Summed across every matching v4 and v6 socket. */
	drops: number;
	rxQueueBytes: number;
	sockets: number;
};

export function summarizeServerSockets(
	rows: SocketDropRow[],
): ServerSocketSnapshot {
	return {
		drops: rows.reduce((a, r) => a + r.drops, 0),
		rxQueueBytes: rows.reduce((a, r) => a + r.rxQueueBytes, 0),
		sockets: rows.length,
	};
}

/**
 * The co-resident receiver's share: everything the host dropped that the
 * server's own sockets did not. Floored at 0 because the two counters are
 * sampled a few microseconds apart and a small negative is sampling skew, not
 * a negative drop count.
 */
export function coResidentDrops(
	hostRcvbufErrorsDelta: number,
	serverSocketDropsDelta: number,
): number {
	return Math.max(0, hostRcvbufErrorsDelta - serverSocketDropsDelta);
}

export function discloseCoResidentDrops(
	drops: number,
	snmpInDatagramsDelta: number,
): { drops: number; ratio: number | null; verdict: string } {
	if (snmpInDatagramsDelta <= 0) {
		return {
			drops,
			ratio: null,
			// No denominator means the disclosure cannot be graded, and an
			// ungradeable disclosure is not an immaterial one.
			verdict: drops > 0 ? "UNGRADED" : "IMMATERIAL",
		};
	}
	const ratio = drops / snmpInDatagramsDelta;
	return {
		drops,
		ratio,
		verdict:
			ratio > CO_RESIDENT_DROP_DISCLOSURE_RATIO ? "MATERIAL" : "IMMATERIAL",
	};
}

// --- Per-step integrity rules Arm G adds ------------------------------------

export type CrossingFacts = {
	/** Package-side diagnostics counter: the instrument the clause names. */
	packageMeanBytesPerCrossing: number | null;
	/** Harness-side: serverBytes / serverChunks, counted by the consuming reader. */
	harnessMeanBytesPerCrossing: number | null;
};

/**
 * `crossing-instrument-disagreement` and `server-socket-drops-unmeasurable`,
 * applied after the axis's own common rules and before any throughput bucket.
 * Returns null when the step clears both.
 */
export function gateIntegrityBucket(facts: {
	crossing: CrossingFacts;
	serverSocketsFound: number | null;
}): string | null {
	if (facts.serverSocketsFound === null || facts.serverSocketsFound === 0) {
		return "server-socket-drops-unmeasurable";
	}
	const a = facts.crossing.packageMeanBytesPerCrossing;
	const b = facts.crossing.harnessMeanBytesPerCrossing;
	if (a === null || b === null) return "crossing-instrument-disagreement";
	const larger = Math.max(a, b);
	if (larger <= 0) return null;
	if (Math.abs(a - b) / larger > CROSSING_INSTRUMENT_TOLERANCE) {
		return "crossing-instrument-disagreement";
	}
	return null;
}

// --- The gate's cells and its verdict ---------------------------------------

export type GateCellName =
	| "G-control"
	| "G-batch"
	| "G-window-ref"
	| "G-window-batch";

/** One repeat of one cell: the facts the verdict rules are allowed to see. */
export type GateRepeatFacts = {
	cell: GateCellName;
	repeat: number;
	bucket: string;
	incomplete: boolean;
	deliveredMbps: number;
	packageMeanBytesPerCrossing: number | null;
	harnessMeanBytesPerCrossing: number | null;
	crossingsPerSecond: number | null;
	maxBatchBytes: number | null;
	batchedCrossings: number | null;
	serverSocketDrops: number | null;
	coResidentDrops: number | null;
	coResidentDropVerdict: string;
	serverSocketRxQueueBytesAtEnd: number | null;
	queuedBytesPerStream: number;
	queuedBytesPerSession: number;
	explicitWindowFieldsSet: boolean;
	insideShippedPerSessionBudget: boolean;
	batchBytesConfigured: number;
	serverCpuMsPerGbit: number | null;
	rssMbPeak: number;
};

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	if (s.length % 2 === 1) return s[mid] ?? null;
	return (((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2) as number;
}

export type GateCellSummary = {
	cell: GateCellName;
	repeats: number;
	usable: boolean;
	buckets: string[];
	deliveredGbpsMedian: number | null;
	deliveredGbpsSamples: number[];
	packageMeanBytesPerCrossingMedian: number | null;
	harnessMeanBytesPerCrossingMedian: number | null;
	crossingsPerSecondMedian: number | null;
	maxBatchBytes: number | null;
	serverSocketDropsMax: number | null;
	coResidentDropVerdicts: string[];
	serverCpuMsPerGbitMedian: number | null;
	rssMbPeakMax: number | null;
	config: {
		queuedBytesPerStream: number;
		queuedBytesPerSession: number;
		explicitWindowFieldsSet: boolean;
		insideShippedPerSessionBudget: boolean;
		batchBytesConfigured: number;
	} | null;
};

function summarizeCell(
	cell: GateCellName,
	repeats: GateRepeatFacts[],
): GateCellSummary {
	// A cell is usable only if EVERY repeat is complete: an INCOMPLETE repeat
	// silently dropped from a median is the same defect as reporting it.
	const usable = repeats.length > 0 && repeats.every((r) => !r.incomplete);
	const nums = (pick: (r: GateRepeatFacts) => number | null): number[] =>
		repeats.map(pick).filter((v): v is number => v !== null);
	const first = repeats[0];
	return {
		cell,
		repeats: repeats.length,
		usable,
		buckets: repeats.map((r) => r.bucket),
		deliveredGbpsMedian: median(repeats.map((r) => r.deliveredMbps / 1000)),
		deliveredGbpsSamples: repeats.map((r) => r.deliveredMbps / 1000),
		packageMeanBytesPerCrossingMedian: median(
			nums((r) => r.packageMeanBytesPerCrossing),
		),
		harnessMeanBytesPerCrossingMedian: median(
			nums((r) => r.harnessMeanBytesPerCrossing),
		),
		crossingsPerSecondMedian: median(nums((r) => r.crossingsPerSecond)),
		maxBatchBytes: repeats.length
			? Math.max(...repeats.map((r) => r.maxBatchBytes ?? 0))
			: null,
		serverSocketDropsMax: (() => {
			const d = nums((r) => r.serverSocketDrops);
			// A missing sample is not a zero: it means the clause could not be
			// checked for that repeat, which the integrity bucket already caught.
			return d.length === repeats.length && d.length > 0
				? Math.max(...d)
				: null;
		})(),
		coResidentDropVerdicts: [
			...new Set(repeats.map((r) => r.coResidentDropVerdict)),
		],
		serverCpuMsPerGbitMedian: median(nums((r) => r.serverCpuMsPerGbit)),
		rssMbPeakMax: repeats.length
			? Math.max(...repeats.map((r) => r.rssMbPeak))
			: null,
		config: first
			? {
					queuedBytesPerStream: first.queuedBytesPerStream,
					queuedBytesPerSession: first.queuedBytesPerSession,
					explicitWindowFieldsSet: first.explicitWindowFieldsSet,
					insideShippedPerSessionBudget: first.insideShippedPerSessionBudget,
					batchBytesConfigured: first.batchBytesConfigured,
				}
			: null,
	};
}

export type GateClause = {
	clause: number;
	name: string;
	pass: boolean;
	detail: string;
};

/**
 * G5's verdict: the six PASS clauses, the A6 falsifier at both knob settings,
 * and the derived figures that make a miss interpretable. A miss names its
 * clause and is final for the effort (spec §Rerun policy); nothing here
 * aggregates a failure into a softer word.
 */
export function evaluateGateG5(repeats: GateRepeatFacts[]) {
	const names: GateCellName[] = [
		"G-control",
		"G-batch",
		"G-window-ref",
		"G-window-batch",
	];
	const cells = new Map<GateCellName, GateCellSummary>(
		names.map((n) => [
			n,
			summarizeCell(
				n,
				repeats.filter((r) => r.cell === n),
			),
		]),
	);
	const control = cells.get("G-control") as GateCellSummary;
	const batch = cells.get("G-batch") as GateCellSummary;
	const windowRef = cells.get("G-window-ref") as GateCellSummary;
	const windowBatch = cells.get("G-window-batch") as GateCellSummary;

	const stops: string[] = [];
	const unusable = names.filter(
		(n) => !(cells.get(n) as GateCellSummary).usable,
	);
	if (unusable.length > 0) {
		stops.push(
			`G-STOP-A: cells not usable (${unusable
				.map(
					(n) =>
						`${n}=[${(cells.get(n) as GateCellSummary).buckets.join(",") || "no repeats"}]`,
				)
				.join(" ")}); no gate verdict`,
		);
	}
	if (repeats.some((r) => r.bucket === "crossing-instrument-disagreement")) {
		stops.push(
			"G-STOP-B: crossing-instrument-disagreement fired; no crossing claim is made for Arm G",
		);
	}

	const clauses: GateClause[] = [];
	const push = (
		clause: number,
		name: string,
		pass: boolean,
		detail: string,
	) => {
		clauses.push({ clause, name, pass, detail });
	};

	push(
		1,
		"completeness",
		unusable.length === 0,
		unusable.length === 0
			? "all four cells usable, every repeat complete"
			: `unusable: ${unusable.join(", ")}`,
	);

	const batchGbps = batch.usable ? batch.deliveredGbpsMedian : null;
	push(
		2,
		"throughput",
		batchGbps !== null && batchGbps >= GATE_THROUGHPUT_GBPS,
		batchGbps === null
			? "G-batch is not usable; no throughput number"
			: `G-batch median ${batchGbps.toFixed(3)} Gbps vs bar ${GATE_THROUGHPUT_GBPS.toFixed(3)} Gbps (samples ${batch.deliveredGbpsSamples.map((v) => v.toFixed(3)).join(", ")})`,
	);

	const cfg = batch.config;
	const insideBudgets =
		cfg?.insideShippedPerSessionBudget === true &&
		cfg.queuedBytesPerStream === SHIPPED_QUEUED_BYTES_PER_STREAM &&
		cfg.queuedBytesPerSession === SHIPPED_QUEUED_BYTES_PER_SESSION &&
		!cfg.explicitWindowFieldsSet;
	push(
		3,
		"inside shipped budgets",
		insideBudgets,
		cfg === null
			? "G-batch has no config recorded"
			: `perStream=${cfg.queuedBytesPerStream} perSession=${cfg.queuedBytesPerSession} explicitWindowFields=${cfg.explicitWindowFieldsSet} insideShippedPerSessionBudget=${cfg.insideShippedPerSessionBudget}`,
	);

	const crossing = batch.usable
		? batch.packageMeanBytesPerCrossingMedian
		: null;
	const crossingBlocked = stops.some((s) => s.startsWith("G-STOP-B"));
	push(
		4,
		"crossing",
		!crossingBlocked && crossing !== null && crossing >= GATE_CROSSING_BYTES,
		crossingBlocked
			? "G-STOP-B fired; no crossing claim"
			: crossing === null
				? "G-batch is not usable; no crossing number"
				: `G-batch median ${crossing.toFixed(0)} B/crossing vs bar ${GATE_CROSSING_BYTES} B (maxBatchBytes ${batch.maxBatchBytes ?? "n/a"}, control ${control.packageMeanBytesPerCrossingMedian?.toFixed(0) ?? "n/a"} B)`,
	);

	const refGbps = windowRef.usable ? windowRef.deliveredGbpsMedian : null;
	const matchRatio =
		batchGbps !== null && refGbps !== null && refGbps > 0
			? batchGbps / refGbps
			: null;
	push(
		5,
		"matched to the raised-window control",
		matchRatio !== null && matchRatio >= GATE_MATCH_RATIO,
		matchRatio === null
			? "G-batch or G-window-ref is not usable; no match ratio"
			: `G-batch/G-window-ref = ${matchRatio.toFixed(3)} vs bar ${GATE_MATCH_RATIO} (${batchGbps?.toFixed(3)} / ${refGbps?.toFixed(3)} Gbps)`,
	);

	const controlDrops = control.usable ? control.serverSocketDropsMax : null;
	push(
		6,
		"server-side rcvbuf drops in the control",
		controlDrops === 0,
		controlDrops === null
			? "G-control server socket drops were not measurable in every repeat"
			: `G-control serverSocketDrops max ${controlDrops} across repeats`,
	);

	const failed = clauses.filter((c) => !c.pass);
	const a6 = (num: GateCellSummary, den: GateCellSummary, label: string) => {
		if (!num.usable || !den.usable) {
			return { verdict: "unknown", reason: `${label}: a cell is not usable` };
		}
		const n = num.deliveredGbpsMedian;
		const d = den.deliveredGbpsMedian;
		if (n === null || d === null || d <= 0) {
			return { verdict: "unknown", reason: `${label}: no ratio` };
		}
		const ratio = n / d;
		return {
			verdict:
				ratio > A6_WINDOW_BOUND_RATIO ? "WINDOW-BOUND" : "WINDOWS-NOT-BINDING",
			ratio,
			raisedGbps: n,
			shippedGbps: d,
			reason:
				ratio > A6_WINDOW_BOUND_RATIO
					? `${label}: raised windows beat the shipped ones by >10%, so this configuration is flow-control bound and its delivered figure bounds the N-API boundary from below`
					: `${label}: raised windows made no material difference; the shipped windows are not the binding constraint here`,
		};
	};

	const leverEffect =
		batch.usable &&
		control.usable &&
		batch.deliveredGbpsMedian !== null &&
		control.deliveredGbpsMedian !== null &&
		control.deliveredGbpsMedian > 0
			? batch.deliveredGbpsMedian / control.deliveredGbpsMedian
			: null;

	return {
		gate: "G5",
		preregistration: "docs/research/preregistrations/gate-g5-bulk.md",
		verdict:
			stops.length > 0 ? "NO-VERDICT" : failed.length === 0 ? "PASS" : "MISS",
		failedClauses: failed.map((c) => `${c.clause} ${c.name}: ${c.detail}`),
		clauses,
		stops,
		cells: names.map((n) => cells.get(n) as GateCellSummary),
		a6AtChosenDefault: a6(
			windowRef,
			control,
			"A6 at the chosen default (knob OFF)",
		),
		a6AtKnobOn: a6(
			windowBatch,
			batch,
			`A6 with the knob at ${GATE_BATCH_BYTES} B`,
		),
		derived: {
			leverEffectBatchOverControl: leverEffect,
			controlCrossingBytes: control.packageMeanBytesPerCrossingMedian,
			batchCrossingBytes: batch.packageMeanBytesPerCrossingMedian,
			controlCrossingsPerSecond: control.crossingsPerSecondMedian,
			batchCrossingsPerSecond: batch.crossingsPerSecondMedian,
			controlServerCpuMsPerGbit: control.serverCpuMsPerGbitMedian,
			batchServerCpuMsPerGbit: batch.serverCpuMsPerGbitMedian,
		},
		notes: {
			crossingClause: CROSSING_CLAUSE_NOTE,
			serverSocketDrops: SERVER_SOCKET_DROP_NOTE,
			a6: "A6 is a disclosure, not a gate clause: G5 is a delivered-throughput statement on a config inside the shipped budgets, not a claim about which resource binds. WINDOW-BOUND moves the axis's bulkCeilingIsLowerBoundOnly flag",
			rerun:
				"A miss on a valid run is final for the effort and routes to its mechanism ticket (07 for clauses 2 and 4, 09 for clauses 3 and 5, the rig for clause 6). Re-running G-batch at another batch budget to clear the bar is forbidden by the pre-registration",
		},
	};
}
