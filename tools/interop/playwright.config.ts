import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getSpkiHashBase64 } from "./cert-hash.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const certHash = getSpkiHashBase64();

export default defineConfig({
	testDir: "./tests",
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
				"--origin-to-force-quic-on=127.0.0.1:4433",
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
		command: "WT_IDLE_TIMEOUT_MS=5000 bun run addon-server.ts",
		cwd: join(__dirname),
		url: "http://127.0.0.1:4434", // Health endpoint (QUIC on 4433 doesn't respond to HTTP GET)
		reuseExistingServer: false,
		timeout: 15000,
	},
	projects: [
		{
			name: "chromium-webtransport",
			use: { browserName: "chromium" },
		},
	],
});
