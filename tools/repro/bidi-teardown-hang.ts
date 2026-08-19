#!/usr/bin/env bun
/**
 * Minimal reproduction of the G11 Arm-D teardown hang (issue 02).
 *
 * Shape, reduced from `tools/load/g11-client.ts` + `tools/load/bench-g11.ts` to
 * the smallest thing that still holds the suspected mechanism: one session, one
 * bidi stream, both directions paced at the gate's per-direction rate, one end
 * deliberately reading slowly so unread inbound bytes sit against the shared
 * per-stream budget when the write half is finished, then teardown.
 *
 * Every await in the teardown sequence is named, timed and bounded, so that a
 * step which never settles is reported by name instead of wedging the process —
 * the original failure was only ever observed as "the cell never exited".
 *
 *   bun tools/repro/bidi-teardown-hang.ts --iterations 20 --slow-reader client \
 *       --backlog-fraction 0.25
 */

import type { Duplex } from "node:stream";
import {
	__TESTING__,
	connect,
	createServer,
} from "../../packages/webtransport/src/index.ts";

/**
 * Which native await is outstanding right now. When a teardown step fails to
 * settle, this is the difference between "something hung" and naming the future
 * that never resolved.
 */
function nativeAwaits(): Record<string, number> {
	const snap = __TESTING__.nativeAwaitProbeSnapshotForTests() ?? {};
	return Object.fromEntries(Object.entries(snap).filter(([, v]) => v !== 0));
}

/** Gate G11's inner packet plus its 2-byte length prefix (g11-plan.ts). */
const FRAME_BYTES = 1402;
/** 3 Mbps per direction, the gate's per-tunnel constant. */
const BYTES_PER_SEC = (3 * 1_000_000) / 8;
/** Shipped `limits.maxQueuedBytesPerStream` (crates/native/src/limits.rs). */
const MAX_QUEUED_BYTES_PER_STREAM = 256 * 1024;
/** `BidiStream`'s default readable buffer, which sits in front of the budget. */
const READABLE_HIGH_WATER_MARK = 256 * 1024;

type Args = {
	iterations: number;
	sessions: number;
	driveMs: number;
	slowReader: "client" | "server" | "none";
	backlogFraction: number;
	stallAfterMs: number;
	stallForMs: number;
	stepTimeoutMs: number;
	port: number;
};

function parseArgs(argv: string[]): Args {
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const num = (flag: string, fallback: number): number => {
		const raw = get(flag);
		return raw === undefined ? fallback : Number(raw);
	};
	const slow = get("--slow-reader") ?? "client";
	if (slow !== "client" && slow !== "server" && slow !== "none")
		throw new Error("--slow-reader must be client|server|none");
	return {
		iterations: num("--iterations", 10),
		sessions: num("--sessions", 50),
		driveMs: num("--drive-ms", 3000),
		slowReader: slow,
		backlogFraction: num("--backlog-fraction", 0.25),
		stallAfterMs: num("--stall-after-ms", 0),
		stallForMs: num("--stall-for-ms", 10000),
		stepTimeoutMs: num("--step-timeout-ms", 20000),
		port: num("--port", 24990),
	};
}

/**
 * The withhold that actually loads the native budget. On the client end a
 * 256 KiB Duplex readable buffer sits in front of the budget, so the reader
 * must stay away long enough to fill that buffer *and then* the registered
 * fraction of the stream budget; the W3C server end has no such buffer.
 */
function backlogPlan(backlogFraction: number, aheadOfBudgetBytes: number) {
	const target =
		backlogFraction * MAX_QUEUED_BYTES_PER_STREAM + aheadOfBudgetBytes;
	return {
		withholdMs:
			backlogFraction > 0 ? Math.ceil((target / BYTES_PER_SEC) * 1000) : 0,
		framesPerDrain: Math.max(1, Math.floor(target / FRAME_BYTES)),
	};
}

type StepResult = {
	label: string;
	ms: number;
	timedOut: boolean;
	error?: string;
};

/**
 * A step whose non-completion is the finding, so it is named and bounded. A
 * rejection is an outcome to record, not a reason to abandon the iteration:
 * teardown under a slow reader rejects routinely, and the question this script
 * exists to answer is only ever which step fails to settle at all.
 */
async function step(
	label: string,
	timeoutMs: number,
	promise: Promise<unknown>,
): Promise<StepResult> {
	const startedAt = performance.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), timeoutMs);
	});
	try {
		const raced = await Promise.race([
			promise.then(
				() => ({ ok: true }) as const,
				(err: unknown) => ({ ok: false, err }) as const,
			),
			timeout,
		]);
		const ms = performance.now() - startedAt;
		if (raced === "timeout")
			return {
				label,
				ms,
				timedOut: true,
				error: `nativeAwaits=${JSON.stringify(nativeAwaits())}`,
			};
		if (!raced.ok)
			return { label, ms, timedOut: false, error: String(raced.err) };
		return { label, ms, timedOut: false };
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Emit `driveMs` worth of frames at the per-direction rate. */
async function pacedWrite(
	write: (chunk: Buffer) => Promise<void>,
	driveMs: number,
	counter: { framesWritten: number },
): Promise<void> {
	const frame = Buffer.allocUnsafe(FRAME_BYTES);
	const perFrameMs = (FRAME_BYTES / BYTES_PER_SEC) * 1000;
	const until = performance.now() + driveMs;
	let due = performance.now();
	while (performance.now() < until) {
		due += perFrameMs;
		const lag = due - performance.now();
		if (lag > 0) await Bun.sleep(lag);
		try {
			await write(frame);
			counter.framesWritten += 1;
		} catch {
			break;
		}
	}
}

type ServerBidi = {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
};

/** The server end of the tunnel, W3C-shaped exactly as the G11 server is. */
async function driveServerEnd(
	stream: ServerBidi,
	opts: {
		driveMs: number;
		slow: boolean;
		backlogFraction: number;
		stepTimeoutMs: number;
		stallAfterMs: number;
		stallForMs: number;
	},
): Promise<StepResult[]> {
	const { withholdMs, framesPerDrain } = opts.slow
		? backlogPlan(opts.backlogFraction, 0)
		: { withholdMs: 0, framesPerDrain: 1 };
	const counter = { framesWritten: 0 };
	const stallAt = performance.now() + opts.stallAfterMs;
	let stallDone = false;

	const reader = (async () => {
		const r = stream.readable.getReader();
		if (withholdMs > 0) await Bun.sleep(withholdMs);
		let sinceWithhold = 0;
		for (;;) {
			const { done, value } = await r.read();
			if (done) break;
			if (!value) continue;
			// See the client end: hold unread inbound *into* teardown.
			if (opts.stallAfterMs > 0 && !stallDone && performance.now() >= stallAt) {
				stallDone = true;
				await Bun.sleep(opts.stallForMs);
			}
			if (withholdMs > 0) {
				sinceWithhold += Math.ceil(value.byteLength / FRAME_BYTES);
				if (sinceWithhold >= framesPerDrain) {
					sinceWithhold = 0;
					await Bun.sleep(withholdMs);
				}
			}
		}
	})();
	reader.catch(() => undefined);

	const writer = stream.writable.getWriter();
	const steps: StepResult[] = [];
	steps.push(
		await step(
			"server:drive",
			opts.stepTimeoutMs,
			pacedWrite((chunk) => writer.write(chunk), opts.driveMs, counter),
		),
	);
	steps.push(
		await step("server:writable-close", opts.stepTimeoutMs, writer.close()),
	);
	steps.push(await step("server:reader-eof", opts.stepTimeoutMs, reader));
	return steps;
}

/** The client end of the tunnel, a Node Duplex exactly as the G11 client is. */
async function driveClientEnd(
	duplex: Duplex,
	opts: {
		driveMs: number;
		slow: boolean;
		backlogFraction: number;
		stepTimeoutMs: number;
		stallAfterMs: number;
		stallForMs: number;
	},
): Promise<StepResult[]> {
	const { withholdMs, framesPerDrain } = opts.slow
		? backlogPlan(opts.backlogFraction, READABLE_HIGH_WATER_MARK)
		: { withholdMs: 0, framesPerDrain: 1 };
	const counter = { framesWritten: 0 };
	const stallAt = performance.now() + opts.stallAfterMs;
	let stallDone = false;

	let readerEofSeen = false;
	const reader = (async () => {
		if (withholdMs > 0) await Bun.sleep(withholdMs);
		let sinceWithhold = 0;
		for await (const chunk of duplex as AsyncIterable<Uint8Array>) {
			// `stall`: stop consuming partway through the drive and stay away long
			// enough to span the whole teardown, so close happens with inbound
			// bytes still unread against the shared per-stream budget. The
			// oscillating reader above averages out to the arrival rate and never
			// holds a backlog *into* teardown; this one does. The stall is bounded
			// so that a reader which never reaches EOF afterwards is the product's
			// doing and not the harness's.
			if (opts.stallAfterMs > 0 && !stallDone && performance.now() >= stallAt) {
				stallDone = true;
				await Bun.sleep(opts.stallForMs);
			}
			if (withholdMs > 0) {
				sinceWithhold += Math.ceil(chunk.byteLength / FRAME_BYTES);
				if (sinceWithhold >= framesPerDrain) {
					sinceWithhold = 0;
					await Bun.sleep(withholdMs);
				}
			}
		}
		readerEofSeen = true;
	})();
	reader.catch(() => undefined);

	const steps: StepResult[] = [];
	steps.push(
		await step(
			"client:drive",
			opts.stepTimeoutMs,
			pacedWrite(
				(chunk) =>
					new Promise<void>((resolve, reject) => {
						duplex.write(chunk, (err) => (err ? reject(err) : resolve()));
					}),
				opts.driveMs,
				counter,
			),
		),
	);
	steps.push(
		await step(
			"client:end",
			opts.stepTimeoutMs,
			new Promise<void>((resolve) => duplex.end(() => resolve())),
		),
	);
	// The G11 driver's exact teardown: a bounded grace for EOF, then an
	// *unbounded* await on the reader regardless of whether the grace expired.
	// The grace is reproduced because the unbounded await behind it is one of the
	// two candidate wedge points.
	steps.push(
		await step(
			"client:eof-grace",
			opts.stepTimeoutMs,
			(async () => {
				const until = Date.now() + 3000;
				while (!readerEofSeen && Date.now() < until) await Bun.sleep(50);
			})(),
		),
	);
	steps.push(await step("client:reader-await", opts.stepTimeoutMs, reader));
	await Bun.sleep(500);
	return steps;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const serverStreams: Promise<StepResult[]>[] = [];

	const server = createServer({
		port: args.port,
		tls: { certPem: "", keyPem: "" },
		// The shipped handshake rate limit (20/s) would reject most of a
		// simultaneous 50-tunnel connect burst. The gate's own runs raise it for
		// the same reason; this is setup, not a variable under test.
		rateLimits: {
			handshakesPerSec: 10_000,
			handshakesBurst: 10_000,
			handshakesBurstPerPrefix: 10_000,
		},
		onSession: async (session: any) => {
			const r = (
				session.incomingBidirectionalStreams as ReadableStream<ServerBidi>
			).getReader();
			for (;;) {
				const next = await r.read();
				if (next.done || !next.value) break;
				serverStreams.push(
					driveServerEnd(next.value, {
						driveMs: args.driveMs,
						slow: args.slowReader === "server",
						backlogFraction: args.backlogFraction,
						stepTimeoutMs: args.stepTimeoutMs,
						stallAfterMs: args.slowReader === "server" ? args.stallAfterMs : 0,
						stallForMs: args.stallForMs,
					}),
				);
			}
		},
	});
	await Bun.sleep(500);

	const wedgedByLabel = new Map<string, number>();
	for (let i = 0; i < args.iterations; i += 1) {
		serverStreams.length = 0;
		const steps: StepResult[] = [];

		// One session per tunnel, all driving at once — the G11 cell's shape. The
		// hang was never seen at one session, so the concurrency is part of the
		// reproduction, not incidental scale.
		const tunnels = await Promise.all(
			Array.from({ length: args.sessions }, async (_, index) => {
				const client: any = await connect(`https://127.0.0.1:${args.port}`, {
					tls: { insecureSkipVerify: true },
				});
				const duplex = (await client.createBidirectionalStream()) as Duplex;
				return { index, client, duplex };
			}),
		);

		const driven = await Promise.all(
			tunnels.map(async ({ index, client, duplex }) => {
				const own = await driveClientEnd(duplex, {
					driveMs: args.driveMs,
					slow: args.slowReader === "client",
					backlogFraction: args.backlogFraction,
					stepTimeoutMs: args.stepTimeoutMs,
					stallAfterMs: args.slowReader === "client" ? args.stallAfterMs : 0,
					stallForMs: args.stallForMs,
				});
				own.push(
					await step(
						"client:session-close",
						args.stepTimeoutMs,
						Promise.resolve(client.close?.()),
					),
				);
				return own.map((s) => ({ ...s, label: `${s.label}#${index}` }));
			}),
		);
		for (const own of driven) steps.push(...own);

		const serverSide = await step(
			"server:all-streams",
			args.stepTimeoutMs,
			Promise.all(serverStreams.map((p) => p.catch(() => [] as StepResult[]))),
		);
		steps.push(serverSide);

		const wedged = steps.filter((s) => s.timedOut);
		for (const s of wedged) {
			const key = s.label.replace(/#\d+$/, "");
			wedgedByLabel.set(key, (wedgedByLabel.get(key) ?? 0) + 1);
		}
		console.log(
			JSON.stringify({
				iteration: i,
				wedgedCount: wedged.length,
				wedged: wedged.map((s) => ({ label: s.label, error: s.error })),
				slowest: steps
					.slice()
					.sort((a, b) => b.ms - a.ms)
					.slice(0, 5)
					.map((s) => `${s.label}=${Math.round(s.ms)}ms`),
			}),
		);
	}

	console.log(
		`repro-summary: ${JSON.stringify({
			iterations: args.iterations,
			sessions: args.sessions,
			slowReader: args.slowReader,
			backlogFraction: args.backlogFraction,
			stallAfterMs: args.stallAfterMs,
			stallForMs: args.stallForMs,
			wedgedByLabel: Object.fromEntries(wedgedByLabel),
		})}`,
	);

	await server.close();

	// The second half of the finding: even when every awaited step settles, the
	// process can still fail to exit. Report that separately from a wedged await.
	const exitDeadline = setTimeout(() => {
		const handles = (process as any)._getActiveHandles?.() ?? [];
		console.log(
			"repro-no-exit: main() returned but the loop is still alive; " +
				`activeHandles=${handles.map((h: any) => h?.constructor?.name).join(",")}`,
		);
		process.exit(3);
	}, 5000);
	exitDeadline.unref?.();
}

await main();
