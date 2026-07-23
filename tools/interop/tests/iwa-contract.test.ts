import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("IWA release proof contract", () => {
	test("manifest grants Direct Sockets only to a cross-origin-isolated self", () => {
		const manifest = JSON.parse(
			read("examples/webtransport-wasm-iwa/.well-known/manifest.webmanifest"),
		) as { permissions_policy?: Record<string, string[]> };
		expect(manifest.permissions_policy).toEqual({
			"direct-sockets": ["self"],
			"direct-sockets-private": ["self"],
			"local-network": ["self"],
			"loopback-network": ["self"],
			"cross-origin-isolated": ["self"],
		});
	});

	test("runner installs the signed bundle and binds its unsigned source", () => {
		const runner = read("tools/interop/run-iwa.mjs");
		expect(runner).toContain("--install-isolated-web-app-from-file=");
		expect(runner).toContain("navigateToInstalledIwa");
		expect(runner).not.toContain("--install-isolated-web-app-from-url=file:");
		expect(runner).toContain("createMonotonicDeadline");
		expect(runner).not.toContain("Date.now()");
		expect(runner).not.toContain("page.waitForTimeout(");
		expect(runner).toContain(
			'executionIdentity === "browser-iwa-direct-sockets"',
		);
		expect(runner).toContain('protocol === "isolated-app:"');
		expect(runner).toContain("oldPinRejected === true");
		expect(runner).toContain("reconnects.length === 8");
		expect(runner).toContain("signedBundleSha256");
		expect(runner).toContain("unsignedBundleSha256");
		expect(runner).toContain("WT_IWA_UNSIGNED_BUNDLE_PATH");
		expect(runner).toContain("WT_IWA_BROWSER_CHANNEL");
		expect(runner).toContain("WT_IWA_BROWSER_EXECUTABLE");
		expect(runner).toContain('grantPermissions(["local-network-access"]');
		expect(runner).toContain(
			'localNetworkPermission: "pregranted-for-automated-proof"',
		);
		expect(runner).toContain("sourceCommit");
	});

	test("IWA page proof covers every required functional operation with deadlines", () => {
		const app = read("examples/webtransport-wasm-iwa/app.js");
		for (const marker of [
			"iwa-datagram",
			"iwa-bidi",
			"iwa-uni",
			"RESET_STREAM propagation",
			"STOP_SENDING propagation",
			"IWA peer connection close",
			"certificate rotation produced",
			"rotated server accepted the stale certificate pin",
		]) {
			expect(app).toContain(marker);
		}
		expect(app).toContain("for (let attempt = 1; attempt <= 8;");
		expect(app).toContain("createMonotonicDeadline");
		expect(app).toContain("remainingMs()");
		expect(app).toContain("withDeadline(");
		expect(app).toContain('location.protocol === "isolated-app:"');
		expect(app).toContain("globalThis.crossOriginIsolated === true");
	});

	test("workflow packages outside the app tree and uploads commit-bound evidence", () => {
		const workflow = read(".github/workflows/iwa.yml");
		expect(workflow).toContain("tools/interop/run-iwa.mjs");
		expect(workflow).toContain("iwa-proof-$" + "{{ github.sha }}");
		expect(workflow).toContain(".release-evidence/iwa/evidence.json");
		expect(workflow).toContain(
			".release-evidence/iwa/webtransport-wasm-iwa.wbn",
		);
		expect(workflow).toContain(
			".release-evidence/iwa/webtransport-wasm-iwa.swbn",
		);
		expect(workflow).toContain("$RUNNER_TEMP/iwa-signing.key.pem");
		expect(workflow).toContain(
			"timeout 10m npx playwright@1.58.2 install chromium chrome-beta",
		);
		expect(workflow).toContain("evidence-chrome-beta.json");
		expect(workflow).toContain("WT_IWA_BROWSER_CHANNEL: chrome-beta");
		expect(workflow).not.toContain(
			"examples/webtransport-wasm-iwa/iwa-signing.key.pem",
		);
	});
});
