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
import {
	buildInteropWebServerCommand,
	buildInteropWebServerEnv,
} from "./web-server-env.ts";

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

/** The capacity under test. The server echoes it back, and the readiness gate
 * below refuses to start the browser until it has. */
const qpackMaxTableCapacity = "4096";

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
		command: buildInteropWebServerCommand(),
		name: "interop-qpack-webserver",
		stdout: "pipe",
		wait: {
			// Both lines, in the order the server prints them. Waiting on the health
			// line alone made this gate pass whether or not the setting under test
			// ever reached the server: a dropped option would have been reported as
			// a clean interop run.
			stdout: new RegExp(
				`addon-server: advertising qpackMaxTableCapacity=${qpackMaxTableCapacity}\\b[\\s\\S]*addon-server: Health on http://${interopHost.replaceAll(".", "\\.")}:${interopHealthPort}`,
			),
		},
		env: {
			...buildInteropWebServerEnv(),
			WT_IDLE_TIMEOUT_MS: "5000",
			// The setting under test: advertise a dynamic QPACK table.
			WT_QPACK_MAX_TABLE_CAPACITY: qpackMaxTableCapacity,
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
