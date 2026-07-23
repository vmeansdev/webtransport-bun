import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import {
	resolveInteropHealthPort,
	resolveInteropHealthUrl,
	resolveInteropHost,
	resolveInteropQuicPort,
} from "./browser-helpers.js";
import { getSpkiHashBase64 } from "./cert-hash.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const certHash = getSpkiHashBase64();
const interopHost = resolveInteropHost();
const interopQuicPort = resolveInteropQuicPort();
const interopHealthPort = resolveInteropHealthPort();
const interopHealthUrl = resolveInteropHealthUrl();

export default defineConfig({
	testDir: "./tests",
	testMatch: "**/*.pw.ts",
	timeout: 30_000,
	retries: 0,
	reporter:
		process.env.INTEROP_EVIDENCE === "1"
			? [["list"], ["json", { outputFile: "interop-evidence.json" }]]
			: "list",
	use: {
		browserName: "chromium",
		launchOptions: {
			args: [
				`--origin-to-force-quic-on=${interopHost}:${interopQuicPort}`,
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
		name: "interop-webserver",
		stdout: "pipe",
		wait: {
			stdout: new RegExp(
				`addon-server: Health on http://${interopHost.replaceAll(".", "\\.")}:${interopHealthPort}`,
			),
		},
		env: {
			...process.env,
			WT_IDLE_TIMEOUT_MS: "5000",
		},
		cwd: join(__dirname),
		url: interopHealthUrl, // Health endpoint (QUIC port doesn't respond to HTTP GET)
		reuseExistingServer: false,
		timeout: 60000,
	},
	projects: [
		{
			name: "chromium-webtransport",
			use: { browserName: "chromium" },
		},
	],
});
