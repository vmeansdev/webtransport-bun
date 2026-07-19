import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defineConfig } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	testDir: "./tests-wasm",
	timeout: 30_000,
	retries: 0,
	reporter:
		process.env.INTEROP_EVIDENCE === "1"
			? [["list"], ["json", { outputFile: "interop-evidence-wasm.json" }]]
			: "list",
	use: {
		browserName: "chromium",
		launchOptions: {
			// Cert is dynamic and pinned via serverCertificateHashes, so we do NOT
			// use --ignore-certificate-errors-spki-list here.
			args: [
				"--origin-to-force-quic-on=127.0.0.1:4435",
				"--ignore-certificate-errors",
				"--allow-insecure-localhost",
				"--webtransport-developer-mode",
			],
		},
	},
	webServer: {
		command: "WT_IDLE_TIMEOUT_MS=60000 bun run wasm-server.ts",
		cwd: join(__dirname),
		url: "http://127.0.0.1:4436", // Health endpoint (QUIC on 4435 doesn't respond to HTTP GET)
		reuseExistingServer: false,
		timeout: 30000,
	},
	projects: [
		{
			name: "chromium-webtransport-wasm",
			use: { browserName: "chromium" },
		},
	],
});
