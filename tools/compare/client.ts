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

import { createWebSocketAdapter } from "./adapters/ws.ts";
import {
	createWebTransportAdapter,
	productionWtAdapterOptions,
} from "./adapters/wt.ts";
import type { AdmissionCounters } from "./evidence.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "./scenario-registry.ts";
import { type MeasuredSample, openMeasurement } from "./stats.ts";
import {
	SCENARIO_IDS,
	type SampleProvenance,
	type ScenarioCell,
	type ScenarioId,
} from "./types.ts";
import {
	type DeliveryKind,
	type Session,
	systemTransportClock,
	type TransportAdapter,
	type TransportClock,
	type TransportMetrics,
} from "./adapters/transport.ts";
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

/** What one arm is asked to do, stated identically for both arms. */
export interface LegPlan {
	readonly deliveryKind: DeliveryKind;
	readonly messageCount: number;
	readonly messageBytes: number;
}

/** What one driver execution produced. */
export interface MeasuredLeg {
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
	};
	readonly admissionCounters: AdmissionCounters;
	readonly provenance: SampleProvenance;
	/** The round trips behind `samples`, in the order they were recorded. */
	readonly roundTrips: readonly MeasuredSample[];
}

/**
 * Scenarios whose two arms are not yet defined to be doing the same thing.
 *
 * `reconnect-storm` and `handshake-matrix` are parameterised by a
 * `warm-after-prime` state that only means something on WT: 0-RTT resumption is
 * a WT-only option (`adapters/wt.ts`), and the WS client factory exposes no
 * equivalent, so a "warm" WS leg has no definition to execute. `connection-memory`
 * states no delivery mode at all and measures a host property rather than a
 * round trip.
 *
 * The driver refuses them instead of picking something for each arm, because
 * picking is exactly how the asymmetry the audit found got in: a leg that "does
 * whatever that arm's code happened to do" is an authored difference wearing a
 * measurement's clothes. Whether these cells get a defined warm leg or are
 * marked not-comparable is a maintainer decision, and it blocks them.
 */
export const LEG_PLAN_UNDEFINED_SCENARIOS: readonly ScenarioId[] =
	Object.freeze([
		"reconnect-storm",
		"handshake-matrix",
		"connection-memory",
		// A different gap, kept in the same list because the consequence is the
		// same. `AiTokenParameters` and `TailParameters` (`types.ts`) state no
		// `delivery` at all, so the registry never says what the two arms are
		// supposed to do with a chunk or with a control message. Reliable is the
		// obvious guess for both, and a guess is precisely what a comparison must
		// not run on — `tail-under-cross-traffic` in particular is where the plan
		// warns that letting each arm do "whatever its code happened to do" is
		// how the asymmetry got in. The fix is a registry amendment, not a
		// default chosen here.
		"ai-token-stream",
		"tail-under-cross-traffic",
	]);

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
}): Promise<MeasuredLeg> {
	const { session, plan, clock } = input;
	// The samples belong to the recorder, not to this loop. It reads the clock
	// at each send and each arrival and files the series under a token the arm
	// builder resolves against its own record, so a leg's numbers cannot be
	// stated by anything that did not sit through the leg.
	const recorder = openMeasurement({
		driverRunId: input.driverRunId,
		clock,
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
	const ledger = ledgerOf(metrics);
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
		samples: measured.samples,
		percentiles: measured.percentiles,
		ledger,
		admissionCounters: admissionCountersOf(metrics),
		provenance: measured.provenance,
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
}): Promise<MeasuredLeg> {
	const plan = legPlanForCell(input.cell);
	const session = await input.adapter.connect({
		url: input.serverUrl,
		role: input.role,
		deadlineMs: input.clock.nowMs() + input.connectTimeoutMs,
		...(input.tls ? { tls: input.tls } : {}),
	} as Parameters<TransportAdapter["connect"]>[0]);
	try {
		return await runMeasuredLeg({
			session,
			plan,
			driverRunId: input.driverRunId,
			runId: input.runId,
			sessionId: input.sessionId,
			clock: input.clock,
			perMessageTimeoutMs: input.perMessageTimeoutMs,
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
function ledgerOf(metrics: TransportMetrics): MeasuredLeg["ledger"] {
	return {
		attempted: metrics.attempted,
		queued: metrics.queued,
		serverObserved: metrics.serverObserved,
		acknowledged: metrics.acknowledged,
		delivered: metrics.delivered,
		dropped: metrics.dropped,
		expired: metrics.timedOut,
		harnessOverheadBytes: metrics.harnessOverheadBytes,
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
			...(args.tlsCa || args.tlsSni
				? {
						tls: {
							...(args.tlsCa ? { ca: args.tlsCa } : {}),
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
