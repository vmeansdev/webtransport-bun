/**
 * T34 — N-API crossing floor for a one-payload → N-sessions fan-out.
 *
 * Answers one question and nothing else: what does a fan-out *shape* cost per
 * target when there is no transport behind it? Compares the two shipped
 * per-target shapes (pipelined promise, and the landed promise-free
 * `trySendDatagram`) against three mirror shapes at N = 10 / 100 / 1000 / 10000.
 *
 *   bun tools/bench/mirror-send/fanout-bench.ts [--payload 200] [--seconds 3]
 *
 * Build the addon first:
 *   cd tools/bench/mirror-send/fanout && cargo build --release
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const addon = require(
	new URL("./fanout-bench.node", import.meta.url).pathname,
) as {
	registerGroup(n: number): number;
	groupIds(group: number, n: number): string[];
	groupKeys(group: number, n: number): Uint32Array;
	setFailures(group: number, failEvery: number): void;
	perTargetPromise(id: string, data: Buffer): Promise<number>;
	perTargetTry(id: string, data: Buffer): string | null;
	mirrorIds(ids: string[], data: Uint8Array): MirrorResult;
	mirrorKeys(keys: Uint32Array, data: Uint8Array): MirrorResult;
	mirrorGroup(group: number, data: Uint8Array): MirrorResult;
	mirrorGroupFramed(group: number, data: Uint8Array): MirrorResult;
	mirrorGroupAsync(group: number, data: Uint8Array): Promise<MirrorResult>;
	envCounter(group: number, data: Uint8Array): MirrorResult;
	envFailList(
		group: number,
		data: Uint8Array,
	): { sent: number; indices: Uint32Array; codes: Uint8Array };
	envBitset(group: number, data: Uint8Array): { sent: number; ok: Uint8Array };
	envPerTarget(group: number, data: Uint8Array): (string | null)[];
};

type MirrorResult = { sent: number; failed: number; code: string | null };

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
	args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
}
const PAYLOAD = Number(args.get("payload") ?? 200);
const SECONDS = Number(args.get("seconds") ?? 3);
const WARMUP_SECONDS = 0.5;
const SIZES = [10, 100, 1000, 10000];
/** Failure fractions the envelope comparison runs at (1 in `failEvery`). */
const FAILURE_EVERY = [0, 1000, 10, 1];
const ENVELOPE_N = 10000;

const payload = new Uint8Array(PAYLOAD);
payload[0] = 7;
const payloadBuf = Buffer.from(
	payload.buffer,
	payload.byteOffset,
	payload.byteLength,
);

type Case = {
	name: string;
	/** Fans one payload out to exactly `n` targets. */
	run: () => Promise<void> | void;
};

function buildCases(n: number): Case[] {
	const group = addon.registerGroup(n);
	addon.setFailures(group, 0);
	const ids = addon.groupIds(group, n);
	const keys = addon.groupKeys(group, n);

	return [
		{
			// The G4 baseline: one awaited crossing per target, pipelined.
			name: "per-target promise, pipelined",
			run: async () => {
				const ps = new Array(n);
				for (let i = 0; i < n; i++)
					ps[i] = addon.perTargetPromise(ids[i]!, payloadBuf);
				await Promise.all(ps);
			},
		},
		{
			// The landed promise-free send: still one crossing per target.
			name: "per-target trySendDatagram (sync)",
			run: () => {
				for (let i = 0; i < n; i++) addon.perTargetTry(ids[i]!, payloadBuf);
			},
		},
		{
			name: "mirror: string[] targets",
			run: () => {
				addon.mirrorIds(ids, payload);
			},
		},
		{
			name: "mirror: Uint32Array targets",
			run: () => {
				addon.mirrorKeys(keys, payload);
			},
		},
		{
			name: "mirror: native group handle",
			run: () => {
				addon.mirrorGroup(group, payload);
			},
		},
		{
			name: "mirror: native group, per-target reframe",
			run: () => {
				addon.mirrorGroupFramed(group, payload);
			},
		},
		{
			name: "mirror: native group, behind one promise",
			run: async () => {
				await addon.mirrorGroupAsync(group, payload);
			},
		},
	];
}

function buildEnvelopeCases(group: number): Case[] {
	return [
		{
			name: "envelope: {sent, failed}",
			run: () => {
				addon.envCounter(group, payload);
			},
		},
		{
			name: "envelope: failures-only (Uint32Array + codes)",
			run: () => {
				addon.envFailList(group, payload);
			},
		},
		{
			name: "envelope: bitset (ceil(N/8) bytes)",
			run: () => {
				addon.envBitset(group, payload);
			},
		},
		{
			name: "envelope: per-target (string|null)[]",
			run: () => {
				addon.envPerTarget(group, payload);
			},
		},
	];
}

async function measure(c: Case, n: number, seconds: number): Promise<number> {
	let targets = 0;
	const start = performance.now();
	const deadline = start + seconds * 1000;
	while (performance.now() < deadline) {
		await c.run();
		targets += n;
	}
	const elapsedMs = performance.now() - start;
	return (elapsedMs * 1e6) / targets; // ns per target
}

// Same estimator as T04's crossing bench, and for the same reason: this box is
// shared with other agents, so a single timed window measures contention, not
// the shape. Every cell is re-measured in ROUNDS interleaved passes and the
// MINIMUM kept — the fastest pass is the least-polluted one, and interleaving
// kills ordering bias. No number here is a result; only same-pass ratios are.
const ROUNDS = 6;
const CELL_SECONDS = SECONDS / ROUNDS;

function table(
	title: string,
	cols: number[],
	colLabel: (c: number) => string,
	results: Record<string, Record<number, number>>,
): string[] {
	const header = ["shape", ...cols.map(colLabel)];
	const rows = Object.entries(results).map(([name, byN]) => [
		name,
		...cols.map((n) =>
			byN[n] === undefined ? "-" : (byN[n] as number).toFixed(0),
		),
	]);
	const widths = header.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => r[i]!.length)),
	);
	const line = (cells: string[]) =>
		cells
			.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!)))
			.join("  ");
	return [
		title,
		line(header),
		widths.map((w) => "-".repeat(w)).join("  "),
		...rows.map(line),
	];
}

// --- Part 1: fan-out crossing shapes ---------------------------------------

const casesByN = new Map(SIZES.map((n) => [n, buildCases(n)]));
for (const [n, cases] of casesByN) {
	for (const c of cases) {
		const warm = performance.now() + (WARMUP_SECONDS * 1000) / SIZES.length;
		while (performance.now() < warm) await c.run();
		void n;
	}
}

const fanout: Record<string, Record<number, number>> = {};
for (let round = 0; round < ROUNDS; round++) {
	for (const [n, cases] of casesByN) {
		for (const c of cases) {
			const ns = await measure(c, n, CELL_SECONDS);
			const row = (fanout[c.name] ??= {});
			row[n] = Math.min(row[n] ?? Number.POSITIVE_INFINITY, ns);
		}
	}
}

// --- Part 2: envelope shapes at one N, across failure fractions ------------

const envGroup = addon.registerGroup(ENVELOPE_N);
const envCases = buildEnvelopeCases(envGroup);
const envelope: Record<string, Record<number, number>> = {};
for (let round = 0; round < ROUNDS; round++) {
	for (const failEvery of FAILURE_EVERY) {
		addon.setFailures(envGroup, failEvery);
		for (const c of envCases) {
			const ns = await measure(c, ENVELOPE_N, CELL_SECONDS);
			const row = (envelope[c.name] ??= {});
			row[failEvery] = Math.min(
				row[failEvery] ?? Number.POSITIVE_INFINITY,
				ns,
			);
		}
	}
}

const out = [
	`# T34 fan-out crossing floor, ns per TARGET (payload ${PAYLOAD} B, ${SECONDS}s/cell, min of ${ROUNDS} interleaved passes)`,
	`# runtime: bun ${Bun.version}  platform: ${process.platform}/${process.arch}`,
	"",
	...table("## fan-out shapes", SIZES, (n) => `N=${n}`, fanout),
	"",
	...table(
		`## envelope shapes at N=${ENVELOPE_N}, by failure fraction`,
		FAILURE_EVERY,
		(f) => (f === 0 ? "0%" : `1-in-${f}`),
		envelope,
	),
];
console.log(out.join("\n"));

await Bun.write(
	new URL(`./results-fanout-${PAYLOAD}b.json`, import.meta.url).pathname,
	JSON.stringify(
		{
			runtime: `bun ${Bun.version}`,
			platform: `${process.platform}/${process.arch}`,
			payload: PAYLOAD,
			secondsPerCell: SECONDS,
			rounds: ROUNDS,
			estimator: "min of interleaved passes",
			nsPerTarget: fanout,
			envelopeNsPerTarget: envelope,
			envelopeN: ENVELOPE_N,
		},
		null,
		2,
	),
);
