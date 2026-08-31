/**
 * Task 10: Server CLI entry point (Linux side), and the echo peer behind it.
 *
 * A3 Phase-A attested bulk cells keep the registry's completion-based
 * `bulk-one-way/physical` topology (linux-to-mac / server-opened-uni) and
 * emit `BulkSourceCompletionV1` nested in the attested snapshot frame.
 *
 * Usage:
 *   bun tools/compare/server.ts --transport <ws|wt> --scenario <id> --port <port> --bind <ip> --tls-cert <cert> --tls-key <key>
 *
 * Strict argument parsing. Rejects loopback addresses in measurement mode.
 *
 * The peer is what makes the client's `receivedAtMs` mean anything: it hands
 * each message straight back on the delivery kind it arrived on, so a client
 * sample is a round trip through two adapters and the wire between them rather
 * than a locally computed number. Like the driver, it never reads which
 * transport it is running on.
 */

import {
	type DeliveryKind,
	type ServerHandle,
	type Session,
	systemTransportClock,
	type TransportAdapter,
	type TransportClock,
} from "./adapters/transport.ts";
import { createWebSocketAdapter } from "./adapters/ws.ts";
import {
	createWebTransportAdapter,
	productionWtAdapterOptions,
} from "./adapters/wt.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "./scenario-registry.ts";
import {
	SCENARIO_IDS,
	type BulkParameters,
	type ScenarioCell,
	type ScenarioId,
} from "./types.ts";

export interface ServerArgs {
	readonly transport: "ws" | "wt";
	readonly scenario: ScenarioId;
	readonly port: number;
	readonly bind: string;
	readonly runId: string;
	readonly tlsCert?: string;
	readonly tlsKey?: string;
	readonly help?: boolean;
}

const LOOPBACK_IPS = ["127.0.0.1", "::1", "localhost", "0.0.0.0"];

export function parseServerArgs(argv: readonly string[]): ServerArgs {
	let transport: "ws" | "wt" = "wt";
	let scenario: ScenarioId = "chat-fanout";
	let port = 4433;
	let bind = "10.99.0.2";
	let runId = `run-srv-${Date.now()}`;
	let tlsCert: string | undefined;
	let tlsKey: string | undefined;
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
		} else if (arg === "--port") {
			const val = parseInt(argv[++i] ?? "", 10);
			if (isNaN(val) || val <= 0 || val > 65535) {
				throw new Error(`Invalid --port: ${val}`);
			}
			port = val;
		} else if (arg === "--bind") {
			bind = argv[++i] ?? "";
			if (!bind) throw new Error("Missing value for --bind");
		} else if (arg === "--run-id") {
			runId = argv[++i] ?? "";
			if (!runId) throw new Error("Missing value for --run-id");
		} else if (arg === "--tls-cert") {
			tlsCert = argv[++i];
		} else if (arg === "--tls-key") {
			tlsKey = argv[++i];
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (LOOPBACK_IPS.includes(bind)) {
		throw new Error(
			`Refusing loopback bind address '${bind}'; all comparison runs must use physical cable (10.99.0.2)`,
		);
	}

	return {
		transport,
		scenario,
		port,
		bind,
		runId,
		tlsCert,
		tlsKey,
		help,
	};
}

export function printServerHelp(): void {
	console.log(`
WebTransport vs WebSocket Comparison Server

Usage:
  bun tools/compare/server.ts [options]

Options:
  --transport <ws|wt>      Transport to use (default: wt)
  --scenario <id>          Scenario ID (default: chat-fanout)
  --port <port>            Port to listen on (default: 4433)
  --bind <ip>              IP address to bind to (default: 10.99.0.2)
  --run-id <id>            Run ID for evidence attribution
  --tls-cert <file>        Path to TLS certificate PEM
  --tls-key <file>         Path to TLS private key PEM
  --help, -h               Show this help message
`);
}

/** What the peer did for one session, so a caller can assert on it. */
export interface EchoedSession {
	readonly echoed: number;
	readonly stopped: "peer-closed" | "limit-reached";
}

/**
 * Echo every message this session sends back to it.
 *
 * `messageLimit` bounds the loop so a test can drive it to completion; a
 * production run states the count the client will send. The kind a message came
 * in on is the kind it goes back out on — a datagram leg is never quietly
 * upgraded to a reliable one on the return path, which would have made the
 * client's measured latency a different thing on each arm.
 */
export async function echoSession(input: {
	readonly session: Session;
	readonly deliveryKind: DeliveryKind;
	readonly messageLimit: number;
	readonly clock: TransportClock;
	readonly perMessageTimeoutMs: number;
}): Promise<EchoedSession> {
	let echoed = 0;
	while (echoed < input.messageLimit) {
		let message: Awaited<ReturnType<Session["receiveMessage"]>>;
		try {
			message = await input.session.receiveMessage(
				input.deliveryKind,
				input.clock.nowMs() + input.perMessageTimeoutMs,
			);
		} catch {
			return { echoed, stopped: "peer-closed" };
		}
		await input.session.sendMessage(
			input.deliveryKind,
			message,
			input.clock.nowMs() + input.perMessageTimeoutMs,
		);
		echoed++;
	}
	return { echoed, stopped: "limit-reached" };
}

/** Accept sessions on a started server and echo each one in turn. */
export async function runEchoPeer(input: {
	readonly server: ServerHandle;
	readonly deliveryKind: DeliveryKind;
	readonly sessionCount: number;
	readonly messageLimit: number;
	readonly clock: TransportClock;
	readonly acceptTimeoutMs: number;
	readonly perMessageTimeoutMs: number;
}): Promise<readonly EchoedSession[]> {
	const results: EchoedSession[] = [];
	for (let index = 0; index < input.sessionCount; index++) {
		const session = await input.server.acceptSession(
			input.clock.nowMs() + input.acceptTimeoutMs,
		);
		results.push(
			await echoSession({
				session,
				deliveryKind: input.deliveryKind,
				messageLimit: input.messageLimit,
				clock: input.clock,
				perMessageTimeoutMs: input.perMessageTimeoutMs,
			}),
		);
	}
	return results;
}

/** Chunk count for a bulk transfer of `bytes` in pieces of at most `chunkBytes`. */
export function bulkChunkSchedule(
	bytes: number,
	chunkBytes: number,
): { chunkCount: number } {
	if (
		!Number.isFinite(bytes) ||
		bytes <= 0 ||
		!Number.isFinite(chunkBytes) ||
		chunkBytes <= 0
	) {
		throw new RangeError(
			`bulkChunkSchedule: bytes and chunkBytes must be finite positive; got bytes=${bytes} chunkBytes=${chunkBytes}`,
		);
	}
	return { chunkCount: Math.ceil(bytes / chunkBytes) };
}

/**
 * Accept one session and act as the bulk-one-way source: open a uni channel,
 * write `ceil(bytes / chunkBytes)` pattern-filled chunks (sequence starting at
 * 1, matching `generateBulkPayload` / `executeBulkOneWay`), then end the channel.
 */
export async function runBulkSourcePeer(input: {
	readonly server: ServerHandle;
	readonly bytes: number;
	readonly chunkBytes: number;
	readonly clock: TransportClock;
	readonly acceptTimeoutMs: number;
	readonly writeTimeoutMs: number;
}): Promise<{ readonly chunksWritten: number; readonly bytesWritten: number }> {
	const { chunkCount } = bulkChunkSchedule(input.bytes, input.chunkBytes);
	const session = await input.server.acceptSession(
		input.clock.nowMs() + input.acceptTimeoutMs,
	);
	const channel = await session.openUni(
		input.clock.nowMs() + input.writeTimeoutMs,
	);

	let remaining = input.bytes;
	let bytesWritten = 0;
	for (let sequence = 1; sequence <= chunkCount; sequence++) {
		const size = Math.min(input.chunkBytes, remaining);
		const chunk = new Uint8Array(size);
		chunk.fill(sequence & 0xff);
		await channel.write(chunk, input.clock.nowMs() + input.writeTimeoutMs);
		remaining -= size;
		bytesWritten += size;
	}
	await channel.end(input.clock.nowMs() + input.writeTimeoutMs);

	return { chunksWritten: chunkCount, bytesWritten };
}

/** The peer's adapter, chosen the same way and for the same reason as the client's. */
export async function adapterForTransport(
	transport: "ws" | "wt",
): Promise<TransportAdapter> {
	if (transport === "ws") return createWebSocketAdapter();
	return createWebTransportAdapter(await productionWtAdapterOptions());
}

/**
 * Resolve the registry cell the echo peer must match the client against.
 * Scenario CLI args are scenario ids (`game-tick-loss`); the registry keys
 * cells by cellId (`game-tick-loss/tick-20-...`).
 */
export function cellForServerScenario(scenario: ScenarioId): ScenarioCell {
	const exact = CANONICAL_SCENARIO_REGISTRY.cells.find(
		(cell) => cell.scenarioId === scenario,
	);
	if (exact !== undefined) return exact;
	const prefixed = CANONICAL_SCENARIO_REGISTRY.cells.find((cell) =>
		cell.cellId.startsWith(`${scenario}/`),
	);
	if (prefixed !== undefined) return prefixed;
	throw new Error(`No registry cell for scenario ${scenario}`);
}

/**
 * Delivery kind the echo peer listens on.
 *
 * Kept in lockstep with `resolveSealLegPlan` in compare-controller: only
 * `game-tick-loss` (latest-state / percent) uses datagrams. A reliable-only
 * peer against a datagram client seals an honest-looking 0% delivery leg.
 */
export function echoDeliveryKindForScenario(
	scenario: ScenarioId,
): DeliveryKind {
	const cell = cellForServerScenario(scenario);
	return cell.parameters.scenarioId === "game-tick-loss"
		? "datagram"
		: "reliable-message";
}

// Entrypoint when invoked directly via CLI
if (import.meta.main) {
	try {
		const args = parseServerArgs(process.argv.slice(2));
		if (args.help) {
			printServerHelp();
			process.exit(0);
		}
		console.log(
			`[server] Starting ${args.transport.toUpperCase()} server for scenario ${args.scenario} on ${args.bind}:${args.port}...`,
		);
		const adapter = await adapterForTransport(args.transport);
		// `WS_WT_TLS_CERT_CONTENT` / `WS_WT_TLS_KEY_CONTENT` are set by
		// the controller when it has the cert/key as PEM content (rather
		// than a file path). Bun.serve's `tls.cert`/`tls.key` expect
		// content, not paths; the env-var path lets the controller pass
		// the content without forcing the server to read files.
		const certFromEnv = process.env.WS_WT_TLS_CERT_CONTENT;
		const keyFromEnv = process.env.WS_WT_TLS_KEY_CONTENT;
		const server = await adapter.startServer({
			port: args.port,
			tls: {
				...(certFromEnv
					? { cert: certFromEnv }
					: args.tlsCert
						? { cert: args.tlsCert }
						: {}),
				...(keyFromEnv
					? { key: keyFromEnv }
					: args.tlsKey
						? { key: args.tlsKey }
						: {}),
				serverName: process.env.WS_WT_TLS_SERVER_NAME ?? "wt-compare.local",
			},
		} as Parameters<TransportAdapter["startServer"]>[0]);
		if (args.scenario === "bulk-one-way") {
			const bulkCell =
				CANONICAL_SCENARIO_REGISTRY.cells.find(
					(cell) => cell.cellId === "bulk-one-way/physical",
				) ??
				CANONICAL_SCENARIO_REGISTRY.cells.find(
					(cell) => cell.scenarioId === "bulk-one-way",
				);
			if (bulkCell === undefined) {
				throw new Error(
					"No bulk-one-way cell found in CANONICAL_SCENARIO_REGISTRY",
				);
			}
			const bulk = bulkCell.parameters as BulkParameters;
			const result = await runBulkSourcePeer({
				server,
				bytes: bulk.bytes,
				chunkBytes: bulk.chunkBytes,
				clock: systemTransportClock,
				acceptTimeoutMs: 60_000,
				writeTimeoutMs: 60_000,
			});
			console.log(
				`[server] bulk-one-way source wrote ${result.chunksWritten} chunks / ${result.bytesWritten} bytes`,
			);
		} else {
			const deliveryKind = echoDeliveryKindForScenario(args.scenario);
			console.log(`[server] echo peer deliveryKind=${deliveryKind}`);
			await runEchoPeer({
				server,
				deliveryKind,
				sessionCount: 1,
				messageLimit: Number.POSITIVE_INFINITY,
				clock: systemTransportClock,
				acceptTimeoutMs: 60_000,
				perMessageTimeoutMs: 5_000,
			});
		}
	} catch (err: unknown) {
		console.error(`[server] Error: ${(err as Error).message}`);
		process.exit(1);
	}
}
