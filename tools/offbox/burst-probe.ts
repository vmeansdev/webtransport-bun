#!/usr/bin/env bun

/**
 * Burst-drain probe: the sink-side measurement V-SP's loopback arm cannot make.
 *
 * G10's broadcast is a 10,000-packet impulse serialized onto the wire at link
 * rate (~21.28 ms at 1 GbE for 200 B payloads). A loopback emitter tops out at
 * the loopback syscall rate — an order of magnitude below link rate — so a
 * loopback spread number measures the emitter, not the sink. This probe puts
 * the emitter on the far side of a real NIC: the sender blasts each burst as
 * fast as the socket accepts it and lets the NIC serialize; the receiver
 * timestamps every datagram with its own monotonic clock and reports, per
 * burst, completeness and `last arrival − first arrival` — the sink's actual
 * drain of the day-of impulse shape.
 *
 * Roles:
 *   recv — bind, collect until idle-gap or deadline, print JSON per burst + summary
 *   send — blast `--bursts` bursts of `--count` packets, `--gap-ms` apart
 *
 * Wire format per datagram: u32 burst id, u32 sequence, zero padding to
 * `--payload-bytes`. Nothing else — this measures the kernel and the socket,
 * not a client.
 *
 * `--out <path>` writes the same JSON to a file, in both roles. That file is
 * the machine-readable path V-SP rides: `bench-g10` reads it through
 * `G10_BURST_RECV_JSON` / `G10_BURST_SEND_JSON` and refuses a C1 verdict
 * without it. Both artifacts stamp their own `date` and `host`, because the
 * falsifier's first question is whether the reading belongs to this run's day
 * and to the sink it claims to describe.
 */

import { writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { udpSocket } from "bun";

type Args = Record<string, string>;

function parseArgs(argv: string[]): Args {
	const out: Args = {};
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a?.startsWith("--")) {
			out[a.slice(2)] = argv[i + 1] ?? "";
			i += 1;
		}
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const role = args.role ?? "";
const port = Number.parseInt(args.port ?? "47999", 10);
const payloadBytes = Number.parseInt(args["payload-bytes"] ?? "200", 10);
const count = Number.parseInt(args.count ?? "10000", 10);
const bursts = Number.parseInt(args.bursts ?? "30", 10);
const gapMs = Number.parseInt(args["gap-ms"] ?? "1000", 10);
// 0 means blast (the emitter's natural shape). A positive value paces each
// burst at that many packets per second — the lever-1 experiment: does
// smearing the impulse below the path's sustained ceiling recover delivery?
const pacePps = Number.parseInt(args["pace-pps"] ?? "0", 10);
const outPath = args.out ?? "";

if (payloadBytes < 8) throw new Error("payload must hold burst id + sequence");

function percentile(sorted: number[], q: number): number {
	if (sorted.length === 0) return Number.NaN;
	const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
	return sorted[Math.max(0, idx)] as number;
}

/** Local calendar day, which is what "same-day artifact" means to the gate. */
function localDate(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Print the report, and register it as an artifact when `--out` asks. */
function publish(report: Record<string, unknown>): void {
	const text = JSON.stringify(report, null, 2);
	console.log(text);
	if (outPath !== "") {
		writeFileSync(outPath, `${text}\n`);
		console.error(`burst-probe: wrote ${outPath}`);
	}
}

if (role === "recv") {
	// Per-burst first/last arrival (ns) and distinct-sequence count. A burst is
	// closed by the sender's inter-burst gap: once no packet has arrived for
	// half the gap, whatever bursts are open get reported.
	const seen = new Map<
		number,
		{ first: bigint; last: bigint; seqs: Set<number> }
	>();
	let lastArrival = process.hrtime.bigint();
	let total = 0;

	const socket = await udpSocket({
		port,
		socket: {
			data(_sock, buf) {
				const at = process.hrtime.bigint();
				lastArrival = at;
				total += 1;
				const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
				const burst = view.getUint32(0);
				const seq = view.getUint32(4);
				const entry = seen.get(burst);
				if (entry === undefined) {
					seen.set(burst, { first: at, last: at, seqs: new Set([seq]) });
				} else {
					entry.last = at;
					entry.seqs.add(seq);
				}
			},
		},
	});
	console.error(
		`burst-probe recv: listening :${port}, expecting ${bursts}×${count}`,
	);

	const deadline = Date.now() + bursts * gapMs + 60_000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 200));
		const idleNs = process.hrtime.bigint() - lastArrival;
		if (seen.size >= bursts && idleNs > BigInt(gapMs) * 500_000n) break;
	}
	socket.close();

	const rows = [...seen.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([burst, e]) => ({
			burst,
			received: e.seqs.size,
			completeness: e.seqs.size / count,
			drainMs: Number(e.last - e.first) / 1e6,
		}));
	const drains = rows.map((r) => r.drainMs).sort((a, b) => a - b);
	const completeness = rows.map((r) => r.completeness).sort((a, b) => a - b);
	publish({
		role: "recv",
		date: localDate(),
		host: hostname(),
		port,
		payloadBytes,
		expected: { bursts, count },
		burstsSeen: rows.length,
		totalReceived: total,
		drainMsP50: percentile(drains, 0.5),
		drainMsP99: percentile(drains, 0.99),
		drainMsMax: drains.at(-1) ?? null,
		completenessMin: completeness[0] ?? null,
		perBurst: rows,
	});
} else if (role === "send") {
	const peer = args.peer ?? "";
	if (peer === "") throw new Error("send role needs --peer");
	const socket = await udpSocket({ connect: { hostname: peer, port } });
	const payload = new Uint8Array(payloadBytes);
	const view = new DataView(payload.buffer);
	const emits: number[] = [];
	for (let b = 0; b < bursts; b += 1) {
		const started = process.hrtime.bigint();
		let blocked = 0;
		view.setUint32(0, b);
		for (let s = 0; s < count; s += 1) {
			if (pacePps > 0) {
				// Stay on the pacing schedule: packet s is due at s/pace seconds
				// after the burst started. Ahead of schedule → yield; the loop
				// re-checks rather than sleeping, because timers here wake far
				// coarser than the ~13 µs inter-packet grid.
				const dueNs = BigInt(Math.round((s * 1e9) / pacePps));
				while (process.hrtime.bigint() - started < dueNs) {
					await new Promise((r) => setImmediate(r));
				}
			}
			view.setUint32(4, s);
			// A full socket buffer is the NIC serializing slower than the CPU
			// offers — yield and resend, so every sequence goes out exactly once.
			// Bun reports that as `false` on macOS and as a thrown EAGAIN on
			// Linux; both mean the same backoff.
			for (;;) {
				try {
					if (socket.send(payload)) break;
				} catch (err) {
					if ((err as { code?: string }).code !== "EAGAIN") throw err;
				}
				blocked += 1;
				await new Promise((r) => setTimeout(r, 0));
			}
		}
		const emitMs = Number(process.hrtime.bigint() - started) / 1e6;
		emits.push(emitMs);
		console.error(
			`burst-probe send: burst ${b} emitted in ${emitMs.toFixed(2)} ms (${blocked} backoffs)`,
		);
		await new Promise((r) => setTimeout(r, gapMs));
	}
	socket.close();
	const sorted = [...emits].sort((a, b) => a - b);
	publish({
		role: "send",
		date: localDate(),
		host: hostname(),
		peer,
		port,
		bursts,
		count,
		payloadBytes,
		pacePps,
		emitMsP50: percentile(sorted, 0.5),
		emitMsP99: percentile(sorted, 0.99),
		emitMsMax: sorted.at(-1) ?? null,
		perBurstEmitMs: emits,
	});
} else {
	console.error(
		"usage: burst-probe.ts --role recv|send [--peer H] [--port N] [--count N] [--bursts N] [--gap-ms N] [--payload-bytes N] [--out PATH]",
	);
	process.exit(2);
}
