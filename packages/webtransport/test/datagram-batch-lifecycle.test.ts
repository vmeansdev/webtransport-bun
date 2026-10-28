/**
 * H7 batch datagram delivery: lifecycle behaviour against the live addon.
 *
 * Covers the byte-budget twins on both lanes, the guarantee that TypeScript
 * never holds a second batch while its consumer is paused, local abandonment
 * accounting, and the eight close cases where a sticky close drops rather than
 * drains the still-queued remainder.
 *
 * Everything runs in fresh bounded child processes: the batch knob and the
 * diagnostics knob are both resolved once at module initialization, so a
 * same-process env flip would only re-assert an already-frozen value.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextPort } from "./helpers/network.js";

const BASE_PORT = 19800;
const CHILD_TIMEOUT_MS = 60_000;

const INTERNAL_MODULE = new URL("../src/internal.ts", import.meta.url).pathname;
const PUBLIC_MODULE = new URL("../src/index.ts", import.meta.url).pathname;

type ChildRun = {
	exitCode: number | null;
	result: unknown;
	stdout: string;
	stderr: string;
};

async function runChild(
	body: string,
	env: Record<string, string | undefined> = {},
	timeoutMs = CHILD_TIMEOUT_MS,
): Promise<ChildRun> {
	const dir = mkdtempSync(join(tmpdir(), "wt-h7-lifecycle-"));
	const script = join(dir, "child.ts");
	const preamble =
		`const INTERNAL_MODULE = ${JSON.stringify(INTERNAL_MODULE)};\n` +
		`const PUBLIC_MODULE = ${JSON.stringify(PUBLIC_MODULE)};\n` +
		`const report = (v: unknown) => console.log("__RESULT__" + JSON.stringify(v));\n` +
		HARNESS_PRELUDE;
	await Bun.write(script, preamble + body);
	const childEnv: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env))
		if (v !== undefined) childEnv[k] = v;
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) delete childEnv[k];
		else childEnv[k] = v;
	}
	const proc = Bun.spawn([process.execPath, script], {
		env: childEnv,
		stdout: "pipe",
		stderr: "pipe",
		cwd: new URL("../../..", import.meta.url).pathname,
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		// The deadline timer is cleared on every path; an uncancelled one would
		// keep the test runner's loop alive for its full duration per child.
		const exited = await Promise.race([
			proc.exited,
			new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), timeoutMs);
			}),
		]);
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		if (exited === "timeout") {
			proc.kill();
			throw new Error(
				`child did not exit within ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
			);
		}
		const line = stdout
			.split("\n")
			.find((l) => l.startsWith("__RESULT__"))
			?.slice("__RESULT__".length);
		return {
			exitCode: exited,
			result: line === undefined ? undefined : JSON.parse(line),
			stdout,
			stderr,
		};
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		rmSync(dir, { recursive: true, force: true });
	}
}

function childResult(run: ChildRun): any {
	if (run.exitCode !== 0)
		throw new Error(
			`child exited ${run.exitCode}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
		);
	if (run.result === undefined)
		throw new Error(
			`child produced no __RESULT__ line\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
		);
	return run.result;
}

/**
 * Shared child-side scaffolding: a live server/client pair plus bounded polls.
 * A poll that runs out of budget throws — a stalled gauge is a reportable
 * failure, never something the test waits out silently.
 */
const HARNESS_PRELUDE = `
const DGRAM_SIZE = 100;
const mkDatagram = (i: number) => new Uint8Array(DGRAM_SIZE).fill(i & 0xff);
const snapOr = (s: any) => {
	// Reading metrics on an already-closed handle is allowed to fail; callers
	// that need a post-close reading poll until one succeeds.
	try { return s.metricsSnapshot(); } catch { return null; }
};
async function pollUntil<T>(label: string, budgetMs: number, fn: () => T | null): Promise<T> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		const v = fn();
		if (v !== null && v !== undefined && v !== false) return v as T;
		if (Date.now() >= deadline) throw new Error("bounded poll expired: " + label);
		await Bun.sleep(10);
	}
}
async function livePair(port: number) {
	const { createServer, connect } = await import(PUBLIC_MODULE);
	let serverSession: any;
	const server = createServer({
		port,
		tls: { certPem: "", keyPem: "" },
		onSession: (s: any) => { serverSession = s; },
	});
	let client: any;
	const deadline = Date.now() + 8000;
	for (;;) {
		try {
			client = await connect("https://127.0.0.1:" + port, {
				tls: { insecureSkipVerify: true },
			});
			break;
		} catch (e) {
			if (Date.now() > deadline) throw e;
			await Bun.sleep(100);
		}
	}
	await pollUntil("server session accepted", 5000, () => serverSession ?? null);
	return { server, client, serverSession };
}
/** Pull with a hard per-pull bound; a parked pull that overruns is a failure. */
async function boundedNext(iter: any, budgetMs: number, label: string) {
	const r = await Promise.race([
		iter.next(),
		Bun.sleep(budgetMs).then(() => "timeout" as const),
	]);
	if (r === "timeout") throw new Error("pull exceeded " + budgetMs + "ms: " + label);
	return r;
}
`;

describe("batch delivery holds no second batch while the consumer is paused", () => {
	// One pull materializes a whole batch and releases its native reservation;
	// while the consumer sits on the in-hand items, no further native read is
	// issued, so newly arriving datagrams accumulate natively instead.
	const heldBatchBody = `
		const { __TESTING__ } = await import(INTERNAL_MODULE);
		const lane = process.env.WT_LANE;
		const { server, client, serverSession } = await livePair(Number(process.env.WT_TEST_PORT));
		const target = lane === "server" ? serverSession : client;
		const peer = lane === "server" ? client : serverSession;
		const cfg = __TESTING__.datagramBatchConfigForTests();

		const FIRST = 8;
		for (let i = 0; i < FIRST; i++) await peer.sendDatagram(mkDatagram(i));
		// The whole first burst is reserved natively before anything is read.
		const queuedBeforeRead = await pollUntil("first burst queued", 5000, () => {
			const s = snapOr(target);
			return s && s.queuedBytes >= FIRST * DGRAM_SIZE ? s.queuedBytes : null;
		});

		const iter = target.incomingDatagrams()[Symbol.asyncIterator]();
		const first = await boundedNext(iter, 3000, "first pull");
		if (first.done) throw new Error("first pull ended the iteration");
		const afterFirstPull = __TESTING__.datagramBatchDiagnosticsSnapshotForTests();
		// The reservation for everything the batch materialized is released.
		const queuedAfterRead = await pollUntil("reservation released", 5000, () => {
			const s = snapOr(target);
			return s && s.queuedBytes === 0 ? 0 : null;
		});

		// Consumer stays paused. A second burst must sit natively, unfetched.
		const SECOND = 8;
		for (let i = 0; i < SECOND; i++) await peer.sendDatagram(mkDatagram(100 + i));
		const queuedWhilePaused = await pollUntil("second burst queued", 5000, () => {
			const s = snapOr(target);
			return s && s.queuedBytes >= SECOND * DGRAM_SIZE ? s.queuedBytes : null;
		});
		await Bun.sleep(150);
		const whilePaused = __TESTING__.datagramBatchDiagnosticsSnapshotForTests();

		client.close();
		await server.close();
		report({
			batchSize: cfg.batchSize,
			queuedBeforeRead,
			queuedAfterRead,
			queuedWhilePaused,
			afterFirstPull,
			whilePaused,
		});
		process.exit(0);
	`;

	for (const lane of ["server", "client"] as const) {
		it(`${lane} lane: one batch read drains the reservation and no refill follows`, async () => {
			const res = childResult(
				await runChild(heldBatchBody, {
					WEBTRANSPORT_DATAGRAM_BATCH: "64",
					WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS: "1",
					WT_LANE: lane,
					WT_TEST_PORT: String(nextPort(BASE_PORT, 150)),
				}),
			);
			expect(res.batchSize).toBe(64);

			// The byte-budget twin: eight 100-byte datagrams reserve 800 bytes on
			// whichever lane received them.
			expect(res.queuedBeforeRead).toBe(800);
			expect(res.queuedAfterRead).toBe(0);
			expect(res.queuedWhilePaused).toBe(800);

			// A single native read carried the whole first burst.
			expect(res.afterFirstPull.batchReadCalls).toBe(1);
			expect(res.afterFirstPull.materializedItems).toBe(8);
			expect(res.afterFirstPull.maxBatchSize).toBe(8);
			expect(res.afterFirstPull.yieldedItems).toBe(1);

			// While the consumer is paused, TypeScript holds the seven remaining
			// in-hand items and issues no second read, even though eight more
			// datagrams are sitting in the native queue.
			expect(res.whilePaused.batchReadCalls).toBe(1);
			expect(res.whilePaused.materializedItems).toBe(8);
			expect(res.whilePaused.yieldedItems).toBe(1);
			expect(res.whilePaused.abandonedItems).toBe(0);
		}, 45_000);
	}
});

describe("abandoning a batch mid-array", () => {
	const abandonBody = `
		const { __TESTING__ } = await import(INTERNAL_MODULE);
		const lane = process.env.WT_LANE;
		const { server, client, serverSession } = await livePair(Number(process.env.WT_TEST_PORT));
		const target = lane === "server" ? serverSession : client;
		const peer = lane === "server" ? client : serverSession;

		const SENT = 8;
		for (let i = 0; i < SENT; i++) await peer.sendDatagram(mkDatagram(i));
		await pollUntil("burst queued", 5000, () => {
			const s = snapOr(target);
			return s && s.queuedBytes >= SENT * DGRAM_SIZE ? s.queuedBytes : null;
		});

		let yielded = 0;
		for await (const _d of target.incomingDatagrams()) {
			yielded++;
			break; // abandon the rest of the in-hand array
		}
		const diag = __TESTING__.datagramBatchDiagnosticsSnapshotForTests();

		target.close();
		if (lane === "server") client.close();
		// Reservations must come back to baseline once the session tears down.
		// A gauge that cannot be read is NOT a gauge at baseline, so an
		// unreadable snapshot keeps polling and ultimately fails the child
		// rather than satisfying the assertion having observed nothing.
		let teardownSnapshotAvailable = false;
		const queuedAfterTeardown = await pollUntil("reservation baseline", 5000, () => {
			const s = snapOr(lane === "server" ? serverSession : client);
			if (s === null) return null;
			teardownSnapshotAvailable = true;
			return s.queuedBytes === 0 ? 0 : null;
		});
		await server.close();
		report({
			yielded,
			observedBatchSize: diag.maxBatchSize,
			abandonedItems: diag.abandonedItems,
			materializedItems: diag.materializedItems,
			yieldedItems: diag.yieldedItems,
			batchReadCalls: diag.batchReadCalls,
			queuedAfterTeardown,
			teardownSnapshotAvailable,
		});
		process.exit(0);
	`;

	for (const lane of ["server", "client"] as const) {
		it(`${lane} lane: batch=4 abandonment discards exactly the unyielded remainder`, async () => {
			const res = childResult(
				await runChild(abandonBody, {
					WEBTRANSPORT_DATAGRAM_BATCH: "4",
					WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS: "1",
					WT_LANE: lane,
					WT_TEST_PORT: String(nextPort(BASE_PORT, 150)),
				}),
			);
			expect(res.yielded).toBe(1);
			// The knob caps the batch, so eight queued datagrams yield a batch of 4.
			expect(res.observedBatchSize).toBe(4);
			expect(res.batchReadCalls).toBe(1);
			expect(res.materializedItems).toBe(4);
			expect(res.yieldedItems).toBe(1);
			expect(res.abandonedItems).toBe(res.observedBatchSize - 1);
			expect(res.abandonedItems).toBe(3);
			// The gauge was actually read, so the baseline claim rests on an
			// observation rather than on an unreadable handle.
			expect(res.teardownSnapshotAvailable).toBe(true);
			expect(res.queuedAfterTeardown).toBe(0);
		}, 45_000);
	}
});

describe("sticky close drops the queued remainder on both lanes", () => {
	// Deliberate shape: pull exactly once so the consumer is mid-stream, then
	// let a further burst pile up natively. At close time there is provably
	// undelivered data, so a passing run cannot be a vacuous empty-channel pass.
	const closeBody = `
		const { __TESTING__ } = await import(INTERNAL_MODULE);
		const lane = process.env.WT_LANE;
		const closeKind = process.env.WT_CLOSE;
		const { server, client, serverSession } = await livePair(Number(process.env.WT_TEST_PORT));
		const target = lane === "server" ? serverSession : client;
		const peer = lane === "server" ? client : serverSession;
		const cfg = __TESTING__.datagramBatchConfigForTests();

		const FIRST = 8;
		for (let i = 0; i < FIRST; i++) await peer.sendDatagram(mkDatagram(i));
		await pollUntil("first burst queued", 5000, () => {
			const s = snapOr(target);
			return s && s.queuedBytes >= FIRST * DGRAM_SIZE ? s.queuedBytes : null;
		});

		const iter = target.incomingDatagrams()[Symbol.asyncIterator]();
		const first = await boundedNext(iter, 3000, "pre-close pull");
		if (first.done) throw new Error("pre-close pull ended the iteration");
		let delivered = 1;

		const SECOND = 4;
		for (let i = 0; i < SECOND; i++) await peer.sendDatagram(mkDatagram(200 + i));
		// A single legacy read consumed one datagram; a batch read materialized
		// the whole first burst. Either way the rest is provably still queued
		// natively, so no close case can pass on an empty channel.
		const inHand = cfg.batchSize === 0 ? 0 : FIRST - 1;
		const stillQueued = FIRST - 1 - inHand + SECOND;
		const queuedAtClose = await pollUntil("second burst queued", 5000, () => {
			const s = snapOr(target);
			return s && s.queuedBytes >= stillQueued * DGRAM_SIZE
				? s.queuedBytes
				: null;
		});

		// Local close = the lane under test closes itself; remote = its peer does.
		const closeAt = Date.now();
		if (closeKind === "local") target.close();
		else peer.close();

		// Every remaining pull, including the one that parks on the native side,
		// must settle within one second.
		let done = false;
		let worstPullMs = 0;
		for (let guard = 0; guard <= FIRST + SECOND + 1; guard++) {
			const t0 = Date.now();
			const n = await boundedNext(iter, 1000, "post-close pull " + guard);
			worstPullMs = Math.max(worstPullMs, Date.now() - t0);
			if (n.done) { done = true; break; }
			delivered++;
		}
		const drainMs = Date.now() - closeAt;

		// queued_bytes is shared with the send direction, so poll it back down.
		// An unreadable snapshot must not satisfy criterion 6 by default: it
		// keeps polling, and the child fails if a real reading never arrives.
		let closeSnapshotAvailable = false;
		const queuedAfterClose = await pollUntil("queued_bytes baseline", 5000, () => {
			const s = snapOr(target);
			if (s === null) return null;
			closeSnapshotAvailable = true;
			return s.queuedBytes === 0 ? 0 : null;
		});

		client.close();
		await server.close();
		report({
			batchSize: cfg.batchSize,
			lane, closeKind,
			sent: FIRST + SECOND,
			delivered,
			inHand,
			stillQueued,
			done,
			worstPullMs,
			drainMs,
			queuedAtClose,
			queuedAfterClose,
			closeSnapshotAvailable,
		});
		process.exit(0);
	`;

	for (const batchSize of ["0", "64"] as const) {
		for (const lane of ["server", "client"] as const) {
			for (const closeKind of ["local", "remote"] as const) {
				it(`batch=${batchSize} ${lane} lane ${closeKind} close ends the iteration and drops the remainder`, async () => {
					const res = childResult(
						await runChild(closeBody, {
							WEBTRANSPORT_DATAGRAM_BATCH: batchSize,
							WT_LANE: lane,
							WT_CLOSE: closeKind,
							WT_TEST_PORT: String(nextPort(BASE_PORT, 150)),
						}),
					);
					expect(res.batchSize).toBe(Number(batchSize));

					// Non-vacuous: the exact undelivered remainder was still held
					// natively when the close landed.
					expect(res.stillQueued).toBeGreaterThanOrEqual(1);
					expect(res.queuedAtClose).toBe(res.stillQueued * 100);

					// The parked read resolved, and within the bound.
					expect(res.done).toBe(true);
					expect(res.worstPullMs).toBeLessThan(1000);

					if (closeKind === "local") {
						// Deviation 3, JS-visible: the consumer gets only the array
						// already in hand, and the natively queued remainder is
						// dropped rather than drained. A closing-side close is
						// sticky before the next read is entered — natively the read
						// resolves null, and the session's own closed flag stops the
						// loop too — so this is exact rather than a bound.
						expect(res.delivered).toBe(1 + res.inHand);
						expect(res.delivered).toBeLessThan(res.sent);
					} else {
						// A peer close is a clean connection end. How much of the
						// remainder the reader still gets depends on whether the
						// sticky close beats the in-flight read natively, so the
						// contract tested here is "no less than what was already in
						// hand, no more than what was sent, and it terminates".
						expect(res.delivered).toBeGreaterThanOrEqual(1 + res.inHand);
						expect(res.delivered).toBeLessThanOrEqual(res.sent);
					}

					// Criterion 6: no stranded gauge on either lane, and the gauge
					// was genuinely read rather than assumed clean.
					expect(res.closeSnapshotAvailable).toBe(true);
					expect(res.queuedAfterClose).toBe(0);
				}, 45_000);
			}
		}
	}
});
