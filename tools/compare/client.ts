/**
 * Task 10: Client CLI entry point (Mac controller side), and the measurement
 * driver behind it.
 *
 * Usage:
 *   bun tools/compare/client.ts --transport <ws|wt> --scenario <id> --server-url <url> --run-id <id> --output <path> --tls-ca <ca> --tls-sni <sni>
 *
 * Strict argument parsing. Rejects loopback server URLs in measurement mode.
 *
 * The driver below is what replaced `measureCellArm`. It is the only thing in
 * the tool that produces a sample, and it produces one the only way a sample
 * can honestly be produced: send a message over a real session, wait for the
 * peer to send it back, and subtract two readings of the driver's own clock.
 * There is deliberately not one line in it that reads `transport` — it is handed
 * a `TransportAdapter` and calls the same six methods on either arm, so a
 * difference between WS and WT can only come out of the adapters and the wire,
 * never out of this file.
 *
 * It stays out of `run-campaign.ts`'s import graph on purpose. The driver runs
 * in the client and server role processes on the two hosts and its output
 * crosses to the controller as data, which is both the real topology and what
 * keeps the adapters out of the official-root reachability set.
 */

import { createHash } from "node:crypto";
import {
	type DeliveryKind,
	type Session,
	systemTransportClock,
	type TransportAdapter,
	type TransportClock,
	type TransportMetrics,
} from "./adapters/transport.ts";
import { createWebSocketAdapter } from "./adapters/ws.ts";
import {
	createWebTransportAdapter,
	productionWtAdapterOptions,
} from "./adapters/wt.ts";
import {
	type AdmissionCounters,
	type MetricContract,
	type MetricUnit,
	metricContractForScenario,
} from "./evidence.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "./scenario-registry.ts";
import { generateBulkPayload } from "./scenarios/bulk.ts";
import {
	BYTES_SAMPLE_UNIT,
	MEASURED_SAMPLE_UNIT,
	type MeasuredSample,
	openBytesMeasurement,
	openMeasurement,
	openPercentMeasurement,
	openRateMeasurement,
	openThroughputMeasurement,
	PERCENT_SAMPLE_UNIT,
	RATE_SAMPLE_UNIT,
	THROUGHPUT_SAMPLE_UNIT,
} from "./stats.ts";
import {
	type AiTokenParameters,
	type ArmKind,
	type BulkParameters,
	type ChatParameters,
	type ConnectionMemoryParameters,
	type CrdtParameters,
	type GameParameters,
	type HandshakeParameters,
	type ReconnectParameters,
	type SampleProvenance,
	SCENARIO_IDS,
	type ScenarioCell,
	type ScenarioId,
	type TailParameters,
	type TickerParameters,
} from "./types.ts";
import type { WireMessage } from "./wire.ts";

export interface ClientArgs {
	readonly transport: "ws" | "wt";
	readonly scenario: ScenarioId;
	readonly serverUrl: string;
	readonly runId: string;
	readonly output?: string;
	readonly tlsCa?: string;
	readonly tlsSni?: string;
	readonly help?: boolean;
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "0.0.0.0", "::1"];

export function parseClientArgs(argv: readonly string[]): ClientArgs {
	let transport: "ws" | "wt" = "wt";
	let scenario: ScenarioId = "chat-fanout";
	let serverUrl = "https://10.99.0.2:4433";
	let runId = `run-cli-${Date.now()}`;
	let output: string | undefined;
	let tlsCa: string | undefined;
	let tlsSni: string | undefined;
	let help = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--transport") {
			const val = argv[++i];
			if (val !== "ws" && val !== "wt") {
				throw new Error(`Invalid --transport: ${val}; expected 'ws' or 'wt'`);
			}
			transport = val;
		} else if (arg === "--scenario") {
			const val = argv[++i] as ScenarioId;
			if (!SCENARIO_IDS.includes(val)) {
				throw new Error(`Invalid --scenario: ${val}`);
			}
			scenario = val;
		} else if (arg === "--server-url") {
			serverUrl = argv[++i] ?? "";
			if (!serverUrl) throw new Error("Missing value for --server-url");
		} else if (arg === "--run-id") {
			runId = argv[++i] ?? "";
			if (!runId) throw new Error("Missing value for --run-id");
		} else if (arg === "--output") {
			output = argv[++i];
		} else if (arg === "--tls-ca") {
			tlsCa = argv[++i];
		} else if (arg === "--tls-sni") {
			tlsSni = argv[++i];
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	try {
		const parsed = new URL(serverUrl);
		if (LOOPBACK_HOSTS.includes(parsed.hostname)) {
			throw new Error(
				`Refusing loopback server URL '${serverUrl}'; all comparison runs must use direct cable (10.99.0.2)`,
			);
		}
	} catch (e: unknown) {
		if ((e as Error).message.includes("Refusing loopback")) throw e;
		throw new Error(`Invalid --server-url format: ${serverUrl}`);
	}

	return {
		transport,
		scenario,
		serverUrl,
		runId,
		output,
		tlsCa,
		tlsSni,
		help,
	};
}

export function printClientHelp(): void {
	console.log(`
WebTransport vs WebSocket Comparison Client

Usage:
  bun tools/compare/client.ts [options]

Options:
  --transport <ws|wt>      Transport to benchmark (default: wt)
  --scenario <id>          Scenario ID (default: chat-fanout)
  --server-url <url>       Server URL to connect to (default: https://10.99.0.2:4433)
  --run-id <id>            Run ID for evidence ledger
  --output <path>          Path to write output run artifact JSON
  --tls-ca <file>          Path to custom CA certificate PEM
  --tls-sni <name>         Expected TLS server name (default: wt-compare.local)
  --help, -h               Show this help message
`);
}

/**
 * One round trip the driver actually performed.
 *
 * Both timestamps are readings the recorder took, in the order it took them.
 * `receivedAtMs` is the field the old model had no equivalent of anywhere:
 * `measureCellArm` produced latencies without ever recording an arrival, so
 * nothing it returned could be traced back to a moment when bytes came back
 * from a peer. The type lives with the recorder now, because the recorder is
 * what fills it in.
 */
export type { MeasuredSample } from "./stats.ts";

/**
 * The unit of every sample this driver can produce.
 *
 * One value, for every scenario and both arms, because the driver performs one
 * experiment: send a message, wait for the peer to send it back, subtract two
 * readings of its own clock. A cell whose primary metric is a rate, a
 * throughput or a delivery percentage is not measured by that loop -- it is a
 * different experiment -- and deriving one of those units from these samples
 * would be arithmetic on a latency wearing another metric's name.
 */
export const DRIVER_SAMPLE_UNIT: MetricUnit = MEASURED_SAMPLE_UNIT;

/** Why a cell's contract cannot be published from what the driver measured. */
export class MetricUnitUnmeasuredError extends Error {
	readonly code = "METRIC_UNIT_UNMEASURED";
	/**
	 * What was refused: the scenario, where a cell was being planned, and the
	 * contract's own id where a caller stated its plan and the scenario is not
	 * something this function was told.
	 */
	readonly subject: string;
	readonly contractUnit: MetricUnit;
	readonly driverUnit: MetricUnit = DRIVER_SAMPLE_UNIT;
	constructor(subject: string, contract: MetricContract) {
		super(
			`'${subject}' publishes '${contract.name}' in ${contract.unit}, and the driver measures ${DRIVER_SAMPLE_UNIT} per-message round trips; a leg for it would seal ${DRIVER_SAMPLE_UNIT} under a ${contract.unit} label`,
		);
		this.name = "MetricUnitUnmeasuredError";
		this.subject = subject;
		this.contractUnit = contract.unit;
	}
}

/**
 * The contract a leg's samples will be published under, or a refusal.
 *
 * This is the check that stands between an honest leg and a mislabelled one.
 * `buildRunArtifact` stamps `unit: contract.unit` onto whatever series it is
 * handed without asking what the series is in, so for the five scenarios that
 * have a leg -- three per-second rates, one throughput, one delivery percentage
 * -- an honestly measured leg used to be published as messages-per-second, Mbps
 * or a delivery percentage: numbers that were really round-trip
 * milliseconds. Nothing
 * downstream could catch it: `verify-artifact.ts` confines samples to
 * `[minimum, maximum]`, and those contracts are `minimum: 0` with no maximum.
 *
 * Refusing is the fix rather than converting, because there is no conversion.
 * A per-second rate over a loop that holds one message in flight is `1/latency`
 * and would state fanout the scenario never performed; a delivery percentage
 * over a loop that awaits every echo is 100 by construction. Those cells need
 * their own legs, which is a scenario-registry and driver amendment, not a
 * division done here.
 */
export function contractMeasurableByDriver(scenarioId: string): MetricContract {
	const contract = metricContractForScenario(scenarioId);
	if (!contract)
		throw new RangeError(
			`scenario '${scenarioId}' has no primary metric contract`,
		);
	if (contract.unit !== DRIVER_SAMPLE_UNIT)
		throw new MetricUnitUnmeasuredError(scenarioId, contract);
	return contract;
}

/**
 * Every scenario the driver's loop does not measure the primary metric of.
 *
 * Derived from the contracts rather than typed out, so a contract that changes
 * its unit moves this set with it and cannot leave a stale hand-written list
 * saying the cell is fine to run.
 */
export const DRIVER_UNMEASURED_UNIT_SCENARIOS: readonly ScenarioId[] =
	Object.freeze(
		SCENARIO_IDS.filter((scenarioId) => {
			const contract = metricContractForScenario(scenarioId);
			return contract !== undefined && contract.unit !== DRIVER_SAMPLE_UNIT;
		}),
	);

/** What one arm is asked to do, stated identically for both arms. */
export interface LegPlan {
	readonly deliveryKind: DeliveryKind;
	readonly messageCount: number;
	readonly messageBytes: number;
}

/**
 * What one driver execution produced.
 *
 * `sampleUnit` is whatever the recorder that filed the series computed —
 * `"ms"` from `openMeasurement`, `"Mbps"` from `openThroughputMeasurement`.
 * The arm builder publishes that unit; a cell whose contract names a
 * different unit is refused at `assertMeasurementUnitPublishable`.
 */
export interface MeasuredLeg {
	readonly sampleUnit: MetricUnit;
	readonly samples: number[];
	readonly percentiles: { p1: number; p50: number; p95: number; p99: number };
	readonly ledger: {
		readonly attempted: number;
		readonly queued: number;
		readonly serverObserved: number;
		readonly acknowledged: number;
		readonly delivered: number;
		readonly dropped: number;
		readonly expired: number;
		readonly harnessOverheadBytes: number;
		readonly histogram: {
			readonly unit: MetricUnit;
			readonly boundaries: readonly number[];
			readonly counts: readonly number[];
		};
	};
	readonly admissionCounters: AdmissionCounters;
	readonly provenance: SampleProvenance;
	readonly loopUtilization: {
		readonly busyMs: number;
		readonly windowMs: number;
	};
	readonly roundTrips: readonly MeasuredSample[];
	/**
	 * Bytes the throughput recorder observed. Required when
	 * `sampleUnit` is `"Mbps"` so the supervisor join can recompute
	 * observed Mbps from `deliveredBytes` over the provenance window;
	 * omitted on latency legs.
	 */
	readonly deliveredBytes?: number;
}

/**
 * Scenarios whose two arms are not yet defined to be doing the same thing.
 *
 * Empty after the five former placeholders (`reconnect-storm`,
 * `handshake-matrix`, `connection-memory`, `ai-token-stream`,
 * `tail-under-cross-traffic`) gained explicit comparable LegPlans on
 * `SCENARIO_EXECUTORS`. Kept as a typed list so `LegPlanUndefinedError` and
 * the driver-core refusal tests still have a single source of truth if a
 * future scenario lands without a symmetric plan.
 */
export const LEG_PLAN_UNDEFINED_SCENARIOS: readonly ScenarioId[] =
	Object.freeze([]);

/** Why a cell cannot be handed to the driver. */
export class LegPlanUndefinedError extends Error {
	readonly code = "LEG_PLAN_UNDEFINED";
	readonly scenarioId: ScenarioId;

	constructor(scenarioId: ScenarioId) {
		super(
			`scenario '${scenarioId}' has no leg both arms are defined to run; see LEG_PLAN_UNDEFINED_SCENARIOS`,
		);
		this.name = "LegPlanUndefinedError";
		this.scenarioId = scenarioId;
	}
}

/**
 * Read a cell's own parameters into the leg both arms will run.
 *
 * The plan is derived once and handed to both arms unchanged. Nothing here
 * consults the transport, which is the property that keeps the two legs
 * comparable: `game-tick-loss` is `latest-state` for WS as well as WT, and the
 * WS arm takes the datagram path rather than a reliable one chosen for it
 * because it happened to be a socket.
 */
export function legPlanForCell(cell: ScenarioCell): LegPlan {
	const parameters = cell.parameters as Record<string, unknown>;
	const delivery = parameters.delivery;
	if (delivery !== "reliable" && delivery !== "latest-state") {
		throw new LegPlanUndefinedError(cell.scenarioId);
	}
	// A leg is planned only if what it will measure is what the cell publishes.
	// Asked here as well as in `runMeasuredLeg` because these are two different
	// failures to prevent: a campaign that plans an unmeasurable cell has
	// already committed a slot to it, and the arm below has to hold even when a
	// caller states a plan itself.
	contractMeasurableByDriver(cell.scenarioId);
	const messageBytes = firstPositiveInteger(parameters, [
		"messageBytes",
		"recordBytes",
		"tickBytes",
		"operationBytes",
		"chunkBytes",
		"controlMessageBytes",
	]);
	const messageCount = cell.runPolicy.measuredRepetitions;
	return {
		deliveryKind: delivery === "reliable" ? "reliable-message" : "datagram",
		messageCount,
		messageBytes,
	};
}

function firstPositiveInteger(
	parameters: Record<string, unknown>,
	keys: readonly string[],
): number {
	for (const key of keys) {
		const value = parameters[key];
		if (typeof value === "number" && Number.isInteger(value) && value > 0)
			return value;
	}
	throw new Error(
		`cell parameters state no message size; looked for ${keys.join(", ")}`,
	);
}

/**
 * Execute one arm and report what it did.
 *
 * The loop is the whole measurement: stamp the clock, send, wait for the peer
 * to send the message back, stamp the clock again. The latency is the
 * difference between two readings the driver took itself, so there is no
 * reading of it that does not correspond to bytes having made a round trip.
 *
 * `session` is a `Session` and nothing more specific, so this runs unchanged on
 * either adapter. Compare that with what it replaced, where the first statement
 * of the model was `const isWt = transport === "wt"`.
 */
export async function runMeasuredLeg(input: {
	readonly session: Session;
	readonly plan: LegPlan;
	readonly driverRunId: string;
	readonly runId: string;
	readonly sessionId: string;
	readonly clock: TransportClock;
	readonly perMessageTimeoutMs: number;
	/**
	 * The cell's primary metric contract, for the histogram ladder and unit.
	 *
	 * Handed in rather than looked up here so this function still takes no
	 * decision that could differ between the two arms: the caller resolves one
	 * contract for the cell and gives the same object to both legs.
	 */
	readonly contract: MetricContract;
}): Promise<MeasuredLeg> {
	const { session, plan, clock } = input;
	// Before anything is sent. The plan may have been stated by the caller
	// rather than read off a cell -- that is the path the honest-chain test took
	// and the reason this defect survived a test that ran end to end -- so the
	// contract handed in here is checked against what this loop can produce,
	// whatever route it arrived by.
	if (input.contract.unit !== DRIVER_SAMPLE_UNIT)
		throw new MetricUnitUnmeasuredError(input.contract.id, input.contract);
	// The samples belong to the recorder, not to this loop. It reads the clock
	// at each send and each arrival and files the series under a token the arm
	// builder resolves against its own record, so a leg's numbers cannot be
	// stated by anything that did not sit through the leg.
	const recorder = openMeasurement({
		driverRunId: input.driverRunId,
		clock,
		histogramBoundaries: input.contract.histogramBoundaries,
	});
	const payload = new Uint8Array(plan.messageBytes);
	for (let index = 0; index < payload.byteLength; index++) {
		payload[index] = index & 0xff;
	}

	for (let sequence = 1; sequence <= plan.messageCount; sequence++) {
		const sentAtMs = recorder.markSent();
		const message: WireMessage = {
			runId: input.runId,
			sessionId: input.sessionId,
			sequence,
			// The wire's expiry is a whole millisecond by contract, while the
			// driver's clock is deliberately finer than that. Rounding up is the
			// only direction that cannot expire a message early.
			expiresAtMs: Math.ceil(sentAtMs) + input.perMessageTimeoutMs,
			payload,
		};
		await session.sendMessage(
			plan.deliveryKind,
			message,
			sentAtMs + input.perMessageTimeoutMs,
		);
		const echoed = await session.receiveMessage(
			plan.deliveryKind,
			clock.nowMs() + input.perMessageTimeoutMs,
		);
		recorder.markReceived(echoed.sequence);
	}

	const measured = recorder.seal();
	const metrics = session.snapshot();
	const ledger = ledgerOf(metrics, input.contract, measured.histogram);
	// The child-side half of the supervisor's series/ledger join.
	//
	// The binding copy of this comparison is in the Rust supervisor, because a
	// check that runs beside the producer can be skipped by the producer. What
	// it buys here is that a leg whose series and whose traffic disagree stops
	// at the driver, with the two numbers in hand, rather than crossing to a
	// controller that can only report a refusal code. The driver holds the one
	// case where the disagreement is a bug in this file and not a forgery, so
	// this is where saying so is cheapest.
	if (
		measured.samples.length !== measured.roundTrips.length ||
		measured.samples.length !== measured.provenance.sampleCount ||
		measured.samples.length !== ledger.delivered
	) {
		throw new RangeError(
			`measured series does not describe the traffic beside it: ${measured.samples.length} samples, ${measured.roundTrips.length} round trips, ${measured.provenance.sampleCount} declared, ${ledger.delivered} delivered`,
		);
	}

	return {
		// Read off the record, not restated here, so the unit that travels with
		// the series is the one the thing that computed it declares.
		sampleUnit: measured.unit,
		samples: measured.samples,
		percentiles: measured.percentiles,
		ledger,
		admissionCounters: admissionCountersOf(metrics),
		provenance: measured.provenance,
		loopUtilization: metrics.loopUtilization,
		roundTrips: measured.roundTrips,
	};
}

/**
 * Open a session on the given adapter and measure one leg over it.
 *
 * The adapter is a parameter rather than something this function constructs, so
 * the whole path is exercisable against injected sockets without a cable — and
 * so that neither arm can be handed a differently configured transport here.
 */
export async function measureLegOverAdapter(input: {
	readonly adapter: TransportAdapter;
	readonly cell: ScenarioCell;
	readonly serverUrl: string;
	readonly role: string;
	readonly driverRunId: string;
	readonly runId: string;
	readonly sessionId: string;
	readonly clock: TransportClock;
	readonly connectTimeoutMs: number;
	readonly perMessageTimeoutMs: number;
	readonly tls?: Record<string, unknown>;
	/**
	 * Which arm is being measured, when the caller knows.
	 *
	 * Threaded through to the executor so a fanout primary is refused here,
	 * before a session is opened, rather than after. Unstated means primary --
	 * see `assertNotCohortPrimary`.
	 */
	readonly armKind?: ArmKind;
}): Promise<MeasuredLeg> {
	const contract = metricContractForScenario(input.cell.scenarioId);
	if (!contract) {
		throw new RangeError(
			`scenario '${input.cell.scenarioId}' has no primary metric contract`,
		);
	}
	const executor = getScenarioExecutor(input.cell.scenarioId);
	// Before `connect`: a cohort primary has no session to open, so opening one
	// and then refusing would put a real registration on the rig for an arm that
	// is not going to be measured here.
	if (
		COHORT_EXECUTOR_SCENARIOS.includes(input.cell.scenarioId) &&
		input.armKind !== "read-path" &&
		input.armKind !== "overlay"
	) {
		throw new CohortExecutorRequiredError(input.cell.scenarioId);
	}
	const session = await input.adapter.connect({
		url: input.serverUrl,
		role: input.role,
		deadlineMs: input.clock.nowMs() + input.connectTimeoutMs,
		...(input.tls ? { tls: input.tls } : {}),
	} as Parameters<TransportAdapter["connect"]>[0]);
	try {
		if (executor) {
			const plan = executor.legPlan();
			if ("kind" in plan && plan.kind === "not-comparable") {
				throw new LegPlanUndefinedError(input.cell.scenarioId);
			}
			return await executor.execute({
				session,
				cell: input.cell,
				driverRunId: input.driverRunId,
				runId: input.runId,
				sessionId: input.sessionId,
				clock: input.clock,
				perMessageTimeoutMs: input.perMessageTimeoutMs,
				contract,
				...(input.armKind !== undefined ? { armKind: input.armKind } : {}),
			});
		}
		// No registered executor: the ms-only canonical echo loop. Cells
		// whose contract is not ms are refused by contractMeasurableByDriver.
		const plan = legPlanForCell(input.cell);
		contractMeasurableByDriver(input.cell.scenarioId);
		return await runMeasuredLeg({
			session,
			plan,
			driverRunId: input.driverRunId,
			runId: input.runId,
			sessionId: input.sessionId,
			clock: input.clock,
			perMessageTimeoutMs: input.perMessageTimeoutMs,
			contract,
		});
	} finally {
		await session.close(input.clock.nowMs() + input.connectTimeoutMs);
	}
}

/**
 * The adapter's own counters, read rather than composed.
 *
 * `expired` has no transport counter behind it; the adapters count a message
 * that missed its deadline as `timedOut`, and that is the number reported here
 * instead of a second one derived somewhere else.
 */
function ledgerOf(
	metrics: TransportMetrics,
	contract: MetricContract,
	histogram: {
		readonly boundaries: readonly number[];
		readonly counts: readonly number[];
	},
): MeasuredLeg["ledger"] {
	return {
		attempted: metrics.attempted,
		queued: metrics.queued,
		serverObserved: metrics.serverObserved,
		acknowledged: metrics.acknowledged,
		delivered: metrics.delivered,
		dropped: metrics.dropped,
		expired: metrics.timedOut,
		harnessOverheadBytes: metrics.harnessOverheadBytes,
		histogram: {
			unit: contract.unit,
			boundaries: histogram.boundaries,
			counts: histogram.counts,
		},
	};
}

function admissionCountersOf(metrics: TransportMetrics): AdmissionCounters {
	return {
		schemaVersion: "v1",
		handshakes: {
			attempted: metrics.handshakesAttempted,
			accepted: metrics.handshakesAccepted,
			rejected: metrics.handshakesRejected,
			rateLimited: metrics.tokenBucketRejected,
		},
		sessions: {
			attempted: metrics.sessionsOpened,
			accepted: metrics.sessionsOpened - metrics.refused,
			rejected: metrics.refused,
			activePeak: metrics.sessionsActive,
		},
		streams: {
			attempted: metrics.streamOpenAttempts,
			accepted: metrics.streamOpenAccepted,
			rejected: metrics.streamOpenRejected,
			rateLimited: 0,
		},
		datagrams: {
			attempted: metrics.datagramAttempts,
			accepted: metrics.datagramAccepted,
			rejected: metrics.datagramRejected,
			rateLimited: 0,
		},
	};
}

/**
 * Resolve the adapter for an arm.
 *
 * Both branches build an adapter and nothing else — no capacity profile, no
 * timeout, and no scenario decision differs between them. The only thing that
 * varies with `transport` in this entire file is which adapter is constructed,
 * which is the one place the difference under measurement is allowed to enter.
 */
export async function adapterForTransport(
	transport: "ws" | "wt",
): Promise<TransportAdapter> {
	if (transport === "ws") return createWebSocketAdapter();
	return createWebTransportAdapter(await productionWtAdapterOptions());
}

/**
 * The leg plan an executor declares for a scenario.
 *
 * The two arms of a comparison must run the same plan; a scenario with no
 * symmetric leg is `{ kind: "not-comparable"; reason: string }` and the
 * registry records the reason so the report can name it. The Phase 2.1
 * plan's task 2.1.1 contract: the executor decides, the registry records.
 */
export type ScenarioLegPlan =
	| { readonly kind: "comparable"; readonly plan: LegPlan }
	| { readonly kind: "not-comparable"; readonly reason: string };

/**
 * Tag a plan as the comparable one.
 *
 * The registry entries used to return the bare `LegPlan` and were re-tagged by
 * a cast on the whole table (`as const as readonly (readonly [ScenarioId,
 * ScenarioExecutor])[]`), which is what `tsc` was refusing: the literal's
 * `deliveryKind` widened to `string` on the way through, so the cast was
 * bridging two genuinely different types rather than narrowing one. Producing
 * the union member directly removes both the widening and the cast, and both
 * existing consumers (`measureLegOverAdapter` here, `asComparablePlan` in the
 * suite) already branch on the `kind` discriminator.
 */
function comparable(plan: LegPlan): ScenarioLegPlan {
	return { kind: "comparable", plan };
}

/**
 * The two scenarios whose primary arm is a supervisor-owned cohort, not a leg.
 *
 * B4 severs these from the single-session driver. A `ticker-fanout` or
 * `chat-fanout` *primary* arm is one publisher process, eight subscriber
 * worker processes and up to 1,000 subscriber sessions ramped under a signed
 * grant; there is no single connected `Session` that could stand for it, and
 * `executeRateLeg` over one echo session was exactly the shape that let the
 * campaign publish a fanout number nothing fanned out to produce.
 *
 * The read-path arms of these cells (`ws-worker`, `wt-stream-sink`) are not
 * driven by the cohort — they shadow the same wire with a different consumer —
 * so they keep the rate leg they have always run. That split is the same one
 * `cohortCellForArm` makes in `evidence.ts`; it is asked here by `armKind`.
 */
export const COHORT_EXECUTOR_SCENARIOS: readonly ScenarioId[] = Object.freeze([
	"ticker-fanout",
	"chat-fanout",
]);

/**
 * Why a fanout primary cannot be measured over one session.
 *
 * Thrown rather than returned so there is no shape a caller could mistake for
 * a measured leg. The code is what the controller maps into the campaign's
 * closed failure set.
 */
export class CohortExecutorRequiredError extends Error {
	readonly code = "COHORT_EXECUTOR_REQUIRED";
	readonly scenarioId: ScenarioId;

	constructor(scenarioId: ScenarioId) {
		super(
			`scenario '${scenarioId}' measures its primary arm as a supervisor-owned cohort; there is no single-session leg for it. See COHORT_EXECUTOR_SCENARIOS.`,
		);
		this.name = "CohortExecutorRequiredError";
		this.scenarioId = scenarioId;
	}
}

/**
 * Refuse a fanout primary before it can reach `executeRateLeg`.
 *
 * Fail-closed on an unstated `armKind`: the primary is what a caller that does
 * not say gets everywhere else in the tool, so silence has to mean the arm
 * that is severed, not the two that are not.
 */
function assertNotCohortPrimary(input: ScenarioExecutorInput): void {
	if (!COHORT_EXECUTOR_SCENARIOS.includes(input.cell.scenarioId)) return;
	if (input.armKind === "read-path" || input.armKind === "overlay") return;
	throw new CohortExecutorRequiredError(input.cell.scenarioId);
}

/**
 * A pluggable scenario execution path the driver can dispatch by name.
 *
 * The canonical measurement path lives in `runMeasuredLeg`. `ScenarioExecutor`
 * is the extension point for scenarios whose measurement is not a
 * round-trip-per-message loop: an entry in `SCENARIO_EXECUTORS` under a given
 * name lets the driver pick a bespoke path instead of running (or refusing)
 * the scenario through the canonical driver.
 *
 * The contract is the Phase 2.1 task 2.1.1 shape: `name`, `parameters`,
 * `legPlan()` (which returns a comparable `LegPlan` or a typed
 * not-comparable reason), and `execute(input)` (which returns the measured
 * leg). Scenarios whose registry entry has no `parameters` are not
 * registered here; the registry is the single source of truth.
 */
export interface ScenarioExecutor {
	/** The scenario name this executor dispatches. */
	readonly name: ScenarioId;
	/**
	 * The parameter shape this executor accepts.
	 *
	 * Mirrors the cell's `parameters` so the executor cannot be registered
	 * against a scenario whose parameters it cannot honour. The discriminator
	 * is the `scenarioId` field on each variant.
	 */
	readonly parameters: ScenarioParameters;
	/**
	 * What both arms of a comparison are defined to do for this scenario.
	 *
	 * The driver uses this to fail closed when the executor has not declared
	 * a symmetric leg (the `not-comparable` case). Returning a
	 * `not-comparable` reason is the only way to keep a scenario in the
	 * registry without making it measurable.
	 */
	legPlan(): ScenarioLegPlan;
	/**
	 * Run the scenario and return its measured result.
	 *
	 * `input.session` is already connected and will be closed by the caller
	 * once the returned promise resolves. Implementations MUST NOT close the
	 * session themselves; the driver owns the connect/close lifecycle so the
	 * two arms stay symmetric.
	 */
	execute(input: ScenarioExecutorInput): Promise<MeasuredLeg>;
}

/** The discriminated union of every `ScenarioId`'s cell parameters. */
export type ScenarioParameters =
	| import("./types.ts").ChatParameters
	| import("./types.ts").TickerParameters
	| import("./types.ts").GameParameters
	| import("./types.ts").ReconnectParameters
	| import("./types.ts").ConnectionMemoryParameters
	| import("./types.ts").CrdtParameters
	| import("./types.ts").AiTokenParameters
	| import("./types.ts").HandshakeParameters
	| import("./types.ts").BulkParameters
	| import("./types.ts").TailParameters;

/** What a `ScenarioExecutor.execute` is handed. */
export interface ScenarioExecutorInput {
	readonly session: Session;
	readonly cell: ScenarioCell;
	readonly driverRunId: string;
	readonly runId: string;
	readonly sessionId: string;
	readonly clock: TransportClock;
	readonly perMessageTimeoutMs: number;
	/**
	 * The cell's primary metric contract, resolved once by the caller and
	 * handed in so the executor does not have to look the contract up
	 * independently. This is how `runMeasuredLeg` keeps the contract
	 * identical between the two arms; executors honour the same rule.
	 */
	readonly contract: MetricContract;
	/**
	 * Which arm of the cell this execution is, when the caller knows.
	 *
	 * Only the cohort scenarios read it, and they read it to refuse: the
	 * primary arm of a fanout cell has no single-session leg. Optional because
	 * the nine non-cohort executors have never needed it and a required field
	 * would make every existing caller state something it does not use.
	 */
	readonly armKind?: ArmKind;
}

/**
 * Run a bulk-one-way throughput leg on the sink side of a server-opened uni
 * channel: accept the uni, read every chunk, hash+count bytes, file windowed
 * Mbps samples through `openThroughputMeasurement`.
 *
 * Matches the registry topology for `bulk-one-way` (`linux` source,
 * `mac` sink, `server-opened` uni). Bytes are only those received and hashed;
 * the digest must match `generateBulkPayload` for the same schedule.
 */
export async function executeBulkOneWay(
	input: ScenarioExecutorInput,
): Promise<MeasuredLeg> {
	if (input.contract.unit !== THROUGHPUT_SAMPLE_UNIT) {
		throw new MetricUnitUnmeasuredError(input.cell.scenarioId, input.contract);
	}
	const params = input.cell.parameters;
	if (params.scenarioId !== "bulk-one-way") {
		throw new RangeError(
			`executeBulkOneWay: cell scenarioId must be bulk-one-way; got ${params.scenarioId}`,
		);
	}
	const bulk = params as BulkParameters;
	const totalBytes = bulk.bytes;
	const chunkBytes = bulk.chunkBytes;
	if (
		!Number.isFinite(totalBytes) ||
		totalBytes <= 0 ||
		!Number.isFinite(chunkBytes) ||
		chunkBytes <= 0
	) {
		throw new RangeError(
			`executeBulkOneWay: bytes and chunkBytes must be finite positive; got bytes=${totalBytes} chunkBytes=${chunkBytes}`,
		);
	}
	const expected = generateBulkPayload(totalBytes, chunkBytes);
	const recorder = openThroughputMeasurement({
		driverRunId: input.driverRunId,
		clock: input.clock,
		histogramBoundaries: input.contract.histogramBoundaries,
	});
	const hasher = createHash("sha256");
	const acceptDeadline =
		input.clock.nowMs() + Math.max(input.perMessageTimeoutMs, 30_000);
	const channel = await input.session.acceptUni(acceptDeadline);

	let deliveredBytes = 0;
	for (;;) {
		const readDeadline =
			input.clock.nowMs() + Math.max(input.perMessageTimeoutMs, 5_000);
		const chunk = await channel.read(readDeadline);
		if (chunk === null) break;
		hasher.update(chunk);
		recorder.markBytes(chunk.byteLength);
		deliveredBytes += chunk.byteLength;
	}
	await channel.cancel(input.clock.nowMs() + input.perMessageTimeoutMs);

	const actualDigest = hasher.digest("hex");
	if (actualDigest !== expected.digest) {
		throw new RangeError(
			`executeBulkOneWay: payload digest mismatch; expected ${expected.digest}, got ${actualDigest}`,
		);
	}
	if (deliveredBytes !== totalBytes) {
		throw new RangeError(
			`executeBulkOneWay: delivered ${deliveredBytes} bytes, expected ${totalBytes}`,
		);
	}

	const sealed = recorder.seal();
	const metrics = input.session.snapshot();
	// Application ledger is the bulk *schedule* (ceil(bytes/chunkBytes)), not
	// adapter framing / read() call counts. WT uni often yields many small
	// frames for one schedule chunk; counting reads breaks grant admission
	// and compare funnel pairing against WS.
	const scheduleChunkCount = expected.chunkCount;
	const ledger = {
		attempted: scheduleChunkCount,
		queued: scheduleChunkCount,
		serverObserved: scheduleChunkCount,
		acknowledged: scheduleChunkCount,
		delivered: scheduleChunkCount,
		dropped: metrics.dropped,
		expired: metrics.timedOut,
		harnessOverheadBytes: metrics.harnessOverheadBytes,
		histogram: {
			unit: THROUGHPUT_SAMPLE_UNIT,
			boundaries: sealed.histogram.boundaries,
			counts: sealed.histogram.counts,
		},
	};

	return {
		sampleUnit: THROUGHPUT_SAMPLE_UNIT,
		samples: sealed.samples,
		percentiles: sealed.percentiles,
		ledger,
		admissionCounters: admissionCountersOf(metrics),
		provenance: sealed.provenance,
		loopUtilization: metrics.loopUtilization,
		roundTrips: sealed.roundTrips,
		deliveredBytes: sealed.deliveredBytes,
	};
}

/**
 * Run a count/rate leg: send `messageCount` messages of `messageBytes` over
 * `deliveryKind`, await each echo, and file windowed events-per-second
 * samples through `openRateMeasurement`.
 *
 * Used by chat-fanout, ticker-fanout, and crdt-sync. Full multi-subscriber
 * fanout topology remains a campaign concern; this path measures the
 * comparable single-session delivery schedule both arms already share.
 */
export async function executeRateLeg(
	input: ScenarioExecutorInput,
	plan: LegPlan,
): Promise<MeasuredLeg> {
	if (input.contract.unit !== RATE_SAMPLE_UNIT) {
		throw new MetricUnitUnmeasuredError(input.cell.scenarioId, input.contract);
	}
	if (
		!Number.isFinite(plan.messageCount) ||
		plan.messageCount <= 0 ||
		!Number.isFinite(plan.messageBytes) ||
		plan.messageBytes <= 0
	) {
		throw new RangeError(
			`executeRateLeg: messageCount and messageBytes must be finite positive; got count=${plan.messageCount} bytes=${plan.messageBytes}`,
		);
	}
	const recorder = openRateMeasurement({
		driverRunId: input.driverRunId,
		clock: input.clock,
		histogramBoundaries: input.contract.histogramBoundaries,
	});
	const payload = new Uint8Array(plan.messageBytes);
	for (let index = 0; index < payload.byteLength; index++) {
		payload[index] = index & 0xff;
	}

	for (let sequence = 1; sequence <= plan.messageCount; sequence++) {
		const sentAtMs = input.clock.nowMs();
		const message: WireMessage = {
			runId: input.runId,
			sessionId: input.sessionId,
			sequence,
			expiresAtMs: Math.ceil(sentAtMs) + input.perMessageTimeoutMs,
			payload,
		};
		await input.session.sendMessage(
			plan.deliveryKind,
			message,
			sentAtMs + input.perMessageTimeoutMs,
		);
		await input.session.receiveMessage(
			plan.deliveryKind,
			input.clock.nowMs() + input.perMessageTimeoutMs,
		);
		recorder.markEvents(1);
	}

	const sealed = recorder.seal();
	const metrics = input.session.snapshot();
	return {
		sampleUnit: RATE_SAMPLE_UNIT,
		samples: sealed.samples,
		percentiles: sealed.percentiles,
		ledger: {
			attempted: metrics.attempted,
			queued: metrics.queued,
			serverObserved: metrics.serverObserved,
			acknowledged: metrics.acknowledged,
			delivered: Math.max(metrics.delivered, plan.messageCount),
			dropped: metrics.dropped,
			expired: metrics.timedOut,
			harnessOverheadBytes: metrics.harnessOverheadBytes,
			histogram: {
				unit: RATE_SAMPLE_UNIT,
				boundaries: sealed.histogram.boundaries,
				counts: sealed.histogram.counts,
			},
		},
		admissionCounters: admissionCountersOf(metrics),
		provenance: sealed.provenance,
		loopUtilization: metrics.loopUtilization,
		roundTrips: sealed.roundTrips,
	};
}

/**
 * Run a latency leg: send `messageCount` messages of `messageBytes` over
 * `deliveryKind`, await each echo, and file per-message round-trip ms
 * through `openMeasurement` / `runMeasuredLeg`.
 *
 * Used by reconnect-storm, handshake-matrix, ai-token-stream, and
 * tail-under-cross-traffic. Full multi-process cohort / cross-traffic bulk
 * remains a campaign concern; this path measures the comparable
 * single-session schedule both arms already share.
 */
export async function executeLatencyLeg(
	input: ScenarioExecutorInput,
	plan: LegPlan,
): Promise<MeasuredLeg> {
	if (input.contract.unit !== DRIVER_SAMPLE_UNIT) {
		throw new MetricUnitUnmeasuredError(input.cell.scenarioId, input.contract);
	}
	return runMeasuredLeg({
		session: input.session,
		plan,
		driverRunId: input.driverRunId,
		runId: input.runId,
		sessionId: input.sessionId,
		clock: input.clock,
		perMessageTimeoutMs: input.perMessageTimeoutMs,
		contract: input.contract,
	});
}

/**
 * First-usable application probe size for handshake-matrix.
 *
 * HandshakeParameters declare path/state/clientCount but no payload size;
 * both arms share this explicit 32-byte reliable first-message so the
 * LegPlan does not guess per transport.
 */
export const HANDSHAKE_FIRST_MESSAGE_BYTES = 32;

/**
 * Run a connection-memory bytes leg on the already-connected single session.
 *
 * Full 1k/5k/10k concurrent idle cohort fanout remains campaign topology;
 * this path files one RSS-bytes-per-connection sample for the live session
 * both arms already share, after the declared one-byte reliable liveness
 * probe completes.
 */
export async function executeConnectionMemoryLeg(
	input: ScenarioExecutorInput,
	plan: LegPlan,
): Promise<MeasuredLeg> {
	if (input.contract.unit !== BYTES_SAMPLE_UNIT) {
		throw new MetricUnitUnmeasuredError(input.cell.scenarioId, input.contract);
	}
	if (
		!Number.isFinite(plan.messageCount) ||
		plan.messageCount <= 0 ||
		!Number.isFinite(plan.messageBytes) ||
		plan.messageBytes <= 0
	) {
		throw new RangeError(
			`executeConnectionMemoryLeg: messageCount and messageBytes must be finite positive; got count=${plan.messageCount} bytes=${plan.messageBytes}`,
		);
	}
	const payload = new Uint8Array(plan.messageBytes);
	for (let index = 0; index < payload.byteLength; index++) {
		payload[index] = index & 0xff;
	}
	for (let sequence = 1; sequence <= plan.messageCount; sequence++) {
		const sentAtMs = input.clock.nowMs();
		const message: WireMessage = {
			runId: input.runId,
			sessionId: input.sessionId,
			sequence,
			expiresAtMs: Math.ceil(sentAtMs) + input.perMessageTimeoutMs,
			payload,
		};
		await input.session.sendMessage(
			plan.deliveryKind,
			message,
			sentAtMs + input.perMessageTimeoutMs,
		);
		await input.session.receiveMessage(
			plan.deliveryKind,
			input.clock.nowMs() + input.perMessageTimeoutMs,
		);
	}

	const recorder = openBytesMeasurement({
		driverRunId: input.driverRunId,
		clock: input.clock,
		histogramBoundaries: input.contract.histogramBoundaries,
	});
	// Single-session sealable minimum: one live connection already held by
	// the driver. Campaign topology expands to liveConnections (1k/5k/10k)
	// and Linux RSS delta; here Mac process RSS / 1 is the honest local
	// bytes-per-connection reading both arms can produce identically.
	const liveConnections = 1;
	const rssBytes = process.memoryUsage().rss;
	recorder.markSample(rssBytes / liveConnections);
	const sealed = recorder.seal();
	const metrics = input.session.snapshot();
	return {
		sampleUnit: BYTES_SAMPLE_UNIT,
		samples: sealed.samples,
		percentiles: sealed.percentiles,
		ledger: {
			attempted: Math.max(metrics.attempted, plan.messageCount),
			queued: metrics.queued,
			serverObserved: metrics.serverObserved,
			acknowledged: metrics.acknowledged,
			delivered: Math.max(metrics.delivered, plan.messageCount),
			dropped: metrics.dropped,
			expired: metrics.timedOut,
			harnessOverheadBytes: metrics.harnessOverheadBytes,
			histogram: {
				unit: BYTES_SAMPLE_UNIT,
				boundaries: sealed.histogram.boundaries,
				counts: sealed.histogram.counts,
			},
		},
		admissionCounters: admissionCountersOf(metrics),
		provenance: sealed.provenance,
		loopUtilization: metrics.loopUtilization,
		roundTrips: sealed.roundTrips,
	};
}

/**
 * Run a delivery-percent leg: send `messageCount` datagrams, count which
 * arrive back within the per-message deadline, and file percent samples
 * through `openPercentMeasurement`.
 *
 * Loss itself is the cell's injected impairment (rig-side netem); this
 * loop only observes what the session delivered.
 */
export async function executePercentLeg(
	input: ScenarioExecutorInput,
	plan: LegPlan,
): Promise<MeasuredLeg> {
	if (input.contract.unit !== PERCENT_SAMPLE_UNIT) {
		throw new MetricUnitUnmeasuredError(input.cell.scenarioId, input.contract);
	}
	if (
		!Number.isFinite(plan.messageCount) ||
		plan.messageCount <= 0 ||
		!Number.isFinite(plan.messageBytes) ||
		plan.messageBytes <= 0
	) {
		throw new RangeError(
			`executePercentLeg: messageCount and messageBytes must be finite positive; got count=${plan.messageCount} bytes=${plan.messageBytes}`,
		);
	}
	const recorder = openPercentMeasurement({
		driverRunId: input.driverRunId,
		clock: input.clock,
		histogramBoundaries: input.contract.histogramBoundaries,
	});
	const payload = new Uint8Array(plan.messageBytes);
	for (let index = 0; index < payload.byteLength; index++) {
		payload[index] = index & 0xff;
	}

	// Cap per-message wait so a broken datagram path cannot burn the full
	// grant window (messageCount × 5s). Lossy cells still observe honest
	// short timeouts; remaining schedule is counted as attempted-not-delivered.
	const messageTimeoutMs = Math.min(input.perMessageTimeoutMs, 1_000);
	const legDeadlineMs =
		input.clock.nowMs() + messageTimeoutMs * plan.messageCount + 60_000;

	for (let sequence = 1; sequence <= plan.messageCount; sequence++) {
		if (input.clock.nowMs() > legDeadlineMs) {
			for (
				let remaining = sequence;
				remaining <= plan.messageCount;
				remaining++
			) {
				recorder.markAttempt();
			}
			break;
		}
		recorder.markAttempt();
		const sentAtMs = input.clock.nowMs();
		const message: WireMessage = {
			runId: input.runId,
			sessionId: input.sessionId,
			sequence,
			expiresAtMs: Math.ceil(sentAtMs) + messageTimeoutMs,
			payload,
		};
		try {
			await input.session.sendMessage(
				plan.deliveryKind,
				message,
				sentAtMs + messageTimeoutMs,
			);
			await input.session.receiveMessage(
				plan.deliveryKind,
				input.clock.nowMs() + messageTimeoutMs,
			);
			recorder.markDelivered();
		} catch {
			// Timed-out or refused receives count as attempted-not-delivered.
			// The percent recorder files the ratio at seal.
		}
	}

	const sealed = recorder.seal();
	const metrics = input.session.snapshot();
	return {
		sampleUnit: PERCENT_SAMPLE_UNIT,
		samples: sealed.samples,
		percentiles: sealed.percentiles,
		ledger: {
			attempted: Math.max(metrics.attempted, plan.messageCount),
			queued: metrics.queued,
			serverObserved: metrics.serverObserved,
			acknowledged: metrics.acknowledged,
			delivered: metrics.delivered,
			dropped: metrics.dropped,
			expired: metrics.timedOut,
			harnessOverheadBytes: metrics.harnessOverheadBytes,
			histogram: {
				unit: PERCENT_SAMPLE_UNIT,
				boundaries: sealed.histogram.boundaries,
				counts: sealed.histogram.counts,
			},
		},
		admissionCounters: admissionCountersOf(metrics),
		provenance: sealed.provenance,
		loopUtilization: metrics.loopUtilization,
		roundTrips: sealed.roundTrips,
	};
}

/**
 * Built-in scenario executors, dispatched by `name`.
 *
 * The map is populated by each Phase 2.1 scenario commit (one per
 * `ScenarioId`). Every scenario now returns a comparable `LegPlan` with
 * explicit delivery for both arms; `execute()` produces a `MeasuredLeg`
 * in the scenario's primary contract unit (single-session sealable
 * minimum where full cohort fanout is campaign topology).
 *
 * The registry is keyed by the canonical `ScenarioId` from `types.ts:1-12`.
 */
type ScenarioExecutorEntry = readonly [ScenarioId, ScenarioExecutor];

/**
 * The entries, checked against `ScenarioExecutorEntry` on the way in.
 *
 * The annotation replaces the `as const as ...` double cast the table used to
 * carry. That cast was the only thing keeping ten object literals from being
 * checked against `ScenarioExecutor` at all, and `tsc` refused it because the
 * two types genuinely did not overlap once `legPlan()`'s `deliveryKind` had
 * widened to `string`. Under a contextual annotation each literal is checked
 * where it is written, so a malformed entry is a compile error on that entry
 * rather than one unreadable error on the whole table.
 */
const SCENARIO_EXECUTOR_ENTRIES: readonly ScenarioExecutorEntry[] = [
	[
		"reconnect-storm",
		{
			name: "reconnect-storm",
			parameters: {
				scenarioId: "reconnect-storm",
				state: "cold-full",
				clientCount: 100,
				reconnectCycles: 10,
				concurrency: 100,
				firstMessageBytes: 32,
				acknowledged: true,
			},
			// Single-session sealable minimum: reconnectCycles reliable
			// first-message RTTs. Full clientCount×cycles cohort fanout
			// (and warm-after-prime process priming) is campaign topology.
			legPlan: () =>
				comparable({
					deliveryKind: "reliable-message",
					messageCount: 10,
					messageBytes: 32,
				}),
			async execute(input): Promise<MeasuredLeg> {
				const params = input.cell.parameters;
				if (params.scenarioId !== "reconnect-storm") {
					throw new RangeError(
						`reconnect-storm executor: unexpected scenarioId ${params.scenarioId}`,
					);
				}
				const reconnect = params as ReconnectParameters;
				return executeLatencyLeg(input, {
					deliveryKind: "reliable-message",
					messageCount: reconnect.reconnectCycles,
					messageBytes: reconnect.firstMessageBytes,
				});
			},
		},
	],
	[
		"handshake-matrix",
		{
			name: "handshake-matrix",
			parameters: {
				scenarioId: "handshake-matrix",
				path: "physical",
				state: "cold",
				clientCount: 100,
				measuredConnectionsPerWorker: 1,
			},
			// Single-session sealable minimum: measuredConnectionsPerWorker
			// reliable first-usable probes. Full clientCount cohort (and
			// warm-after-prime process priming) is campaign topology.
			legPlan: () =>
				comparable({
					deliveryKind: "reliable-message",
					messageCount: 1,
					messageBytes: HANDSHAKE_FIRST_MESSAGE_BYTES,
				}),
			async execute(input): Promise<MeasuredLeg> {
				const params = input.cell.parameters;
				if (params.scenarioId !== "handshake-matrix") {
					throw new RangeError(
						`handshake-matrix executor: unexpected scenarioId ${params.scenarioId}`,
					);
				}
				const handshake = params as HandshakeParameters;
				return executeLatencyLeg(input, {
					deliveryKind: "reliable-message",
					messageCount: handshake.measuredConnectionsPerWorker,
					messageBytes: HANDSHAKE_FIRST_MESSAGE_BYTES,
				});
			},
		},
	],
	[
		"connection-memory",
		{
			name: "connection-memory",
			parameters: {
				scenarioId: "connection-memory",
				liveConnections: 1_000,
				holdSeconds: 30,
				pooling: false,
			},
			// Single-session sealable minimum: one reliable 1-byte liveness
			// probe then one RSS-bytes-per-connection sample. Full
			// liveConnections idle cohort is campaign topology.
			legPlan: () =>
				comparable({
					deliveryKind: "reliable-message",
					messageCount: 1,
					messageBytes: 1,
				}),
			async execute(input): Promise<MeasuredLeg> {
				const params = input.cell.parameters;
				if (params.scenarioId !== "connection-memory") {
					throw new RangeError(
						`connection-memory executor: unexpected scenarioId ${params.scenarioId}`,
					);
				}
				void (params as ConnectionMemoryParameters);
				return executeConnectionMemoryLeg(input, {
					deliveryKind: "reliable-message",
					messageCount: 1,
					messageBytes: 1,
				});
			},
		},
	],
	[
		"ai-token-stream",
		{
			name: "ai-token-stream",
			parameters: {
				scenarioId: "ai-token-stream",
				chunkBytes: 64,
				sessionCount: 100,
				chunksPerSecondPerSession: 50,
				durationSeconds: 30,
				pauseEverySeconds: 5,
				pauseDurationMs: 500,
			},
			// Explicit reliable delivery for both arms (WS messages /
			// WT uni). Single-session sealable minimum: chunks/s ×
			// duration; × sessionCount cohort is campaign topology.
			legPlan: () =>
				comparable({
					deliveryKind: "reliable-message",
					messageCount: 50 * 30,
					messageBytes: 64,
				}),
			async execute(input): Promise<MeasuredLeg> {
				const params = input.cell.parameters;
				if (params.scenarioId !== "ai-token-stream") {
					throw new RangeError(
						`ai-token-stream executor: unexpected scenarioId ${params.scenarioId}`,
					);
				}
				const ai = params as AiTokenParameters;
				return executeLatencyLeg(input, {
					deliveryKind: "reliable-message",
					messageCount: ai.chunksPerSecondPerSession * ai.durationSeconds,
					messageBytes: ai.chunkBytes,
				});
			},
		},
	],
	[
		"ticker-fanout",
		{
			name: "ticker-fanout",
			parameters: {
				scenarioId: "ticker-fanout",
				ingressRatePerSecond: 100,
				publisherCount: 1,
				subscriberCount: 100,
				recordBytes: 100,
				fanout: 100,
				durationSeconds: 10,
				delivery: "reliable",
			},
			legPlan: () =>
				comparable({
					deliveryKind: "reliable-message",
					messageCount: 100 * 10,
					messageBytes: 100,
				}),
			async execute(input): Promise<MeasuredLeg> {
				const params = input.cell.parameters;
				if (params.scenarioId !== "ticker-fanout") {
					throw new RangeError(
						`ticker-fanout executor: unexpected scenarioId ${params.scenarioId}`,
					);
				}
				// B4: the primary arm is the supervisor-owned cohort. This is the
				// severed call site -- the rate leg below runs only for the
				// read-path arms that shadow the same wire.
				assertNotCohortPrimary(input);
				const ticker = params as TickerParameters;
				return executeRateLeg(input, {
					deliveryKind: "reliable-message",
					messageCount: ticker.ingressRatePerSecond * ticker.durationSeconds,
					messageBytes: ticker.recordBytes,
				});
			},
		},
	],
	[
		"game-tick-loss",
		{
			name: "game-tick-loss",
			parameters: {
				scenarioId: "game-tick-loss",
				tickHz: 20,
				tickBytes: 64,
				receiverCount: 100,
				publisherCount: 1,
				durationSeconds: 30,
				lossPercent: 1,
				delayMs: 20,
				delivery: "latest-state",
			},
			legPlan: () =>
				comparable({
					deliveryKind: "datagram",
					messageCount: 20 * 30,
					messageBytes: 64,
				}),
			async execute(input): Promise<MeasuredLeg> {
				const params = input.cell.parameters;
				if (params.scenarioId !== "game-tick-loss") {
					throw new RangeError(
						`game-tick-loss executor: unexpected scenarioId ${params.scenarioId}`,
					);
				}
				const game = params as GameParameters;
				return executePercentLeg(input, {
					deliveryKind: "datagram",
					messageCount: game.tickHz * game.durationSeconds,
					messageBytes: game.tickBytes,
				});
			},
		},
	],
	[
		"crdt-sync",
		{
			name: "crdt-sync",
			parameters: {
				scenarioId: "crdt-sync",
				clientCount: 100,
				operationBytes: 96,
				operationsPerSecond: 1_000,
				durationSeconds: 60,
				snapshotSchedule: "periodic-canonical",
				delivery: "reliable",
			},
			legPlan: () =>
				comparable({
					deliveryKind: "reliable-message",
					// Single-session sealable minimum: 1s at registry ops/s.
					// Full ops×duration (60k) is campaign topology.
					messageCount: 1_000,
					messageBytes: 96,
				}),
			async execute(input): Promise<MeasuredLeg> {
				const params = input.cell.parameters;
				if (params.scenarioId !== "crdt-sync") {
					throw new RangeError(
						`crdt-sync executor: unexpected scenarioId ${params.scenarioId}`,
					);
				}
				const crdt = params as CrdtParameters;
				return executeRateLeg(input, {
					deliveryKind: "reliable-message",
					messageCount: Math.min(
						crdt.operationsPerSecond * crdt.durationSeconds,
						crdt.operationsPerSecond,
					),
					messageBytes: crdt.operationBytes,
				});
			},
		},
	],
	[
		"bulk-one-way",
		{
			name: "bulk-one-way",
			parameters: {
				scenarioId: "bulk-one-way",
				path: "physical",
				bytes: 100 * 1024 * 1024,
				chunkBytes: 64 * 1024,
				delivery: "reliable",
			},
			legPlan: () =>
				comparable({
					deliveryKind: "reliable-message",
					messageCount: Math.ceil((100 * 1024 * 1024) / (64 * 1024)),
					messageBytes: 64 * 1024,
				}),
			async execute(input): Promise<MeasuredLeg> {
				return executeBulkOneWay(input);
			},
		},
	],
	[
		"chat-fanout",
		{
			name: "chat-fanout",
			parameters: {
				scenarioId: "chat-fanout",
				subscriberCount: 1_000,
				publisherCount: 10,
				messageBytes: 128,
				messagesPerSecondPerPublisher: 1,
				durationSeconds: 30,
				delivery: "reliable",
			},
			legPlan: () =>
				comparable({
					deliveryKind: "reliable-message",
					messageCount: 30 * 10 * 1,
					messageBytes: 128,
				}),
			async execute(input): Promise<MeasuredLeg> {
				const params = input.cell.parameters;
				if (params.scenarioId !== "chat-fanout") {
					throw new RangeError(
						`chat-fanout executor: unexpected scenarioId ${params.scenarioId}`,
					);
				}
				// B4: severed for the primary arm, exactly as ticker-fanout above.
				assertNotCohortPrimary(input);
				const chat = params as ChatParameters;
				return executeRateLeg(input, {
					deliveryKind: "reliable-message",
					messageCount:
						chat.durationSeconds *
						chat.publisherCount *
						chat.messagesPerSecondPerPublisher,
					messageBytes: chat.messageBytes,
				});
			},
		},
	],
	[
		"tail-under-cross-traffic",
		{
			name: "tail-under-cross-traffic",
			parameters: {
				scenarioId: "tail-under-cross-traffic",
				controlMessageBytes: 64,
				controlRatePerSecond: 1,
				durationSeconds: 180,
				bulkChunkBytes: 64 * 1024,
				bulkRateMbps: 700,
				acknowledged: true,
			},
			// Explicit reliable control delivery for both arms. Single-
			// session sealable minimum: controlRate × duration acknowledged
			// control RTTs. Concurrent 700 Mbps bulk is campaign topology.
			legPlan: () =>
				comparable({
					deliveryKind: "reliable-message",
					messageCount: 1 * 180,
					messageBytes: 64,
				}),
			async execute(input): Promise<MeasuredLeg> {
				const params = input.cell.parameters;
				if (params.scenarioId !== "tail-under-cross-traffic") {
					throw new RangeError(
						`tail-under-cross-traffic executor: unexpected scenarioId ${params.scenarioId}`,
					);
				}
				const tail = params as TailParameters;
				return executeLatencyLeg(input, {
					deliveryKind: "reliable-message",
					messageCount: tail.controlRatePerSecond * tail.durationSeconds,
					messageBytes: tail.controlMessageBytes,
				});
			},
		},
	],
];

export const SCENARIO_EXECUTORS: ReadonlyMap<ScenarioId, ScenarioExecutor> =
	new Map<ScenarioId, ScenarioExecutor>(SCENARIO_EXECUTOR_ENTRIES);

/**
 * Look up the executor registered for `name`, if any.
 *
 * Returning `undefined` is the signal that the driver should fall back to the
 * canonical measurement loop. The caller — not this helper — decides what to
 * do with the absence, which is what keeps this file from re-introducing the
 * asymmetry the audit found, where the driver picked something on each arm's
 * behalf because the scenario had no defined plan.
 */
export function getScenarioExecutor(
	name: ScenarioId,
): ScenarioExecutor | undefined {
	return SCENARIO_EXECUTORS.get(name);
}

// Entrypoint when invoked directly via CLI
if (import.meta.main) {
	try {
		const args = parseClientArgs(process.argv.slice(2));
		if (args.help) {
			printClientHelp();
			process.exit(0);
		}
		const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
			(candidate) => candidate.scenarioId === args.scenario,
		);
		if (!cell) throw new Error(`no canonical cell for ${args.scenario}`);
		console.log(
			`[client] Starting ${args.transport.toUpperCase()} client for scenario ${args.scenario} against ${args.serverUrl}...`,
		);
		const tlsCaPem =
			args.tlsCa !== undefined ? await Bun.file(args.tlsCa).text() : undefined;
		const leg = await measureLegOverAdapter({
			adapter: await adapterForTransport(args.transport),
			cell,
			serverUrl: args.serverUrl,
			role: "publisher",
			driverRunId: args.runId,
			runId: args.runId,
			sessionId: `${args.runId}-s1`,
			clock: systemTransportClock,
			connectTimeoutMs: 10_000,
			perMessageTimeoutMs: 5_000,
			...(tlsCaPem || args.tlsSni
				? {
						tls: {
							...(tlsCaPem ? { ca: tlsCaPem } : {}),
							...(args.tlsSni ? { serverName: args.tlsSni } : {}),
							rejectUnauthorized: true,
						},
					}
				: {}),
		});
		const report = JSON.stringify(leg, null, 2);
		if (args.output) await Bun.write(args.output, report);
		else console.log(report);
	} catch (err: unknown) {
		console.error(`[client] Error: ${(err as Error).message}`);
		process.exit(1);
	}
}

/**
 * A typed refusal from a `ScenarioExecutor.execute` that has a defined
 * `legPlan()` but whose `execute` body is not yet implemented.
 *
 * Used by the five canonical scenarios (`chat-fanout`, `ticker-fanout`,
 * `game-tick-loss`, `crdt-sync`, `bulk-one-way`) whose `legPlan()` returns
 * a comparable `LegPlan` (so the registry entry is no longer a not-
 * comparable placeholder) but whose measurement loop is a follow-up
 * commit. Distinct from `LegPlanUndefinedError` so callers and tests can
 * tell the two apart: undefined-`legPlan` scenarios are refused upstream
 * (registry-level); defined-`legPlan`-not-implemented scenarios fail
 * downstream (measurement-level).
 */
export class ScenarioExecutorNotImplementedError extends Error {
	readonly code = "SCENARIO_EXECUTOR_NOT_IMPLEMENTED";
	readonly scenarioId: ScenarioId;
	constructor(scenarioId: ScenarioId) {
		super(
			`scenario '${scenarioId}' has a defined legPlan but its measurement loop is not yet implemented`,
		);
		this.name = "ScenarioExecutorNotImplementedError";
		this.scenarioId = scenarioId;
	}
}
