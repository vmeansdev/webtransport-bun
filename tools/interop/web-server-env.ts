const SERVER_ENV_KEYS = [
	"WT_IDLE_TIMEOUT_MS",
	"WT_QPACK_MAX_TABLE_CAPACITY",
	"WEBTRANSPORT_INTEROP_HOST",
	"WEBTRANSPORT_INTEROP_QUIC_PORT",
	"WEBTRANSPORT_INTEROP_HEALTH_PORT",
] as const;

type ServerEnvKey = (typeof SERVER_ENV_KEYS)[number];

export function buildInteropWebServerEnv(
	source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of SERVER_ENV_KEYS) {
		const value = source[key satisfies ServerEnvKey];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

export function resolveBunExecutable(): string {
	if (basename(process.execPath).toLowerCase() === "bun")
		return process.execPath;
	const lookup = process.platform === "win32" ? "where.exe" : "which";
	try {
		const resolved = execFileSync(lookup, ["bun"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.split(/\r?\n/)[0]
			?.trim();
		if (resolved) return resolved;
	} catch {
		// Fall through to a clear error instead of serializing PATH into evidence.
	}
	throw new Error("Bun executable could not be resolved for interop startup");
}

function shellQuote(value: string): string {
	// Playwright's webServer runs the command through cmd.exe on Windows,
	// where single quotes are literal characters ("The filename, directory
	// name, or volume label syntax is incorrect."); double quotes group there.
	if (process.platform === "win32") {
		return `"${value.replaceAll('"', '""')}"`;
	}
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildInteropWebServerCommand(): string {
	const bun = shellQuote(resolveBunExecutable());
	return `${bun} run prepare-certs.ts && ${bun} run addon-server.ts`;
}

export function documentedServerEnvironmentKeys(): readonly string[] {
	return SERVER_ENV_KEYS;
}
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
