/** Bounded, real connect-mode qualification. Not a throughput/calibration result. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
	discoverOwnedUdpInodes,
	ownedSocketInodes,
	parseLinuxProbeJsonl,
} from "./g6-sharded-diagnostic.ts";

const hash = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");
const PHASES = ["connect", "steady", "drain", "idle"] as const;
const source = String.raw`
import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
let udp=createSocket('udp4');
await new Promise(resolve=>udp.bind(0,'127.0.0.1',resolve));
const unix=createServer(),tcp=createServer();
await new Promise(resolve=>unix.listen(process.argv[1],resolve));
await new Promise(resolve=>tcp.listen(0,'127.0.0.1',resolve));
console.log('target-ready');
const rl=createInterface({input:process.stdin});
rl.on('line',async line=>{ if(line==='replace'){ const replacement=createSocket('udp4'); await new Promise(resolve=>replacement.bind(0,'127.0.0.1',resolve)); await new Promise(resolve=>udp.close(resolve)); udp=replacement; console.log('target-replaced'); } });
setTimeout(()=>process.exit(91),45000);
`;

type Case = {
	mode: "mixed" | "replace";
	targetPid: number;
	probePid: number;
	genericInodes: string[];
	stdout: string;
	stderr: string;
	raw: string;
	exitCode: number;
	targetBeforeStat: string;
	targetAfterStat: string;
	replacementInodes: string[];
	targetAbsent: boolean;
	probeAbsent: boolean;
};
export type LinuxProbeProof = {
	schema: "g6-linux-probe-proof/1";
	platform: "linux";
	arch: string;
	hostname: string;
	bootId: string;
	startedAt: string;
	finishedAt: string;
	proofSourceSha256: string;
	producerSha256: string;
	diagnosticSourceSha256: string;
	cases: Case[];
};
function fail(message: string): never {
	throw Error(`g6-linux-probe-proof: ${message}`);
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail("object required");
	return value as Record<string, unknown>;
}
function inodeInventory(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.every(
			(inode) => typeof inode === "string" && /^[1-9][0-9]*$/.test(inode),
		) &&
		new Set(value).size === value.length
	);
}
function nonnegative(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		fail("missing/nonnegative counter");
	return value;
}
function positive(value: unknown): number {
	const n = nonnegative(value);
	if (n === 0) fail("positive counter required");
	return n;
}
export function validateLinuxProbeProof(
	value: unknown,
	expected: {
		arch: string;
		bootId: string;
		proofSourceSha256: string;
		producerSha256: string;
		diagnosticSourceSha256: string;
	},
): LinuxProbeProof {
	const proof = record(value);
	if (
		Object.keys(proof).sort().join() !==
		[
			"schema",
			"platform",
			"arch",
			"hostname",
			"bootId",
			"startedAt",
			"finishedAt",
			"proofSourceSha256",
			"producerSha256",
			"diagnosticSourceSha256",
			"cases",
		]
			.sort()
			.join()
	)
		fail("proof fields");
	if (
		proof.schema !== "g6-linux-probe-proof/1" ||
		proof.platform !== "linux" ||
		typeof proof.arch !== "string" ||
		!["x64", "arm64"].includes(proof.arch) ||
		typeof proof.hostname !== "string" ||
		!/^[A-Za-z0-9._-]{1,253}$/.test(proof.hostname) ||
		typeof proof.bootId !== "string" ||
		!/^[a-f0-9-]{36}$/.test(proof.bootId)
	)
		fail("platform identity");
	for (const key of Object.keys(expected) as (keyof typeof expected)[])
		if (proof[key] !== expected[key]) fail(`identity ${key}`);
	for (const key of [
		"proofSourceSha256",
		"producerSha256",
		"diagnosticSourceSha256",
	])
		if (typeof proof[key] !== "string" || !/^[a-f0-9]{64}$/.test(proof[key]))
			fail("source hash");
	for (const key of ["startedAt", "finishedAt"])
		if (
			typeof proof[key] !== "string" ||
			!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(proof[key])
		)
			fail("proof timestamp");
	const elapsed =
		Date.parse(String(proof.finishedAt)) - Date.parse(String(proof.startedAt));
	if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 60000)
		fail("proof bound");
	if (!Array.isArray(proof.cases) || proof.cases.length !== 2) fail("cases");
	for (const [index, unknownCase] of proof.cases.entries()) {
		const item = record(unknownCase);
		if (
			Object.keys(item).sort().join() !==
			[
				"mode",
				"targetPid",
				"probePid",
				"genericInodes",
				"stdout",
				"stderr",
				"raw",
				"exitCode",
				"targetAbsent",
				"probeAbsent",
				"targetBeforeStat",
				"targetAfterStat",
				"replacementInodes",
			]
				.sort()
				.join()
		)
			fail("case fields");
		if (
			item.mode !== (index === 0 ? "mixed" : "replace") ||
			item.targetAbsent !== true ||
			item.probeAbsent !== true ||
			!Number.isSafeInteger(item.targetPid) ||
			!Number.isSafeInteger(item.probePid) ||
			Number(item.targetPid) <= 1 ||
			Number(item.probePid) <= 1 ||
			item.targetPid === item.probePid
		)
			fail("case ownership");
		if (
			typeof item.raw !== "string" ||
			item.raw.length > 4_000_000 ||
			typeof item.stdout !== "string" ||
			typeof item.stderr !== "string" ||
			item.stderr !== ""
		)
			fail("raw outputs");
		const rows = item.raw
			.trim()
			.split("\n")
			.map((line) => record(JSON.parse(line)));
		const header = record(rows[0]),
			footer = record(rows.at(-1));
		for (const row of [header, footer])
			if (
				row.queueCadenceMs !== 10 ||
				row.schedCadenceMs !== 50 ||
				record(row.measurementMode).detail !== "on" ||
				record(row.measurementMode).phaseAware !== true
			)
				fail("raw measurement mode/cadence");
		if (
			JSON.stringify(header.phaseOrder) !== JSON.stringify(PHASES) ||
			record(footer.childExit).code !== (index === 0 ? 0 : 2) ||
			record(footer.childExit).signal !== null ||
			footer.truncated !== false
		)
			fail("raw child/phase contract");
		const cpuStart = record(header.probeCpuStart),
			cpuEnd = record(footer.probeCpuEnd),
			summary = record(footer.summary),
			ticks = positive(header.clkTck);
		if (summary.clkTck !== ticks) fail("CPU clock identity");
		for (const [counter, seconds] of [
			["userJiffies", "probeUserSec"],
			["systemJiffies", "probeSysSec"],
		]) {
			const delta =
				nonnegative(cpuEnd[counter as string]) -
				nonnegative(cpuStart[counter as string]);
			if (delta < 0 || summary[seconds as string] !== delta / ticks)
				fail("raw CPU accounting");
		}
		if (
			header.schema !== "g6-c32-linux-probe-header/2" ||
			footer.schema !== "g6-c32-linux-probe/2" ||
			header.producerSha256 !== expected.producerSha256 ||
			footer.producerSha256 !== expected.producerSha256
		)
			fail("raw producer");
		if (!Array.isArray(header.shards) || header.shards.length !== 1)
			fail("raw targets");
		const shard = record(header.shards[0]);
		const memory = record(shard.socketMemory);
		if (
			positive(memory.receiveBufferBytes) !==
				positive(summary.effectiveReceiveBufferBytes) ||
			positive(memory.sendBufferBytes) !==
				positive(summary.effectiveSendBufferBytes)
		)
			fail("raw socket buffer evidence");
		if (
			shard.pid !== item.targetPid ||
			shard.serverId !== 1 ||
			!inodeInventory(shard.inodes) ||
			shard.inodes.length !== 1 ||
			!inodeInventory(item.genericInodes) ||
			item.genericInodes.length < 3 ||
			!item.genericInodes.includes(shard.inodes[0] as string)
		)
			fail("UDP-only selection");
		const acknowledgements = item.stdout.trim().split("\n");
		if (
			acknowledgements.shift() !== "g6-linux-probe: ready" ||
			acknowledgements.length !== 4
		)
			fail("phase ack sequence");
		const phaseRows = rows.filter(
			(row) => row.schema === "g6-c32-linux-probe-phase/1",
		);
		if (phaseRows.length !== 4) fail("phase boundary sequence");
		let priorMono = -1n;
		for (const [i, phase] of PHASES.entries()) {
			const ack = record(JSON.parse(acknowledgements[i] as string)),
				boundary = record(phaseRows[i]),
				finalBoundary = record(record(footer.phaseBoundaries)[phase]);
			if (
				ack.ev !== "phase-ack" ||
				ack.phase !== phase ||
				ack.requestId !== i + 1 ||
				ack.duplicate !== false ||
				typeof ack.monotonicNs !== "string" ||
				!/^[0-9]{1,29}$/.test(ack.monotonicNs) ||
				BigInt(ack.monotonicNs) <= priorMono ||
				boundary.phase !== phase ||
				boundary.requestId !== ack.requestId ||
				boundary.monotonicNs !== ack.monotonicNs ||
				finalBoundary.monotonicNs !== ack.monotonicNs ||
				finalBoundary.requestId !== ack.requestId
			)
				fail("phase ack identity/order");
			priorMono = BigInt(ack.monotonicNs);
		}
		const allQueues = rows.filter(
				(row) => row.schema === "g6-c32-linux-probe-queue/2",
			),
			allSched = rows.filter(
				(row) => row.schema === "g6-c32-linux-probe-sched/2",
			);
		let sampleClock = -1n;
		for (const row of rows.slice(1, -1)) {
			if (
				![
					"g6-c32-linux-probe-phase/1",
					"g6-c32-linux-probe-queue/2",
					"g6-c32-linux-probe-sched/2",
				].includes(String(row.schema)) ||
				typeof row.monotonicNs !== "string" ||
				!/^\d{1,29}$/.test(row.monotonicNs)
			)
				fail("unknown raw row/clock");
			const now = BigInt(row.monotonicNs);
			if (now < sampleClock) fail("raw clock reversed");
			sampleClock = now;
			const phaseIndex = PHASES.findIndex((phase) => phase === row.phase);
			if (phaseIndex < 0) fail("raw phase");
			if (
				now < BigInt(String(record(phaseRows[phaseIndex]).monotonicNs)) ||
				(phaseIndex < 3 &&
					now >= BigInt(String(record(phaseRows[phaseIndex + 1]).monotonicNs)))
			)
				fail("raw phase clock interval");
		}
		if (
			footer.queueSamples !== allQueues.length ||
			footer.schedSamples !== allSched.length
		)
			fail("raw sample totals");
		for (const phase of PHASES) {
			const counts = record(record(footer.phaseCoverage)[phase]),
				queue = allQueues.filter((row) => row.phase === phase),
				sched = allSched.filter((row) => row.phase === phase);
			if (
				!queue.length ||
				!sched.length ||
				counts.queueSamples !== queue.length ||
				counts.schedSamples !== sched.length
			)
				fail("raw phase coverage");
		}
		for (const row of allQueues) {
			if (!Array.isArray(row.shards) || row.shards.length !== 1)
				fail("queue shards");
			const q = record(row.shards[0]);
			for (const field of [
				"txQueueBytes",
				"rxQueueBytes",
				"drops",
				"socketCount",
			])
				nonnegative(q[field]);
			if (q.socketCount === 0) {
				if (
					index !== 1 ||
					q.txQueueBytes !== 0 ||
					q.rxQueueBytes !== 0 ||
					q.drops !== 0 ||
					"udp4SocketCount" in q ||
					"udp6SocketCount" in q
				)
					fail("unexpected failed queue shape");
			} else {
				if (q.socketCount !== shard.inodes.length)
					fail("queue socket count differs from frozen identity");
				nonnegative(q.udp4SocketCount);
				nonnegative(q.udp6SocketCount);
				if (
					Number(q.udp4SocketCount) + Number(q.udp6SocketCount) !==
					q.socketCount
				)
					fail("queue family counters");
			}
			if (
				q.pid !== shard.pid ||
				q.serverId !== shard.serverId ||
				JSON.stringify(q.inodes) !== JSON.stringify(shard.inodes)
			)
				fail("queue identity/counters");
		}
		for (const row of allSched) {
			if (!Array.isArray(row.sched) || row.sched.length !== 1)
				fail("scheduler shards");
			const s = record(row.sched[0]);
			if (s.pid !== shard.pid || s.serverId !== shard.serverId)
				fail("scheduler identity");
			for (const field of ["runtimeNs", "waitNs", "timeslices"])
				nonnegative(s[field]);
		}
		if (index === 0) {
			if (
				!Array.isArray(item.replacementInodes) ||
				item.replacementInodes.length !== 0
			)
				fail("mixed case has replacement inventory");
			parseLinuxProbeJsonl(item.raw);
			if (
				item.exitCode !== 0 ||
				footer.complete !== true ||
				!Array.isArray(footer.problems) ||
				footer.problems.length !== 0 ||
				footer.truncated !== false
			)
				fail("positive incomplete");
			const coverage = record(footer.phaseCoverage);
			for (const [phaseIndex, phase] of PHASES.entries()) {
				const counts = record(coverage[phase]);
				const queue = rows.filter(
					(row) =>
						row.schema === "g6-c32-linux-probe-queue/2" && row.phase === phase,
				);
				const sched = rows.filter(
					(row) =>
						row.schema === "g6-c32-linux-probe-sched/2" && row.phase === phase,
				);
				if (
					counts.queueSamples !== queue.length ||
					counts.schedSamples !== sched.length ||
					!queue.length ||
					!sched.length
				)
					fail("raw phase coverage");
				const boundary = record(phaseRows[phaseIndex]);
				for (const sample of [...queue, ...sched])
					if (
						typeof sample.monotonicNs !== "string" ||
						!/^\d{1,29}$/.test(sample.monotonicNs) ||
						BigInt(sample.monotonicNs) < BigInt(String(boundary.monotonicNs)) ||
						(phaseIndex < 3 &&
							BigInt(sample.monotonicNs) >=
								BigInt(String(record(phaseRows[phaseIndex + 1]).monotonicNs)))
					)
						fail("sample outside phase");
				for (const row of queue) {
					if (!Array.isArray(row.shards) || row.shards.length !== 1)
						fail("queue shard");
					const q = record(row.shards[0]);
					if (
						q.pid !== shard.pid ||
						q.socketCount !== 1 ||
						JSON.stringify(q.inodes) !== JSON.stringify(shard.inodes)
					)
						fail("queue identity");
				}
			}
		} else {
			if (
				item.exitCode !== 2 ||
				footer.complete !== false ||
				!Array.isArray(footer.problems) ||
				!footer.problems.some(
					(p) =>
						typeof p === "string" &&
						/frozen process\/UDP socket identity changed/.test(p),
				)
			)
				fail("replacement was accepted");
			const ticks = (value: unknown) => {
				if (
					typeof value !== "string" ||
					!value.startsWith(`${item.targetPid} (`)
				)
					fail("target stat missing");
				const fields = value
					.slice(value.lastIndexOf(")") + 2)
					.trim()
					.split(/\s+/);
				if (
					!/^([RSDTtKWPI])$/.test(fields[0] ?? "") ||
					fields.length < 20 ||
					fields.slice(1, 20).some((field) => !/^[-]?\d+$/.test(field)) ||
					!/^[1-9][0-9]*$/.test(fields[19] ?? "")
				)
					fail("target not alive");
				return fields[19];
			};
			if (
				ticks(item.targetBeforeStat) !== ticks(item.targetAfterStat) ||
				!inodeInventory(item.replacementInodes) ||
				item.replacementInodes.length !== 1 ||
				item.replacementInodes[0] === shard.inodes[0]
			)
				fail("replacement identity not observed on same live target");
			if (
				!rows.some(
					(row) =>
						row.schema === "g6-c32-linux-probe-queue/2" &&
						["drain", "idle"].includes(String(row.phase)) &&
						Array.isArray(row.shards) &&
						record(row.shards[0]).socketCount === 0,
				)
			)
				fail("missing failed replacement queue sample");
		}
	}
	return proof as LinuxProbeProof;
}

export async function runLinuxProbeProof(
	signal?: AbortSignal,
): Promise<LinuxProbeProof> {
	if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
		fail("Linux64 required; no skipped PASS");
	const startedAt = new Date().toISOString(),
		deadline = performance.now() + 45000;
	const root = mkdtempSync(join(tmpdir(), "g6-connect-proof-"));
	const children: ChildProcessWithoutNullStreams[] = [];
	const closed = new Set<ChildProcessWithoutNullStreams>(),
		errors = new Map<ChildProcessWithoutNullStreams, Error>();
	let interrupted = false;
	const interrupt = () => {
		interrupted = true;
	};
	const timeout = setTimeout(interrupt, 45000);
	const append = (current: string, bytes: Buffer): string => {
		if (Buffer.byteLength(current) + bytes.length > 65536) {
			interrupted = true;
			return current;
		}
		return current + bytes.toString("utf8");
	};
	process.on("SIGTERM", interrupt);
	process.on("SIGINT", interrupt);
	const own = (child: ChildProcessWithoutNullStreams) => {
		children.push(child);
		child.on("error", (error) => errors.set(child, error));
		child.on("close", () => closed.add(child));
		return child;
	};
	const wait = async (condition: () => boolean, bound = 5000) => {
		if (signal?.aborted || interrupted) fail("interrupted");
		const cutoff = Math.min(deadline, performance.now() + bound);
		while (!condition()) {
			if (signal?.aborted || interrupted) fail("interrupted");
			if (errors.size)
				fail(`child startup failed: ${[...errors.values()][0]?.message}`);
			if (performance.now() >= cutoff) fail("bounded wait expired");
			await Bun.sleep(10);
		}
		if (signal?.aborted || interrupted) fail("interrupted");
	};
	const stop = async (child: ChildProcessWithoutNullStreams) => {
		if (closed.has(child)) return;
		child.stdin.end();
		child.kill("SIGTERM");
		const grace = performance.now() + 1000;
		while (!closed.has(child) && performance.now() < grace) await Bun.sleep(10);
		if (!closed.has(child)) {
			child.kill("SIGKILL");
			const killCutoff = performance.now() + 1000;
			while (!closed.has(child) && performance.now() < killCutoff)
				await Bun.sleep(10);
		}
		if (!closed.has(child)) fail("child close cleanup failed");
	};
	const cases: Case[] = [];
	try {
		for (const mode of ["mixed", "replace"] as const) {
			const target = own(
				spawn(process.execPath, ["-e", source, join(root, `${mode}.sock`)], {
					stdio: "pipe",
				}),
			);
			let targetOutput = "";
			target.stdout.on("data", (bytes) => {
				targetOutput = append(targetOutput, bytes);
			});
			target.stderr.on("data", (bytes) => {
				targetOutput = append(targetOutput, bytes);
			});
			await wait(() => targetOutput.includes("target-ready"));
			if (!target.pid) fail("no target pid");
			const genericInodes = [...ownedSocketInodes(target.pid)];
			const targetBeforeStat = readFileSync(`/proc/${target.pid}/stat`, "utf8");
			let targetAfterStat = targetBeforeStat,
				replacementInodes: string[] = [];
			const out = join(root, `${mode}.jsonl`);
			const probe = own(
				spawn(
					process.execPath,
					[
						join(import.meta.dir, "g6-linux-probe.ts"),
						"--mode",
						"connect",
						"--out",
						out,
						"--shards",
						`1=${target.pid}`,
						"--producer-sha256",
						hash(readFileSync(join(import.meta.dir, "g6-linux-probe.ts"))),
						"--detail-mode",
						"on",
					],
					{ stdio: "pipe" },
				),
			);
			let stdout = "",
				stderr = "";
			probe.stdout.on("data", (bytes) => {
				stdout = append(stdout, bytes);
			});
			probe.stderr.on("data", (bytes) => {
				stderr = append(stderr, bytes);
			});
			await wait(
				() =>
					stdout.includes("g6-linux-probe: ready") || probe.exitCode !== null,
			);
			if (!stdout.includes("g6-linux-probe: ready"))
				fail(
					`probe startup refused: ${stderr} ${existsSync(out) ? readFileSync(out, "utf8").slice(-2000) : ""}`,
				);
			for (const [index, phase] of PHASES.entries()) {
				probe.stdin.write(
					`${JSON.stringify({ cmd: "phase", phase, requestId: index + 1 })}\n`,
				);
				await wait(() =>
					stdout
						.split("\n")
						.some(
							(line) =>
								line.startsWith("{") && JSON.parse(line).phase === phase,
						),
				);
				await Bun.sleep(180);
				if (mode === "replace" && phase === "steady") {
					target.stdin.write("replace\n");
					await wait(() => targetOutput.includes("target-replaced"));
					targetAfterStat = readFileSync(`/proc/${target.pid}/stat`, "utf8");
					replacementInodes = [
						...discoverOwnedUdpInodes(
							ownedSocketInodes(target.pid),
							readFileSync(`/proc/${target.pid}/net/udp`, "utf8"),
							readFileSync(`/proc/${target.pid}/net/udp6`, "utf8"),
						),
					];
				}
			}
			await stop(probe);
			if (!probe.pid) fail("no probe pid");
			await stop(target);
			cases.push({
				mode,
				targetPid: target.pid,
				probePid: probe.pid,
				genericInodes,
				stdout,
				stderr,
				raw: readFileSync(out, "utf8"),
				exitCode: probe.exitCode ?? -1,
				targetAbsent: !existsSync(`/proc/${target.pid}`),
				probeAbsent: !existsSync(`/proc/${probe.pid}`),
				targetBeforeStat,
				targetAfterStat,
				replacementInodes,
			});
		}
		const proof: LinuxProbeProof = {
			schema: "g6-linux-probe-proof/1",
			platform: "linux",
			arch: process.arch,
			hostname: hostname(),
			bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
			startedAt,
			finishedAt: new Date().toISOString(),
			proofSourceSha256: hash(readFileSync(new URL(import.meta.url))),
			producerSha256: hash(
				readFileSync(join(import.meta.dir, "g6-linux-probe.ts")),
			),
			diagnosticSourceSha256: hash(
				readFileSync(join(import.meta.dir, "g6-sharded-diagnostic.ts")),
			),
			cases,
		};
		if (signal?.aborted || interrupted) fail("interrupted");
		const validated = validateLinuxProbeProof(proof, proof);
		if (signal?.aborted || interrupted) fail("interrupted");
		return validated;
	} finally {
		clearTimeout(timeout);
		const cleanupErrors: unknown[] = [];
		for (const child of children.toReversed()) {
			try {
				await stop(child);
				await stop(child);
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		process.off("SIGTERM", interrupt);
		process.off("SIGINT", interrupt);
		rmSync(root, { recursive: true, force: true });
		if (cleanupErrors.length)
			fail(`cleanup failed: ${cleanupErrors.map(String).join(";")}`);
	}
}
if (import.meta.main)
	runLinuxProbeProof()
		.then((proof) => console.log(JSON.stringify(proof)))
		.catch((error) => {
			console.error(String(error));
			process.exitCode = 2;
		});
