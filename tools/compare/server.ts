/**
 * Task 10: Server CLI entry point (Linux side).
 *
 * Usage:
 *   bun tools/compare/server.ts --transport <ws|wt> --scenario <id> --port <port> --bind <ip> --tls-cert <cert> --tls-key <key>
 *
 * Strict argument parsing. Rejects loopback addresses in measurement mode.
 */

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
	} catch (err: unknown) {
		console.error(`[server] Error: ${(err as Error).message}`);
		process.exit(1);
	}
}
