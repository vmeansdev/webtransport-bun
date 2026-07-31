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

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildInteropWebServerCommand(): string {
	const bun = shellQuote(process.execPath);
	return `${bun} run prepare-certs.ts && ${bun} run addon-server.ts`;
}

export function documentedServerEnvironmentKeys(): readonly string[] {
	return SERVER_ENV_KEYS;
}
