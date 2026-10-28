import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requireDefined } from "./g6-c32-freeze-model.ts";
import { linuxProbeProofFixture } from "./g6-linux-probe-proof.fixture.test-helper.ts";
import {
	runLinuxProbeProof,
	validateLinuxProbeProof,
} from "./g6-linux-probe-proof.ts";

const expected = {
	arch: "x64",
	bootId: "11111111-1111-4111-8111-111111111111",
	proofSourceSha256: "a".repeat(64),
	producerSha256: "b".repeat(64),
	diagnosticSourceSha256: "c".repeat(64),
};
test("raw connect proof requires exact phases, identities and negative replacement evidence", () => {
	const fixture = () =>
		linuxProbeProofFixture({
			...expected,
			startedAt: "2026-09-06T00:00:00.000Z",
			finishedAt: "2026-09-06T00:00:03.000Z",
		});
	expect(validateLinuxProbeProof(fixture(), expected).cases).toHaveLength(2);
	for (const mutate of [
		(p: ReturnType<typeof fixture>) => {
			p.arch = "arm64";
		},
		(p: ReturnType<typeof fixture>) => {
			requireDefined(p.cases[0]).raw = "{}\n";
		},
		(p: ReturnType<typeof fixture>) => {
			const first = requireDefined(p.cases[0]);
			first.stdout = first.stdout.split("\n").reverse().join("\n");
		},
		(p: ReturnType<typeof fixture>) => {
			const first = requireDefined(p.cases[0]);
			first.stdout = first.stdout.replace(
				'"monotonicNs":"1000000"',
				'"monotonicNs":"9"',
			);
		},
		(p: ReturnType<typeof fixture>) => {
			requireDefined(p.cases[1]).replacementInodes = ["111"];
		},
		(p: ReturnType<typeof fixture>) => {
			const second = requireDefined(p.cases[1]);
			second.targetAfterStat = second.targetAfterStat.replace("12345", "12346");
		},
		(p: ReturnType<typeof fixture>) => {
			requireDefined(p.cases[0]).probeAbsent = false;
		},
	]) {
		const p = fixture();
		mutate(p);
		expect(() => validateLinuxProbeProof(p, expected)).toThrow();
	}
});

test("raw connect proof refuses altered cadence, child exit, unavailable counters and socket buffers", () => {
	for (const mutation of [
		(rows: Record<string, unknown>[]) => {
			(
				requireDefined(rows[0]).measurementMode as Record<string, unknown>
			).detail = "off";
		},
		(rows: Record<string, unknown>[]) => {
			requireDefined(rows.at(-1)).queueCadenceMs = 20;
		},
		(rows: Record<string, unknown>[]) => {
			(requireDefined(rows.at(-1)).childExit as Record<string, unknown>).code =
				7;
		},
		(rows: Record<string, unknown>[]) => {
			delete requireDefined(rows.at(-1)).probeCpuEnd;
		},
		(rows: Record<string, unknown>[]) => {
			(
				requireDefined(rows.at(-1)).summary as Record<string, unknown>
			).effectiveSendBufferBytes = null;
		},
		(rows: Record<string, unknown>[]) => {
			const row = requireDefined(
				rows.find((row) => row.schema === "g6-c32-linux-probe-queue/2"),
			);
			requireDefined((row.shards as Record<string, unknown>[])[0]).drops = -1;
		},
	]) {
		const proof = linuxProbeProofFixture({
				...expected,
				startedAt: "2026-09-06T00:00:00.000Z",
				finishedAt: "2026-09-06T00:00:03.000Z",
			}),
			first = requireDefined(proof.cases[0]);
		const rows = first.raw
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		mutation(rows);
		first.raw = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
		expect(() => validateLinuxProbeProof(proof, expected)).toThrow();
	}
});

test.each([
	"X",
	"Z",
	"?",
	"malformed-prefix",
])("negative replacement rejects non-live or malformed process stat: %s", (state) => {
	const proof = linuxProbeProofFixture({
		...expected,
		startedAt: "2026-09-06T00:00:00.000Z",
		finishedAt: "2026-09-06T00:00:03.000Z",
	});
	const negative = requireDefined(proof.cases[1]);
	const mutate = (stat: string) =>
		state === "malformed-prefix"
			? stat.replace(") S 0 ", ") S broken ")
			: stat.replace(") S ", `) ${state} `);
	negative.targetBeforeStat = mutate(negative.targetBeforeStat);
	negative.targetAfterStat = mutate(negative.targetAfterStat);
	expect(() => validateLinuxProbeProof(proof, expected)).toThrow(
		/target not alive/,
	);
});

test.each([
	"missing-all",
	"unrelated-all",
	"missing-failed",
	"unrelated-healthy",
])("negative replacement preserves frozen queue inodes: %s", (mutation) => {
	const proof = linuxProbeProofFixture({
		...expected,
		startedAt: "2026-09-06T00:00:00.000Z",
		finishedAt: "2026-09-06T00:00:03.000Z",
	});
	const negative = requireDefined(proof.cases[1]);
	const rows: Record<string, unknown>[] = negative.raw
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	let changed = 0;
	for (const row of rows)
		if (row.schema === "g6-c32-linux-probe-queue/2") {
			const shard = requireDefined(
				(row.shards as Record<string, unknown>[])[0],
			);
			if (mutation === "missing-failed" && shard.socketCount !== 0) continue;
			if (mutation === "unrelated-healthy" && shard.socketCount === 0) continue;
			if (mutation.startsWith("missing")) delete shard.inodes;
			else shard.inodes = ["999"];
			changed++;
		}
	expect(changed).toBeGreaterThan(0);
	negative.raw = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
	expect(() => validateLinuxProbeProof(proof, expected)).toThrow(
		/queue identity/,
	);
});

test("negative replacement healthy rows retain exactly the one frozen UDP socket", () => {
	const proof = linuxProbeProofFixture({
		...expected,
		startedAt: "2026-09-06T00:00:00.000Z",
		finishedAt: "2026-09-06T00:00:03.000Z",
	});
	const negative = requireDefined(proof.cases[1]);
	const rows: Record<string, unknown>[] = negative.raw
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	let changed = 0;
	for (const row of rows)
		if (row.schema === "g6-c32-linux-probe-queue/2") {
			const shard = requireDefined(
				(row.shards as Record<string, unknown>[])[0],
			);
			if (shard.socketCount === 0) continue;
			shard.socketCount = 2;
			shard.udp4SocketCount = 2;
			changed++;
		}
	expect(changed).toBeGreaterThan(0);
	negative.raw = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
	expect(() => validateLinuxProbeProof(proof, expected)).toThrow(
		/queue socket count/,
	);
});

test.each([
	"null-frozen",
	"null-replacement",
	"zero-replacement",
	"numeric-replacement",
	"duplicate-generic",
	"invalid-generic",
	"wrong-shard",
])("negative proof rejects invalid inode and shard domains: %s", (mutation) => {
	const proof = linuxProbeProofFixture({
		...expected,
		startedAt: "2026-09-06T00:00:00.000Z",
		finishedAt: "2026-09-06T00:00:03.000Z",
	});
	const negative = requireDefined(proof.cases[1]) as unknown as Record<
		string,
		unknown
	>;
	const rows: Record<string, unknown>[] = String(negative.raw)
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	if (mutation === "null-frozen") {
		negative.genericInodes = [null, "900", "901"];
		for (const row of rows)
			if (Array.isArray(row.shards))
				for (const shard of row.shards) shard.inodes = [null];
	}
	if (mutation === "null-replacement") negative.replacementInodes = [null];
	if (mutation === "zero-replacement") negative.replacementInodes = ["0"];
	if (mutation === "numeric-replacement") negative.replacementInodes = [222];
	if (mutation === "duplicate-generic")
		negative.genericInodes = ["111", "900", "900"];
	if (mutation === "invalid-generic")
		negative.genericInodes = ["111", "900", null];
	if (mutation === "wrong-shard")
		for (const row of rows)
			for (const key of ["shards", "sched"])
				if (Array.isArray(row[key]))
					for (const shard of row[key]) shard.serverId = 2;
	negative.raw = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
	expect(() => {
		validateLinuxProbeProof(proof, expected);
	}).toThrow();
});

test("mixed proof has no replacement inode inventory", () => {
	const proof = linuxProbeProofFixture({
		...expected,
		startedAt: "2026-09-06T00:00:00.000Z",
		finishedAt: "2026-09-06T00:00:03.000Z",
	});
	requireDefined(proof.cases[0]).replacementInodes = ["222"];
	expect(() => {
		validateLinuxProbeProof(proof, expected);
	}).toThrow();
});

if (process.platform !== "linux")
	test("non-Linux proof explicitly refuses rather than returning skipped PASS", async () => {
		await expect(runLinuxProbeProof()).rejects.toThrow(
			"Linux64 required; no skipped PASS",
		);
	});

if (process.platform === "linux")
	for (const mode of [
		"SIGTERM",
		"SIGINT",
		"startup-no-ss",
		"probe-stopped-timeout",
		"late-SIGTERM",
	] as const)
		test(`real connect proof owns bounded cleanup after ${mode}`, async () => {
			const started = performance.now();
			const owner = spawn(
				process.execPath,
				[join(import.meta.dir, "g6-linux-probe-proof.ts")],
				{
					env: {
						...process.env,
						...(mode === "startup-no-ss" ? { PATH: "/nonexistent" } : {}),
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			const pid = requireDefined(owner.pid),
				owned = new Set<number>();
			let closed = false,
				out = "",
				err = "",
				injected = false;
			owner.on("close", () => {
				closed = true;
			});
			owner.on("error", (error) => {
				err = String(error);
			});
			owner.stdout.on("data", (bytes) => {
				out = (out + bytes).slice(-100000);
			});
			owner.stderr.on("data", (bytes) => {
				err = (err + bytes).slice(-100000);
			});
			try {
				while (!closed && performance.now() - started < 12000) {
					let children: number[] = [];
					try {
						children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
							.trim()
							.split(/\s+/)
							.filter(Boolean)
							.map(Number);
					} catch {}
					for (const child of children) owned.add(child);
					if (!injected && children.length >= 2 && mode !== "startup-no-ss") {
						if (mode === "late-SIGTERM") {
							for (const child of children)
								try {
									const argv = readFileSync(
											`/proc/${child}/cmdline`,
											"utf8",
										).split("\0"),
										out = argv[argv.indexOf("--out") + 1];
									if (
										out?.endsWith("replace.jsonl") &&
										readFileSync(out, "utf8")
											.split("\n")
											.some(
												(line) =>
													line.includes(
														'"schema":"g6-c32-linux-probe-phase/1"',
													) && line.includes('"phase":"idle"'),
											)
									) {
										owner.kill("SIGTERM");
										injected = true;
									}
								} catch {}
						} else if (mode === "probe-stopped-timeout") {
							const probe = children.find((child) => {
								try {
									return readFileSync(
										`/proc/${child}/cmdline`,
										"utf8",
									).includes("g6-linux-probe.ts");
								} catch {
									return false;
								}
							});
							if (probe) {
								process.kill(probe, "SIGSTOP");
								injected = true;
							}
						} else {
							owner.kill(mode);
							injected = true;
						}
					}
					await Bun.sleep(5);
				}
				expect(closed, err).toBe(true);
				expect(owner.exitCode, err).toBe(2);
				expect(out).toBe("");
				expect(existsSync(`/proc/${pid}`)).toBe(false);
				for (const child of owned)
					expect(existsSync(`/proc/${child}`)).toBe(false);
				if (mode !== "startup-no-ss") {
					expect(injected).toBe(true);
					expect(owned.size).toBeGreaterThanOrEqual(2);
				}
			} finally {
				if (!closed) owner.kill("SIGKILL");
				for (const child of owned)
					if (existsSync(`/proc/${child}`))
						try {
							process.kill(child, "SIGKILL");
						} catch {}
				const cutoff = performance.now() + 1500;
				while (!closed && performance.now() < cutoff) await Bun.sleep(10);
			}
		}, 15000);

test("raw connect proof accepts the /3 phase-aware header and refuses a misdeclared connect cadence", () => {
	const proofFor = (
		mutate: (rows: Record<string, unknown>[]) => void,
	): ReturnType<typeof linuxProbeProofFixture> => {
		const proof = linuxProbeProofFixture({
			...expected,
			startedAt: "2026-09-06T00:00:00.000Z",
			finishedAt: "2026-09-06T00:00:03.000Z",
		});
		for (const item of proof.cases) {
			const rows: Record<string, unknown>[] = item.raw
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			mutate(rows);
			const footer = requireDefined(rows.at(-1));
			footer.artifactBytes = Buffer.byteLength(
				`${rows
					.slice(0, -1)
					.map((row) => JSON.stringify(row))
					.join("\n")}\n`,
			);
			item.raw = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
		}
		return proof;
	};
	const upgrade = (rows: Record<string, unknown>[]) => {
		requireDefined(rows[0]).schema = "g6-c32-linux-probe-header/3";
		requireDefined(rows[0]).connectQueueCadenceMs = 50;
		requireDefined(rows.at(-1)).connectQueueCadenceMs = 50;
	};
	expect(
		validateLinuxProbeProof(proofFor(upgrade), expected).cases,
	).toHaveLength(2);
	// Historical /2 receipts still verify unchanged.
	expect(
		validateLinuxProbeProof(
			proofFor(() => {}),
			expected,
		).cases,
	).toHaveLength(2);
	for (const mutate of [
		(rows: Record<string, unknown>[]) => {
			upgrade(rows);
			requireDefined(rows[0]).connectQueueCadenceMs = 10;
		},
		(rows: Record<string, unknown>[]) => {
			upgrade(rows);
			delete requireDefined(rows.at(-1)).connectQueueCadenceMs;
		},
		(rows: Record<string, unknown>[]) => {
			requireDefined(rows[0]).connectQueueCadenceMs = 50;
		},
		(rows: Record<string, unknown>[]) => {
			upgrade(rows);
			requireDefined(rows[0]).schema = "g6-c32-linux-probe-header/4";
		},
	])
		expect(() => validateLinuxProbeProof(proofFor(mutate), expected)).toThrow(
			/cadence|producer/,
		);
});
