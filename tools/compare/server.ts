/**
 * Task 10: Server CLI entry point (Linux side), and the echo peer behind it.
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
import { SCENARIO_IDS, type ScenarioId } from "./types.ts";

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

/** The peer's adapter, chosen the same way and for the same reason as the client's. */
export async function adapterForTransport(
	transport: "ws" | "wt",
): Promise<TransportAdapter> {
	if (transport === "ws") return createWebSocketAdapter();
	return createWebTransportAdapter(await productionWtAdapterOptions());
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
		const server = await adapter.startServer({
			port: args.port,
			tls: {
				...(args.tlsCert ? { cert: args.tlsCert } : {}),
				...(args.tlsKey ? { key: args.tlsKey } : {}),
				serverName: "wt-compare.local",
			},
		} as Parameters<TransportAdapter["startServer"]>[0]);
		await runEchoPeer({
			server,
			deliveryKind: "reliable-message",
			sessionCount: 1,
			messageLimit: Number.POSITIVE_INFINITY,
			clock: systemTransportClock,
			acceptTimeoutMs: 60_000,
			perMessageTimeoutMs: 5_000,
		});
	} catch (err: unknown) {
		console.error(`[server] Error: ${(err as Error).message}`);
		process.exit(1);
	}
}
