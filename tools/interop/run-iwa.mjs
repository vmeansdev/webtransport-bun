#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../..");
const exampleDir = path.join(root, "examples/webtransport-wasm-iwa");
const bundlePath = path.resolve(
	process.env.WT_IWA_BUNDLE_PATH ??
		path.join(exampleDir, "webtransport-wasm-iwa.swbn"),
);
const unsignedBundlePath = path.resolve(
	process.env.WT_IWA_UNSIGNED_BUNDLE_PATH ??
		path.join(exampleDir, "webtransport-wasm-iwa.wbn"),
);
const originPath = path.resolve(
	process.env.WT_IWA_ORIGIN_PATH ?? path.join(exampleDir, "origin.txt"),
);
const evidencePath = path.resolve(
	process.env.WT_IWA_EVIDENCE_PATH ??
		path.join(root, ".release-evidence/iwa/evidence.json"),
);
const profileDir = path.resolve(
	process.env.WT_IWA_PROFILE_DIR ??
		path.join(root, ".release-evidence/iwa/chromium-profile"),
);
const browserChannel = process.env.WT_IWA_BROWSER_CHANNEL?.trim() || undefined;
const browserExecutable =
	process.env.WT_IWA_BROWSER_EXECUTABLE?.trim() || undefined;
const overallTimeoutMs = Number(process.env.WT_IWA_TIMEOUT_MS ?? "180000");

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function monotonicNowMs() {
	return performance.now();
}

function createMonotonicDeadline(timeoutMs, now = monotonicNowMs) {
	const deadlineMs = now() + timeoutMs;
	return {
		remainingMs: () => Math.max(0, deadlineMs - now()),
		expired: () => deadlineMs <= now(),
	};
}

function remainingDeadlineMs(deadline) {
	return Math.max(0, deadline.remainingMs());
}

async function sleepWithDeadline(timeoutMs, deadline) {
	const effectiveDelayMs = Math.min(timeoutMs, remainingDeadlineMs(deadline));
	if (effectiveDelayMs <= 0) {
		return;
	}
	await sleep(effectiveDelayMs);
}

async function navigateToInstalledIwa(page, origin, timeoutMs) {
	const deadline = createMonotonicDeadline(timeoutMs);
	let lastError;
	while (!deadline.expired()) {
		try {
			await withDeadline(
				page.goto(origin, {
					waitUntil: "domcontentloaded",
					timeout: 0,
				}),
				"navigate to installed IWA",
				5_000,
				deadline,
			);
			if (new URL(page.url()).protocol === "isolated-app:") return;
		} catch (error) {
			lastError = error;
		}
		await sleepWithDeadline(500, deadline);
	}
	throw new Error(
		`IWA was not installed within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
	);
}

async function withDeadline(promise, label, timeoutMs, deadline) {
	let timer;
	try {
		const operationDeadline = createMonotonicDeadline(timeoutMs);
		const effectiveDelayMs = deadline
			? Math.min(operationDeadline.remainingMs(), remainingDeadlineMs(deadline))
			: operationDeadline.remainingMs();
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
					effectiveDelayMs,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function validateEvidence(evidence) {
	assert(evidence?.schemaVersion === 1, "unexpected IWA evidence schema");
	assert(
		evidence?.status === "passed",
		`IWA proof status: ${evidence?.status}`,
	);
	assert(
		evidence?.executionIdentity === "browser-iwa-direct-sockets",
		`wrong execution identity: ${evidence?.executionIdentity}`,
	);
	assert(
		evidence?.protocol === "isolated-app:",
		"page was not an installed IWA",
	);
	assert(evidence?.crossOriginIsolated === true, "IWA was not isolated");
	assert(evidence?.directSockets === true, "Direct Sockets was not exercised");
	assert(evidence?.functional?.datagram === "iwa-datagram", "datagram failed");
	assert(evidence?.functional?.bidi === "iwa-bidi", "bidi failed");
	assert(evidence?.functional?.uni === "iwa-uni", "uni failed");
	assert(evidence?.functional?.resetCode === 37, "RESET_STREAM code failed");
	assert(
		evidence?.functional?.stopSendingCode === 41,
		"STOP_SENDING code failed",
	);
	assert(evidence?.functional?.peerClose?.code === 4100, "peer close failed");
	assert(
		Array.isArray(evidence?.reconnects) && evidence.reconnects.length === 8,
		"expected exactly eight successful reconnects",
	);
	for (let attempt = 1; attempt <= 8; attempt += 1) {
		const reconnect = evidence.reconnects[attempt - 1];
		assert(reconnect?.attempt === attempt, `missing reconnect ${attempt}`);
		assert(
			reconnect?.payload === `iwa-reconnect-${attempt}`,
			`reconnect payload mismatch at ${attempt}`,
		);
	}
	assert(
		evidence?.certificateRotation?.oldPinRejected === true,
		"stale certificate pin was not rejected",
	);
	assert(
		evidence?.certificateRotation?.oldHash !==
			evidence?.certificateRotation?.newHash,
		"certificate hash did not rotate",
	);
	assert(
		evidence?.certificateRotation?.payload === "iwa-rotated-cert",
		"rotated certificate path did not exchange a payload",
	);
}

await mkdir(path.dirname(evidencePath), { recursive: true });
await mkdir(profileDir, { recursive: true });

let context;
try {
	const [origin, bundle, unsignedBundle] = await Promise.all([
		readFile(originPath, "utf8").then((value) => value.trim()),
		readFile(bundlePath),
		readFile(unsignedBundlePath),
	]);
	assert(origin.startsWith("isolated-app://"), `invalid IWA origin: ${origin}`);

	context = await chromium.launchPersistentContext(profileDir, {
		headless: false,
		...(browserChannel ? { channel: browserChannel } : {}),
		...(browserExecutable ? { executablePath: browserExecutable } : {}),
		args: [
			"--enable-features=IsolatedWebApps,IsolatedWebAppDevMode",
			`--install-isolated-web-app-from-file=${bundlePath}`,
		],
	});
	await withDeadline(
		// CDP treats isolated-app:// origins as opaque, so origin-scoped grants are
		// rejected. The profile is fresh and ephemeral; grant only this permission
		// profile-wide for the automated IWA proof.
		context.grantPermissions(["local-network-access"]),
		"grant IWA local network access",
		10_000,
	);
	const browserVersion = context.browser()?.version() ?? "unknown";
	const page = context.pages()[0] ?? (await context.newPage());
	page.on("console", (message) =>
		console.log(`[iwa-page:${message.type()}] ${message.text()}`),
	);

	await navigateToInstalledIwa(page, origin, 30_000);
	page.on("pageerror", (error) => console.error("[iwa-page:error]", error));
	assert(
		new URL(page.url()).protocol === "isolated-app:",
		`Chromium did not navigate to the IWA: ${page.url()}`,
	);
	await withDeadline(
		page.waitForFunction(
			() => globalThis.__WT_IWA_READY__ === true,
			undefined,
			{
				timeout: 0,
			},
		),
		"wait for IWA ready flag",
		30_000,
	);
	const pageEvidence = await withDeadline(
		page.evaluate(() => globalThis.runIwaInteropProof()),
		"complete IWA WebTransport proof",
		overallTimeoutMs,
	);
	validateEvidence(pageEvidence);

	const evidence = {
		...pageEvidence,
		sourceCommit:
			process.env.GITHUB_SHA ?? process.env.WT_CANDIDATE_SHA ?? null,
		signedBundleArtifact: "webtransport-wasm-iwa.swbn",
		signedBundleSha256: createHash("sha256").update(bundle).digest("hex"),
		unsignedBundleArtifact: "webtransport-wasm-iwa.wbn",
		unsignedBundleSha256: createHash("sha256")
			.update(unsignedBundle)
			.digest("hex"),
		browserVersion,
		browserChannel: browserChannel
			? "configured-channel"
			: "playwright-chromium",
		localNetworkPermission: "pregranted-for-automated-proof",
		playwrightVersion: process.env.WT_PLAYWRIGHT_VERSION ?? "1.58.2",
	};
	assert(
		typeof evidence.sourceCommit === "string" &&
			evidence.sourceCommit.length >= 7,
		"IWA evidence is not bound to a candidate commit",
	);
	await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
	console.log(`IWA release proof passed: ${evidencePath}`);
} catch (error) {
	const failed = {
		schemaVersion: 1,
		status: "failed",
		executionIdentity: null,
		sourceCommit:
			process.env.GITHUB_SHA ?? process.env.WT_CANDIDATE_SHA ?? null,
		signedBundleArtifact: "webtransport-wasm-iwa.swbn",
		unsignedBundleArtifact: "webtransport-wasm-iwa.wbn",
		errorName: error instanceof Error ? error.name : "UnknownError",
		finishedAt: new Date().toISOString(),
	};
	await writeFile(evidencePath, `${JSON.stringify(failed, null, 2)}\n`);
	throw error;
} finally {
	await context?.close();
}
