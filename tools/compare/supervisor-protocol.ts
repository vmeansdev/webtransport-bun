// R1 supervisor protocol validation (Task C): descriptor-only role loading
// and the supervisor-owned physical-path observation contract. Children can
// never mint physical authority; every receipt class binds back to the
// supervisor-computed set digests. Pure validation: no OS I/O.
import {
	canonicalRecordBytes,
	isImplausibleDigest,
	sha256HexOfBytes,
	type ValidationFailure,
} from "./secure-fs.ts";
import type { MeasurementGrantV1 } from "./supervisor-client.ts";
import { parseLinuxRoute, parseMacRoute } from "./topology.ts";

type Rec = Record<string, unknown>;

function isPlainObject(value: unknown): value is Rec {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

// ---------------------------------------------------------------------------
// Observation provenance
//
// The TS mirror of the Rust `ObservationProvenance` model. Reference
// comparison cannot separate an observation from an echo of the plan —
// `structuredClone` defeats it, and every later check requires observed to
// equal planned anyway. Only the observation's own declared source can, so
// provenance travels with the facts and an echo is rejected structurally
// rather than detected by comparison.
// ---------------------------------------------------------------------------

export type ObservationProvenance =
	| "supervisor-measured"
	| "echo-of-plan"
	| "child-reported";

/** Planned facts from the validated lock: inputs only, never evidence. */
export interface PlannedPathFacts {
	readonly macInterface: string;
	readonly macAddress: string;
	readonly linuxInterface: string;
	readonly linuxAddress: string;
	readonly mtu: number;
}

/**
 * Independently observed facts. A deliberately distinct shape from the plan:
 * every field is optional so omission is a typed failure rather than a
 * skipped check, and provenance is explicit so an echo can never validate.
 */
export interface ObservedPathFacts {
	readonly provenance: ObservationProvenance;
	readonly macInterface?: string;
	readonly macAddress?: string;
	readonly linuxInterface?: string;
	readonly linuxAddress?: string;
	readonly mtu?: number;
	readonly qdiscRestored?: boolean;
	readonly cleanupReleased?: boolean;
}

/**
 * Rejects a declared provenance that is anything other than the
 * supervisor's own measurement. An observation that declares no provenance
 * at all is indistinguishable from an echo, so it is rejected too.
 */
export function observationProvenanceIssue(observed: unknown): string | null {
	if (!isPlainObject(observed)) return "TRUST_CHILD_OBSERVATION_FORBIDDEN";
	const provenance = observed.provenance;
	if (provenance === "supervisor-measured") return null;
	if (provenance === undefined) return "TRUST_OBSERVATION_PROVENANCE_MISSING";
	return "TRUST_CHILD_OBSERVATION_FORBIDDEN";
}

/**
 * Validates an observation against the plan: fails on a non-supervisor
 * provenance, on omission, on drift, or on cleanup/restoration failure.
 */
export function validateObservedPathFacts(
	planned: PlannedPathFacts,
	observed: ObservedPathFacts,
): { ok: true } | ValidationFailure {
	const provenanceIssue = observationProvenanceIssue(observed);
	if (provenanceIssue !== null) {
		return { ok: false, code: provenanceIssue };
	}
	const required = [
		[observed.macInterface, planned.macInterface],
		[observed.macAddress, planned.macAddress],
		[observed.linuxInterface, planned.linuxInterface],
		[observed.linuxAddress, planned.linuxAddress],
		[observed.mtu, planned.mtu],
	] as const;
	for (const [seen] of required) {
		if (seen === undefined) {
			return { ok: false, code: "TRUST_OBSERVATION_OMITTED" };
		}
	}
	for (const [seen, expected] of required) {
		if (seen !== expected) {
			return { ok: false, code: "TRUST_OBSERVATION_DRIFT" };
		}
	}
	if (observed.qdiscRestored !== true) {
		return { ok: false, code: "TRUST_QDISC_RESTORATION_FAILED" };
	}
	if (observed.cleanupReleased !== true) {
		return { ok: false, code: "TRUST_CLEANUP_OBSERVATION_MISSING" };
	}
	return { ok: true };
}

const OFFICIAL_ROLE_NAMES = [
	"campaign-child",
	"artifact-child",
	"verifier-child",
	"report-child",
] as const;

const FORBIDDEN_ENVIRONMENT_KEY_PATTERN = /AUTHORITY|CAPABILITY|LOCK|TRUST/i;

export function validateDescriptorOnlyRoleLoading(
	input: unknown,
): { ok: true; roleCount: number } | ValidationFailure {
	if (!isPlainObject(input) || !Array.isArray(input.loads)) {
		return { ok: false, code: "TRUST_ROLE_COUNT_INVALID" };
	}
	const loads = input.loads;
	if (loads.length !== OFFICIAL_ROLE_NAMES.length) {
		return { ok: false, code: "TRUST_ROLE_COUNT_INVALID" };
	}
	const names = loads.map((load) =>
		isPlainObject(load) ? load.logicalName : null,
	);
	for (const [index, name] of OFFICIAL_ROLE_NAMES.entries()) {
		if (names[index] !== name) {
			return { ok: false, code: "TRUST_ROLE_COUNT_INVALID" };
		}
	}
	const descriptors = new Set<number>();
	for (const load of loads as Rec[]) {
		for (const key of ["roleFd", "addonFd"] as const) {
			const fd = load[key];
			if (typeof fd !== "number" || !Number.isInteger(fd) || fd <= 2) {
				return { ok: false, code: "TRUST_DESCRIPTOR_DUPLICATE" };
			}
			if (descriptors.has(fd)) {
				return { ok: false, code: "TRUST_DESCRIPTOR_DUPLICATE" };
			}
			descriptors.add(fd);
		}
	}
	for (const load of loads as Rec[]) {
		if (load.roleEntrypoint !== `/dev/fd/${String(load.roleFd)}`) {
			return { ok: false, code: "TRUST_ROLE_PATH_AUTHORITY_FORBIDDEN" };
		}
		if (load.addonPath !== `/dev/fd/${String(load.addonFd)}`) {
			return { ok: false, code: "TRUST_ADDON_FALLBACK_FORBIDDEN" };
		}
	}
	const environment = input.environment;
	if (environment !== undefined) {
		if (!isPlainObject(environment)) {
			return { ok: false, code: "TRUST_AUTHORITY_ENV_FORBIDDEN" };
		}
		for (const key of Object.keys(environment)) {
			if (
				key !== "COMPARISON_ADDON_FD" &&
				FORBIDDEN_ENVIRONMENT_KEY_PATTERN.test(key)
			) {
				return { ok: false, code: "TRUST_AUTHORITY_ENV_FORBIDDEN" };
			}
		}
	}
	if (isImplausibleDigest(input.authoritySha256)) {
		return { ok: false, code: "TRUST_AUTHORITY_ENV_FORBIDDEN" };
	}
	return { ok: true, roleCount: loads.length };
}

// ---------------------------------------------------------------------------
// Supervisor-owned physical-path observation contract
// ---------------------------------------------------------------------------

/**
 * A direct cable is proved by two signals together: the route resolves out of
 * the expected interface, and it resolves through **no gateway**.  The previous
 * form of this check required the route to end in `via <iface>` — the token
 * `via` introduces a *next hop*, so the check that exists to prove "no
 * intermediary" demanded the token that means there is one, and no output
 * `route -n get` or `ip route get` ever emits could satisfy it.  The real
 * formats are parsed by `topology.ts`, which is where they are documented, so
 * this consumes those parsers rather than keeping a second route model.
 */
function routeProvesDirectPath(
	route: unknown,
	iface: unknown,
	destination: unknown,
	host: "mac" | "linux",
): boolean {
	if (typeof route !== "string" || typeof iface !== "string") return false;
	if (typeof destination !== "string") return false;
	// `via` is the gateway token in every Linux route form; its presence is a
	// next hop, which is the one thing this check exists to exclude.
	if (/\bvia\b/.test(route)) return false;
	const parsed =
		host === "mac"
			? parseMacRoute(route, destination)
			: parseLinuxRoute(route, destination);
	return parsed.valid && parsed.interface === iface;
}

function isTailscaleLike(iface: unknown): boolean {
	return (
		typeof iface === "string" &&
		(iface.includes("tailscale") ||
			iface.startsWith("utun") ||
			iface.startsWith("ts"))
	);
}

function isLoopbackAddress(address: unknown): boolean {
	return (
		typeof address === "string" &&
		(address === "::1" || address.startsWith("127."))
	);
}

const OBSERVATION_TOOLS: Record<string, readonly string[]> = {
	mac: ["route", "ifconfig", "route+ifconfig"],
	// A single `ethtool -K` difference between the arms is otherwise invisible
	// and would be attributed to the transport.
	linux: ["ip", "tc", "ip+tc", "ethtool", "ip+tc+ethtool"],
};

export function validateSupervisorPhysicalReceipts(
	input: unknown,
):
	| { ok: true; receiptCount: number; linuxReceiptCount: number }
	| ValidationFailure {
	if (!isPlainObject(input) || !isPlainObject(input.observation)) {
		return { ok: false, code: "TRUST_LINUX_OBSERVATION_MISSING" };
	}
	// A caller supplying planned facts alongside (or as) the observation is an
	// echo of the plan, not an independent supervisor observation. Checking
	// only that the key is absent catches nothing: omit the field and hand
	// the plan in as the observation. The observation's own declared
	// provenance is what separates the two, so it is what gets checked.
	if (input.plannedFacts !== undefined) {
		return { ok: false, code: "TRUST_CHILD_OBSERVATION_FORBIDDEN" };
	}
	const declaredProvenance = (input.observation as Rec).provenance;
	if (
		declaredProvenance !== undefined &&
		declaredProvenance !== "supervisor-measured"
	) {
		return { ok: false, code: "TRUST_CHILD_OBSERVATION_FORBIDDEN" };
	}
	const observation = input.observation;
	const mac = observation.mac;
	const linux = observation.linux;
	if (!isPlainObject(linux)) {
		return { ok: false, code: "TRUST_LINUX_OBSERVATION_MISSING" };
	}
	if (!isPlainObject(mac)) {
		return { ok: false, code: "TRUST_SOURCE_ADDRESS_MISMATCH" };
	}
	if (mac.hostId === linux.hostId || mac.address === linux.address) {
		return { ok: false, code: "TRUST_HOST_IDS_MUST_DIFFER" };
	}
	if (isTailscaleLike(mac.interface) || isTailscaleLike(linux.interface)) {
		return { ok: false, code: "TRUST_TAILSCALE_MEASUREMENT_FORBIDDEN" };
	}

	const receipts = input.receipts;
	if (!Array.isArray(receipts) || receipts.length === 0) {
		return { ok: false, code: "TRUST_RUN_RECEIPTS_MISSING" };
	}
	const firstReceipt = receipts[0] as Rec;
	if (
		isLoopbackAddress(mac.address) ||
		(isPlainObject(firstReceipt) && firstReceipt.macAddress !== mac.address)
	) {
		return { ok: false, code: "TRUST_SOURCE_ADDRESS_MISMATCH" };
	}
	if (
		isLoopbackAddress(linux.address) ||
		(isPlainObject(firstReceipt) && firstReceipt.linuxAddress !== linux.address)
	) {
		return { ok: false, code: "TRUST_SOURCE_ADDRESS_MISMATCH" };
	}
	if (
		!routeProvesDirectPath(mac.route, mac.interface, linux.address, "mac") ||
		!routeProvesDirectPath(linux.route, linux.interface, mac.address, "linux")
	) {
		return { ok: false, code: "TRUST_ROUTE_MISMATCH" };
	}
	if (
		typeof mac.mtu !== "number" ||
		typeof linux.mtu !== "number" ||
		mac.mtu !== linux.mtu
	) {
		return { ok: false, code: "TRUST_MTU_MISMATCH" };
	}
	if (linux.peer !== mac.hostId || mac.peer !== linux.hostId) {
		return { ok: false, code: "TRUST_SERVER_PEER_MISMATCH" };
	}
	if (
		mac.qdiscBefore !== mac.qdiscAfter ||
		linux.qdiscBefore !== linux.qdiscAfter
	) {
		return { ok: false, code: "TRUST_QDISC_MISMATCH" };
	}
	for (const [host, record] of [
		["mac", mac],
		["linux", linux],
	] as const) {
		const allowed = OBSERVATION_TOOLS[host] ?? [];
		if (typeof record.tool !== "string" || !allowed.includes(record.tool)) {
			return { ok: false, code: "TRUST_OBSERVATION_COMMAND_MISMATCH" };
		}
	}

	const sshHostReceipts = input.sshHostReceipts;
	if (!Array.isArray(sshHostReceipts) || sshHostReceipts.length === 0) {
		return { ok: false, code: "TRUST_SSH_HOST_MISMATCH" };
	}
	const sshReceiptSha256 = sha256HexOfBytes(
		canonicalRecordBytes(sshHostReceipts[0]),
	);
	if (observation.sshHostReceiptSha256 !== sshReceiptSha256) {
		return { ok: false, code: "TRUST_SSH_HOST_MISMATCH" };
	}

	const cleanup = observation.cleanup;
	if (
		!isPlainObject(cleanup) ||
		cleanup.allRunsRestored !== true ||
		cleanup.allProcessGroupsReleased !== true ||
		cleanup.allQdiscRestored !== true
	) {
		return { ok: false, code: "TRUST_CLEANUP_OBSERVATION_MISSING" };
	}

	// Every receipt class must hash back to the digest the observation binds.
	const digestBindings: ReadonlyArray<readonly [string, unknown, string]> = [
		[
			"networkReceiptSetSha256",
			input.receipts,
			"TRUST_RUN_RECEIPT_SET_MISMATCH",
		],
		[
			"commandReceiptSetSha256",
			input.commandReceipts,
			"TRUST_OBSERVATION_COMMAND_MISMATCH",
		],
		["pathReceiptSetSha256", input.pathReceipts, "TRUST_ROUTE_MISMATCH"],
		["qdiscReceiptSetSha256", input.qdiscReceipts, "TRUST_QDISC_MISMATCH"],
		[
			"cleanupReceiptSetSha256",
			input.cleanupReceipts,
			"TRUST_CLEANUP_OBSERVATION_MISSING",
		],
	];
	for (const [field, value, code] of digestBindings) {
		if (value === undefined) {
			return { ok: false, code };
		}
		try {
			if (
				observation[field] !== sha256HexOfBytes(canonicalRecordBytes(value))
			) {
				return { ok: false, code };
			}
		} catch {
			return { ok: false, code };
		}
	}

	let linuxReceiptCount = 0;
	for (const receipt of receipts) {
		if (!isPlainObject(receipt)) {
			return { ok: false, code: "TRUST_RUN_RECEIPTS_MISSING" };
		}
		if (receipt.status !== "OBSERVED" || receipt.captureDropCount !== 0) {
			return { ok: false, code: "TRUST_RUN_RECEIPTS_MISSING" };
		}
		if (typeof receipt.linuxHostId === "string") linuxReceiptCount += 1;
	}
	if (isImplausibleDigest(input.authoritySha256)) {
		return { ok: false, code: "TRUST_SSH_HOST_MISMATCH" };
	}
	return { ok: true, receiptCount: receipts.length, linuxReceiptCount };
}

const CHILD_FORBIDDEN_OBSERVATION_FIELDS = [
	"uname",
	"cpuCount",
	"fdLimit",
	"route",
	"socketList",
	"launchReceipt",
] as const;

export function validateChildObservationBoundary(
	input: unknown,
): { ok: true } | ValidationFailure {
	if (!isPlainObject(input) || !isPlainObject(input.childObservation)) {
		return { ok: false, code: "TRUST_CHILD_OBSERVATION_FORBIDDEN" };
	}
	const observation = input.childObservation;
	const allowedKinds = Array.isArray(input.allowedKinds)
		? input.allowedKinds
		: [];
	for (const field of CHILD_FORBIDDEN_OBSERVATION_FIELDS) {
		if (field in observation && !allowedKinds.includes(field)) {
			return { ok: false, code: "TRUST_CHILD_OBSERVATION_FORBIDDEN" };
		}
	}
	return { ok: true };
}

export function validateSupervisorReceiptOrigin(
	input: unknown,
): { ok: true; origin: "supervisor" } | ValidationFailure {
	if (!isPlainObject(input) || !isPlainObject(input.receipt)) {
		return { ok: false, code: "TRUST_CHILD_OBSERVATION_FORBIDDEN" };
	}
	if (input.origin !== "supervisor") {
		return { ok: false, code: "TRUST_CHILD_OBSERVATION_FORBIDDEN" };
	}
	return { ok: true, origin: "supervisor" };
}

// ---------------------------------------------------------------------------
// Measurement admission (M1 + M2)
//
// The binding copy of these rules is `secure_fs::measurement` in the Rust
// supervisor, because that is the one process the thing being measured cannot
// call. What lives here is the same two comparisons stated in the controller's
// own language, for three uses: the campaign can fail fast without paying a
// round trip to a child that is going to be refused, the codes have one
// spelling on both sides of the pipe, and the payload the supervisor parses is
// assembled in exactly one place rather than by each caller that has a leg.
//
// It is deliberately not a second gate. A validator that runs beside the
// producer can be skipped by the producer; this one is advice, and the
// supervisor's refusal is the fact.
// ---------------------------------------------------------------------------

/**
 * The supervisor's own two readings for one execution.
 *
 * `grantIssuedAtMs` is taken as the run-command frame is written -- before the
 * child exists, so before it can have measured anything -- and
 * `frameAcceptedAtMs` as the `artifact-payload` frame is accepted. Neither is
 * a number that arrived in a frame.
 */
export interface MeasurementWallBracket {
	readonly grantIssuedAtMs: number;
	readonly frameAcceptedAtMs: number;
}

/** One round trip as the driver's recorder filed it. */
export interface MeasurementRoundTrip {
	readonly sequence: number;
	readonly sentAtMs: number;
	readonly receivedAtMs: number;
	readonly latencyMs: number;
}

/**
 * The series an `artifact-payload` frame carries.
 *
 * Structural on purpose: this module must not import the driver, whose import
 * graph pulls the adapters into the official-root reachability set.
 */
export interface MeasurementSeries {
	readonly samples: readonly number[];
	readonly roundTrips: readonly MeasurementRoundTrip[];
	readonly ledger: { readonly delivered?: number };
	readonly provenance: {
		readonly sampleCount: number;
		readonly firstSampleAtMs: number;
		readonly lastSampleAtMs: number;
	};
}

/**
 * How many ulps of the compared magnitude one comparison admits.
 *
 * The same constant as `SLACK_ULPS` in the Rust module, and it has to stay the
 * same one: this is the width of a per-sample forgery channel, and two copies
 * of a gate that admit different bands are two gates.
 *
 * Measured, not chosen: over a hundred thousand epoch-scale round trips the
 * worst honest residual of `(receivedAtMs - sentAtMs) - latencyMs` is 1.2e-4
 * ms, under one ulp of the stamps. Eight ulps is 3.2 microseconds. It was 4096
 * -- 1.63 ms, wider than the latency on every local cell -- beside a docstring
 * claiming 1.5 microseconds.
 */
const SLACK_ULPS = 8;

/** The floor under the scaled slack, so a zero magnitude still compares. */
const EPSILON_MS = 1e-6;

/**
 * Slack for one comparison, scaled to the magnitude of its operands.
 *
 * Mirrors `slack_at` in the Rust module, and for the same reason: epoch
 * milliseconds are around 1.7e12, where one ulp is already a quarter of a
 * microsecond, so `receivedAtMs - sentAtMs` does not reproduce a recorded
 * latency bit for bit and a fixed nanosecond tolerance refuses honest series.
 *
 * What it admits, as the code computes it: a few microseconds at epoch scale.
 * That is the cost of representing the stamps, not a measurement allowance.
 * Scaling to the latency instead does not narrow the band -- it collapses to
 * `EPSILON_MS`, two orders under the honest residual, and refuses honest legs.
 */
function slackAt(magnitude: number): number {
	return Math.max(
		Math.abs(magnitude) * (Number.EPSILON * SLACK_ULPS),
		EPSILON_MS,
	);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Apply M1 and M2 to one series under one bracket.
 *
 * M1, the wall bracket: a window outside the supervisor's launch-to-acceptance
 * interval did not happen on this run, whatever clock produced it. That is what
 * makes a fabricated stepping clock useless without closing the seam that lets
 * one be stood up -- which is the difference between this and the two guards
 * that were defeated by execution.
 *
 * M2, the series/ledger join: the sample count, the round trips, the declared
 * count and the ledger's deliveries must be the same number, each sample must
 * be the latency of the trip it sits beside, and each sequence must appear
 * once.
 *
 * What neither bounds, stated rather than implied: the distribution inside the
 * window. A forger who runs the honest leg and reports every sample at a third
 * of its real latency, keeping the count and the window intact, passes both.
 * Closing that needs per-message timestamps observed off-process.
 */
export function validateMeasurementAdmission(
	series: unknown,
	bracket: MeasurementWallBracket,
): { ok: true; sampleCount: number } | ValidationFailure {
	if (!isPlainObject(series)) {
		return { ok: false, code: "TRUST_RECORD_MALFORMED" };
	}
	const samples = series.samples;
	const roundTrips = series.roundTrips;
	const provenance = series.provenance;
	const ledger = series.ledger;
	if (
		!Array.isArray(samples) ||
		!Array.isArray(roundTrips) ||
		!isPlainObject(provenance) ||
		!isPlainObject(ledger)
	) {
		return { ok: false, code: "TRUST_RECORD_MALFORMED" };
	}
	const declaredCount = provenance.sampleCount;
	const delivered = ledger.delivered;
	if (!isCount(declaredCount) || !isCount(delivered)) {
		return { ok: false, code: "TRUST_RECORD_MALFORMED" };
	}

	// M2 first: a series that does not describe the traffic beside it is not a
	// measurement of it, and asking that before the window keeps each refusal
	// reporting the thing it is about.
	if (
		roundTrips.length !== samples.length ||
		declaredCount !== samples.length ||
		delivered !== samples.length
	) {
		return { ok: false, code: "MEASUREMENT_SERIES_LEDGER_DIVERGES" };
	}
	const seen = new Set<number>();
	const trips: MeasurementRoundTrip[] = [];
	for (const [index, entry] of roundTrips.entries()) {
		if (!isPlainObject(entry)) {
			return { ok: false, code: "TRUST_RECORD_MALFORMED" };
		}
		const { sequence, sentAtMs, receivedAtMs, latencyMs } = entry;
		if (
			!isCount(sequence) ||
			!isFiniteNumber(sentAtMs) ||
			!isFiniteNumber(receivedAtMs) ||
			!isFiniteNumber(latencyMs)
		) {
			return { ok: false, code: "TRUST_RECORD_MALFORMED" };
		}
		const sample = samples[index];
		if (!isFiniteNumber(sample)) {
			return { ok: false, code: "TRUST_RECORD_MALFORMED" };
		}
		// A series rewritten beside intact timestamps fails the first of these;
		// timestamps rewritten beside an intact series fail the second.
		if (Math.abs(sample - latencyMs) > slackAt(latencyMs)) {
			return { ok: false, code: "MEASUREMENT_SERIES_LEDGER_DIVERGES" };
		}
		if (Math.abs(receivedAtMs - sentAtMs - latencyMs) > slackAt(receivedAtMs)) {
			return { ok: false, code: "MEASUREMENT_SERIES_LEDGER_DIVERGES" };
		}
		if (seen.has(sequence)) {
			return { ok: false, code: "MEASUREMENT_SERIES_LEDGER_DIVERGES" };
		}
		seen.add(sequence);
		trips.push({ sequence, sentAtMs, receivedAtMs, latencyMs });
	}

	if (
		!isFiniteNumber(bracket.grantIssuedAtMs) ||
		!isFiniteNumber(bracket.frameAcceptedAtMs) ||
		bracket.frameAcceptedAtMs < bracket.grantIssuedAtMs
	) {
		return { ok: false, code: "MEASUREMENT_OUTSIDE_GRANT_WINDOW" };
	}
	// A leg that ran and recorded nothing is a real outcome, scored as one
	// downstream. There is no window to bracket and nothing promotable in it.
	if (samples.length === 0) {
		return { ok: true, sampleCount: 0 };
	}

	const firstSampleAtMs = provenance.firstSampleAtMs;
	const lastSampleAtMs = provenance.lastSampleAtMs;
	if (!isFiniteNumber(firstSampleAtMs) || !isFiniteNumber(lastSampleAtMs)) {
		return { ok: false, code: "TRUST_RECORD_MALFORMED" };
	}
	const contains = (atMs: number): boolean =>
		atMs >= bracket.grantIssuedAtMs - slackAt(bracket.grantIssuedAtMs) &&
		atMs <= bracket.frameAcceptedAtMs + slackAt(bracket.frameAcceptedAtMs);
	if (
		!contains(firstSampleAtMs) ||
		!contains(lastSampleAtMs) ||
		lastSampleAtMs < firstSampleAtMs
	) {
		return { ok: false, code: "MEASUREMENT_OUTSIDE_GRANT_WINDOW" };
	}
	let previousReceivedAtMs = Number.NEGATIVE_INFINITY;
	let latencySumMs = 0;
	for (const trip of trips) {
		if (
			!contains(trip.sentAtMs) ||
			!contains(trip.receivedAtMs) ||
			trip.receivedAtMs < trip.sentAtMs ||
			// One message is in flight at a time, so consecutive trips may not
			// overlap; without this, any number of long trips stacks into a
			// short window.
			trip.sentAtMs < previousReceivedAtMs - slackAt(trip.sentAtMs) ||
			trip.sentAtMs < firstSampleAtMs - slackAt(firstSampleAtMs) ||
			trip.receivedAtMs > lastSampleAtMs + slackAt(lastSampleAtMs)
		) {
			return { ok: false, code: "MEASUREMENT_OUTSIDE_GRANT_WINDOW" };
		}
		previousReceivedAtMs = trip.receivedAtMs;
		latencySumMs += trip.latencyMs;
	}
	const spanMs = lastSampleAtMs - firstSampleAtMs;
	// Each term carries its own rounding, so the sum's slack grows with the
	// number of terms.
	const sumSlack = slackAt(lastSampleAtMs) * (trips.length + 1);
	if (latencySumMs < -sumSlack || latencySumMs > spanMs + sumSlack) {
		return { ok: false, code: "MEASUREMENT_OUTSIDE_GRANT_WINDOW" };
	}
	// The declared window must be the window the trips occupy, or it is a third
	// statement standing beside two that already disagree with it.
	const first = trips[0] as MeasurementRoundTrip;
	const last = trips[trips.length - 1] as MeasurementRoundTrip;
	if (
		Math.abs(first.sentAtMs - firstSampleAtMs) > slackAt(firstSampleAtMs) ||
		Math.abs(last.receivedAtMs - lastSampleAtMs) > slackAt(lastSampleAtMs)
	) {
		return { ok: false, code: "MEASUREMENT_OUTSIDE_GRANT_WINDOW" };
	}
	return { ok: true, sampleCount: samples.length };
}

/**
 * The exact bytes an `artifact-payload` frame carries for one leg.
 *
 * One assembly point, so the payload the supervisor strict-parses is the
 * payload the driver produced -- not a selection of it made by whichever
 * caller happened to hold the leg. Canonical encoding, and the trailing
 * newline the Rust record parser accepts.
 */
export function measurementPayloadBytes(
	series: MeasurementSeries,
	grant: MeasurementGrantV1,
): Uint8Array {
	return canonicalRecordBytes({
		// The grant rides inside the payload rather than beside it, because the
		// payload is what the frame digests and what the supervisor
		// strict-parses. A grant carried in the header would be a claim about
		// bytes rather than a part of them.
		grant,
		samples: [...series.samples],
		roundTrips: series.roundTrips.map((trip) => ({
			sequence: trip.sequence,
			sentAtMs: trip.sentAtMs,
			receivedAtMs: trip.receivedAtMs,
			latencyMs: trip.latencyMs,
		})),
		ledger: series.ledger,
		provenance: series.provenance,
	});
}
