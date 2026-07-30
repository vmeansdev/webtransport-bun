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

/**
 * Dynamic-QPACK interop: the native addon server advertises a non-zero
 * SETTINGS_QPACK_MAX_TABLE_CAPACITY (via WT_QPACK_MAX_TABLE_CAPACITY) and a real
 * headless Chromium connects. The goal is the honest CQ-3 proof: native no
 * longer rejects Chromium under an advertised table, and the data plane works
 * with no QPACK_DECOMPRESSION_FAILED / QPACK_ENCODER_STREAM_ERROR. See
 * tests-qpack/qpack.pw.ts for the scope note on what this does and does not
 * prove about Chromium exercising native's dynamic-QPACK decode path.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const certHash = getSpkiHashBase64();
const interopHost = resolveInteropHost();
const interopQuicPort = resolveInteropQuicPort();
const interopHealthPort = resolveInteropHealthPort();
const interopHealthUrl = resolveInteropHealthUrl();

export default defineConfig({
	testDir: "./tests-qpack",
	testMatch: "**/*.pw.ts",
	timeout: 30_000,
	retries: 0,
	reporter: "list",
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
		name: "interop-qpack-webserver",
		stdout: "pipe",
		wait: {
			stdout: new RegExp(
				`addon-server: Health on http://${interopHost.replaceAll(".", "\\.")}:${interopHealthPort}`,
			),
		},
		env: {
			...process.env,
			WT_IDLE_TIMEOUT_MS: "5000",
			// The setting under test: advertise a 4096-byte dynamic QPACK table.
			WT_QPACK_MAX_TABLE_CAPACITY: "4096",
		},
		cwd: join(__dirname),
		url: interopHealthUrl,
		reuseExistingServer: false,
		timeout: 60000,
	},
	projects: [
		{
			name: "chromium-webtransport-qpack",
			use: { browserName: "chromium" },
		},
	],
});
