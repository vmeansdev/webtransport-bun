import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { resolveInteropHealthUrl } from "./browser-helpers.js";
import { getSpkiHashBase64 } from "./cert-hash.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const proxyPort = Number(process.env.WEBTRANSPORT_FAULT_PROXY_PORT ?? "4443");
const certHash = getSpkiHashBase64();

export default defineConfig({
	testDir: "./tests",
	testMatch: "fault-matrix.spec.ts",
	fullyParallel: false,
	workers: 1,
	timeout: 180_000,
	retries: 0,
	reporter: [["list"]],
	use: {
		browserName: "chromium",
		launchOptions: {
			args: [
				`--origin-to-force-quic-on=127.0.0.1:${proxyPort}`,
				"--ignore-certificate-errors",
				"--allow-insecure-localhost",
				...(certHash
					? [`--ignore-certificate-errors-spki-list=${certHash}`]
					: []),
				"--webtransport-developer-mode",
			],
		},
	},
	webServer: {
		command: "bun run prepare-certs.ts && bun run addon-server.ts",
		cwd: join(__dirname),
		url: resolveInteropHealthUrl(),
		reuseExistingServer: false,
		timeout: 60_000,
	},
	projects: [
		{ name: "chromium-seeded-udp-faults", use: { browserName: "chromium" } },
	],
});
