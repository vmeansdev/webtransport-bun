import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	appendSpendLedgerEntry,
	budgetPolicyArtifactSha256,
	spendLedgerEntryArtifactSha256,
} from "./g6-c32-budget.ts";
import { requireDefined } from "./g6-c32-freeze-model.ts";
import { runWorkCli } from "./g6-c32-work-cli.ts";
import {
	createWorkFinal,
	finishWorkCell,
	gradePendingWorkCell,
	initializeWorkExecution,
	readWorkCellEvidence,
	readWorkExecution,
	sealPendingWorkCell,
	startWorkCell,
	verifyWorkFinal,
	writeWorkJson,
} from "./g6-c32-work-execution.ts";
import {
	cleanupWorkFixtures,
	executionFixture,
	operationFixture,
	type WorkGradeFixture,
	workAuthorityFixture,
	workGradeFixture,
	workProbeFixture,
} from "./g6-c32-work-fixture.test-helper.ts";
import { LatencyHistogram } from "./latency-histogram.ts";

afterEach(() => {
	setSystemTime();
	cleanupWorkFixtures();
});

test("execution binds an exclusive immutable authority capsule and rejects re-sealed state drift", () => {
	const input = executionFixture();
	const statePath = join(input.root, "work-execution.json"),
		authorityPath = join(input.root, "work-authority.json"),
		state = JSON.parse(readFileSync(statePath, "utf8"));
	expect(state.authority).toMatchObject({ path: "work-authority.json" });
	const authorityBytes = readFileSync(authorityPath),
		authority = JSON.parse(authorityBytes.toString("utf8"));
	expect(state.authority.sha256).toBe(
		createHash("sha256").update(authorityBytes).digest("hex"),
	);
	writeFileSync(
		authorityPath,
		JSON.stringify({ ...authority, registrationSha256: "e".repeat(64) }),
	);
	expect(() =>
		readWorkExecution({ ...input, now: "2026-09-05T00:02:10.000Z" }),
	).toThrow(/digest/);
	state.authority.sha256 = createHash("sha256")
		.update(readFileSync(authorityPath))
		.digest("hex");
	writeFileSync(statePath, JSON.stringify(state));
	expect(() =>
		readWorkExecution({ ...input, now: "2026-09-05T00:02:10.000Z" }),
	).toThrow(/authority/);
	writeFileSync(authorityPath, authorityBytes);
	state.authority.sha256 = createHash("sha256")
		.update(authorityBytes)
		.digest("hex");
	state.authority.path = "qualification/setup.receipt.json";
	writeFileSync(statePath, JSON.stringify(state));
	expect(() =>
		readWorkExecution({ ...input, now: "2026-09-05T00:02:10.000Z" }),
	).toThrow(/authority/);
});

test("initialization rejects source and policy values not bound by the capsule before writing state", () => {
	const input = executionFixture();
	renameSync(
		join(input.root, "work-execution.json"),
		join(input.root, "prior-state.json"),
	);
	const authority = workAuthorityFixture(input.policy),
		valid = {
			...input,
			authority,
			deadline: "2026-09-05T02:00:00.000Z",
			candidateSha: authority.candidateSha,
			registrationSha256: authority.registrationSha256,
			nativeProducerSha256: authority.nativeProducerSha256,
			probeProducerSha256: authority.probeProducerSha256,
			setupReceiptPath: "qualification/setup.receipt.json",
			now: "2026-09-05T00:02:00.000Z",
		};
	for (const key of [
		"candidateSha",
		"registrationSha256",
		"nativeProducerSha256",
		"probeProducerSha256",
	] as const)
		expect(() =>
			initializeWorkExecution({
				...valid,
				[key]: "f".repeat(key === "candidateSha" ? 40 : 64),
			}),
		).toThrow(/authority/);
	expect(() =>
		initializeWorkExecution({
			...valid,
			authority: { ...authority, policySha256: "f".repeat(64) },
		}),
	).toThrow(/authority/);
	expect(() => readFileSync(join(input.root, "work-execution.json"))).toThrow();
	const retained = readFileSync(join(input.root, "work-authority.json"));
	expect(() => initializeWorkExecution(valid)).toThrow(/EEXIST/);
	expect(readFileSync(join(input.root, "work-authority.json"))).toEqual(
		retained,
	);
});

test("work state persists a mandatory probe producer authority independently of raw probe claims", () => {
	const input = executionFixture();
	const path = join(input.root, "work-execution.json"),
		state = JSON.parse(readFileSync(path, "utf8"));
	expect(state.probeProducerSha256).toBe("d".repeat(64));
	for (const value of [undefined, "not-a-hash"]) {
		writeFileSync(
			path,
			JSON.stringify({ ...state, probeProducerSha256: value }),
		);
		expect(() =>
			readWorkExecution({ ...input, now: "2026-09-05T00:02:10.000Z" }),
		).toThrow();
	}
});

test("execution derives setup/paid/control time and refuses naked PASS or unknown progress", () => {
	const input = executionFixture();
	const progress = readWorkExecution({
		...input,
		now: "2026-09-05T00:02:10.000Z",
	});
	expect(progress).toMatchObject({
		elapsedPaidSeconds: 130,
		controlUsedSeconds: 10,
		nextNode: { id: "A0-1" },
		completed: [],
	});
	const path = join(input.root, "work-execution.json"),
		state = JSON.parse(readFileSync(path, "utf8"));
	state.completed = [{ nodeId: "A0-1", outcome: "PASS" }];
	writeFileSync(path, JSON.stringify(state));
	expect(() =>
		readWorkExecution({ ...input, now: "2026-09-05T00:02:10.000Z" }),
	).toThrow();
});

test("cell timer begins before admission and refuses expired completion without advancing", () => {
	const input = executionFixture();
	startWorkCell({
		...input,
		nodeId: "A0-1",
		now: "2026-09-05T00:02:10.000Z",
		monotonicNs: "1000",
	});
	expect(() =>
		finishWorkCell({
			...input,
			nodeId: "A0-1",
			now: "2026-09-05T00:09:11.000Z",
			monotonicNs: "421000001000",
		}),
	).toThrow(/cell.*(bound|deadline)/);
	expect(
		readWorkExecution({ ...input, now: "2026-09-05T00:09:11.000Z" }).completed,
	).toEqual([]);
});

function prepareCell(
	input = executionFixture(),
	mutate: (raw: WorkGradeFixture) => void = () => {},
	now = "2026-09-05T00:02:10.000Z",
) {
	const progress = readWorkExecution({ ...input, now }),
		node = requireDefined(progress.nextNode),
		nodeId = node.id;
	startWorkCell({ ...input, nodeId, now, monotonicNs: "1" });
	const at = (offset: number) =>
		new Date(Date.parse(now) + offset).toISOString();
	const dir = join(input.root, "work", nodeId),
		sequenceBase = progress.completed.length * 100,
		raw = workGradeFixture({
			node,
			profile: requireDefined(progress.policy.workProfiles[node.profile]),
			startedAt: at(2000),
			sequence: sequenceBase + 20,
		});
	mutate(raw);
	for (const [file, value] of Object.entries({
		"g6-sharded-scan.json": raw.scan,
		"g6-sharded-diagnostic.json": raw.diagnostic,
		"scan-owner.json": raw.owners.server,
		"generator-owner.json": raw.owners.generator,
	}))
		writeFileSync(join(dir, file), JSON.stringify(value));
	writeFileSync(join(dir, "post-run-steering.json"), raw.postRunSteeringText);
	if (raw.probe !== null)
		writeFileSync(join(dir, "linux-probe.jsonl"), raw.probe);
	const admission = appendSpendLedgerEntry(
		requireDefined(input.ledger.at(-1)),
		{
			recordedAt: now,
			campaignId: input.policy.campaignId,
			runId: input.policy.runId,
			budgetPolicySha256: budgetPolicyArtifactSha256(input.policy),
			event: "CELL_ADMISSION",
			accruedLifecycleMicrousd: 1,
			prospectiveCellMicrousd: 1,
			teardownReserveMicrousd: 1,
			totalAuthorizedMicrousd: input.policy.spentBeforeMicrousd + 1,
			remainingBudgetMicrousd: 1,
			decision: "ADMIT",
		},
	);
	input.ledger.push(admission);
	writeFileSync(
		join(dir, "admission.json"),
		JSON.stringify({
			schema: "g6-c32-cell-admission/2",
			decision: "ADMIT",
			nextNodeId: nodeId,
			recordedAt: now,
			budgetPolicySha256: budgetPolicyArtifactSha256(input.policy),
			ledgerEntryArtifactSha256: spendLedgerEntryArtifactSha256(admission),
		}),
	);
	const operations = [
		"remote-mkdir",
		"apply-gro",
		"bpf-repin",
		...Object.keys(raw.bufferOperations),
		"scan",
		"copy",
		"evaluate",
		"restore-buffer",
		"restore-buffer-generator",
		...(raw.profile.serverUdpSendBufferBytes > 0
			? ["restore-server-sndbuf"]
			: []),
		"restore-gro",
		"seal",
	];
	const scanIndex = operations.indexOf("scan");
	for (const [index, name] of operations.entries()) {
		const buffer = raw.bufferOperations[name];
		const op =
			name === "scan"
				? raw.operation
				: buffer
					? buffer.receipt
					: operationFixture(
							`${nodeId}-${name}`,
							sequenceBase +
								(index < scanIndex ? index + 2 : 20 + index - scanIndex),
							at(index < scanIndex ? 1000 + index * 10 : 123000 + index * 10),
							at(index < scanIndex ? 1010 + index * 10 : 123010 + index * 10),
						);
		op.stdoutPath = `work/${nodeId}/${name}.stdout`;
		op.stderrPath = `work/${nodeId}/${name}.stderr`;
		writeFileSync(join(dir, `${name}.receipt.json`), JSON.stringify(op));
		writeFileSync(
			join(dir, `${name}.stdout`),
			name === "scan" ? raw.scanStdout : (buffer?.stdout ?? ""),
		);
		writeFileSync(
			join(dir, `${name}.stderr`),
			name === "scan" ? raw.scanStderr : (buffer?.stderr ?? ""),
		);
	}
	return {
		input,
		dir,
		raw,
		nodeId,
		gradeAt: at(124000),
		sealAt: at(125000),
		finishAt: at(130000),
		replayAt: at(131000),
	};
}

function finishPreparedCell(
	cell: ReturnType<typeof prepareCell>,
	stored = gradePendingWorkCell({
		...cell.input,
		nodeId: cell.nodeId,
		now: cell.gradeAt,
	}),
) {
	const { input, nodeId, dir } = cell;
	writeFileSync(join(dir, "work-grade.json"), JSON.stringify(stored));
	sealPendingWorkCell({ ...input, nodeId, now: cell.sealAt });
	// The active seal operation appends its own output after the raw seal.
	writeFileSync(join(dir, "seal.stdout"), "sealed\n");
	return finishWorkCell({
		...input,
		nodeId,
		now: cell.finishAt,
		monotonicNs: "130000000001",
	});
}

test("pending grading loads mandatory retained streams, owners and buffer evidence before advance", () => {
	for (const name of [
		"scan.stdout",
		"scan.stderr",
		"scan-owner.json",
		"generator-owner.json",
		"apply-buffer.receipt.json",
		"apply-buffer.stdout",
		"apply-buffer-generator.stderr",
	]) {
		const cell = prepareCell();
		renameSync(join(cell.dir, name), join(cell.input.root, `missing-${name}`));
		expect(() =>
			gradePendingWorkCell({
				...cell.input,
				nodeId: cell.nodeId,
				now: cell.gradeAt,
			}),
		).toThrow();
		expect(
			readWorkExecution({ ...cell.input, now: cell.gradeAt }).completed,
		).toEqual([]);
	}
});

test("pending raw grading does not require future evaluate, restore or seal operations", () => {
	const cell = prepareCell();
	for (const suffix of [
		"evaluate",
		"restore-buffer",
		"restore-buffer-generator",
		"restore-gro",
		"seal",
	])
		for (const ending of ["receipt.json", "stdout", "stderr"])
			renameSync(
				join(cell.dir, `${suffix}.${ending}`),
				join(cell.input.root, `future-${suffix}.${ending}`),
			);
	expect(
		gradePendingWorkCell({
			...cell.input,
			nodeId: cell.nodeId,
			now: cell.gradeAt,
		}).outcome,
	).toBe("PASS");
	expect(() =>
		finishWorkCell({
			...cell.input,
			nodeId: cell.nodeId,
			now: cell.finishAt,
			monotonicNs: "130000000001",
		}),
	).toThrow();
});

test("shared retained evidence loader rejects symlinks, non-files and oversized streams", () => {
	for (const defect of [
		"symlink",
		"parent-symlink",
		"directory",
		"oversized",
	] as const) {
		const cell = prepareCell(),
			profile = cell.raw.profile,
			authority = workAuthorityFixture(cell.input.policy);
		const load = () =>
			readWorkCellEvidence(cell.input.root, cell.raw.node, profile, authority);
		expect(load().scanStdout).toBe(cell.raw.scanStdout);
		if (defect === "parent-symlink") {
			const retained = join(cell.input.root, "retained-cell");
			renameSync(cell.dir, retained);
			symlinkSync(retained, cell.dir, "dir");
		} else if (defect === "oversized") {
			truncateSync(join(cell.dir, "scan.stdout"), 128 * 1024 * 1024 + 1);
		} else {
			const path = join(cell.dir, "scan.stdout"),
				retained = join(cell.input.root, "retained-stdout");
			renameSync(path, retained);
			if (defect === "symlink") symlinkSync(retained, path);
			else mkdirSync(path);
		}
		expect(() => {
			load();
		}).toThrow(/symlink|non-file|excessive/);
	}
});

test("shared loader uses actual send-buffer operation bytes only when the frozen profile requires them", () => {
	const cell = prepareCell(),
		authority = workAuthorityFixture(cell.input.policy),
		profile = { ...cell.raw.profile, serverUdpSendBufferBytes: 26214400 },
		load = () =>
			readWorkCellEvidence(cell.input.root, cell.raw.node, profile, authority);
	expect(
		readWorkCellEvidence(
			cell.input.root,
			cell.raw.node,
			cell.raw.profile,
			authority,
		).bufferOperations["apply-server-sndbuf"],
	).toBeUndefined();
	expect(load).toThrow(/apply-server-sndbuf/);
	const fixture = workGradeFixture({ node: cell.raw.node, profile }),
		operation = requireDefined(fixture.bufferOperations["apply-server-sndbuf"]);
	writeFileSync(
		join(cell.dir, "apply-server-sndbuf.receipt.json"),
		JSON.stringify(operation.receipt),
	);
	writeFileSync(join(cell.dir, "apply-server-sndbuf.stdout"), operation.stdout);
	writeFileSync(
		join(cell.dir, "apply-server-sndbuf.stderr"),
		"retained stderr, not a synthesized empty stream",
	);
	expect(load().bufferOperations["apply-server-sndbuf"]).toEqual({
		...operation,
		stderr: "retained stderr, not a synthesized empty stream",
	});
});

test("pending and finish derive strictly increasing scan sequence and unique start identity from the verified prefix", () => {
	for (const defect of ["sequence", "startedAt"] as const) {
		const first = prepareCell();
		finishPreparedCell(first);
		const cell = prepareCell(first.input, () => {}, first.replayAt);
		if (defect === "sequence") {
			cell.raw.operation.envelope.sequence =
				first.raw.operation.envelope.sequence;
			writeFileSync(
				join(cell.dir, "scan.receipt.json"),
				JSON.stringify(cell.raw.operation),
			);
		} else {
			Object.assign(cell.raw.scan, { startedAt: first.raw.scan.startedAt });
			writeFileSync(
				join(cell.dir, "g6-sharded-scan.json"),
				JSON.stringify(cell.raw.scan),
			);
		}
		for (const stage of ["grade", "finish"] as const)
			expect(() =>
				stage === "grade"
					? gradePendingWorkCell({
							...cell.input,
							nodeId: cell.nodeId,
							now: cell.gradeAt,
						})
					: finishWorkCell({
							...cell.input,
							nodeId: cell.nodeId,
							now: cell.finishAt,
							monotonicNs: "130000000001",
						}),
			).toThrow(/scan.*prefix/);
		expect(
			readWorkExecution({ ...cell.input, now: cell.gradeAt }).completed,
		).toEqual([{ nodeId: first.nodeId, outcome: "PASS" }]);
	}
});

test("re-sealed completion replay and CLI next reject scan identities reordered across the verified prefix", async () => {
	const first = prepareCell();
	finishPreparedCell(first);
	const cell = prepareCell(first.input, () => {}, first.replayAt);
	finishPreparedCell(cell);
	// Keep the second cell's own transaction ordering intact but move the entire
	// sequence range behind the first scan. Re-sealing must not authorize it.
	for (const name of readdirSync(cell.dir).filter((name) =>
		name.endsWith(".receipt.json"),
	)) {
		const path = join(cell.dir, name),
			receipt = JSON.parse(readFileSync(path, "utf8"));
		receipt.envelope.sequence -= 100;
		writeFileSync(path, JSON.stringify(receipt));
	}
	resealFixture(cell);
	expect(() =>
		readWorkExecution({ ...cell.input, now: cell.replayAt }),
	).toThrow(/scan.*prefix/);
	setSystemTime(new Date(cell.replayAt));
	await expect(runWorkCli(cliArguments(cell.input, "next"))).rejects.toThrow(
		/scan.*prefix/,
	);
});

function completeFirstCell(invalid = false) {
	const cell = prepareCell(executionFixture(), (raw) => {
		if (invalid)
			requireDefined(
				requireDefined(raw.scan.aggregate.lifetime).metrics,
			).udpSendBatchErrors = 1;
	});
	const { input, nodeId, dir } = cell;
	writeFileSync(
		join(dir, "work-grade.json"),
		JSON.stringify(
			gradePendingWorkCell({ ...input, nodeId, now: cell.gradeAt }),
		),
	);
	sealPendingWorkCell({ ...input, nodeId, now: cell.sealAt });
	writeFileSync(join(dir, "seal.stdout"), "sealed\n");
	expect(() =>
		finishWorkCell({
			...input,
			nodeId,
			now: cell.finishAt,
			monotonicNs: "130000000001",
			finishedClock: () => ({
				now: "2026-09-05T00:09:11.000Z",
				monotonicNs: "421000000001",
			}),
		}),
	).toThrow(/deadline/);
	finishWorkCell({
		...input,
		nodeId,
		now: cell.finishAt,
		monotonicNs: "130000000001",
	});
	return cell;
}

function cliArguments(
	input: ReturnType<typeof executionFixture>,
	mode: string,
	nodeId?: string,
): string[] {
	const policyPath = join(input.root, "policy.json"),
		ledgerPath = join(input.root, "ledger.json");
	writeFileSync(policyPath, JSON.stringify(input.policy));
	writeFileSync(ledgerPath, JSON.stringify(input.ledger));
	return [
		mode,
		"--root",
		input.root,
		"--policy",
		policyPath,
		"--ledger",
		ledgerPath,
		...(nodeId ? ["--node", nodeId] : []),
	];
}

function loseSession(raw: WorkGradeFixture) {
	const report = JSON.parse(
		requireDefined(raw.scan.clientStdout.split("mmo-client: json ")[1]),
	);
	report.windows.steady.sessionsLost = 1;
	raw.scan.clientStdout = `mmo-client: json ${JSON.stringify(report)}\n`;
}

// Adversarial re-sealing removes digest mismatch as an explanation: replay must
// still reject the unchanged stored PASS from the now-invalid/unclean raw data.
function resealFixture(cell: ReturnType<typeof prepareCell>) {
	const prefix = `work/${cell.nodeId}`;
	const files = () =>
		readdirSync(cell.dir)
			.filter((name) => name !== "completion.json")
			.sort()
			.map((name) => ({
				path: `${prefix}/${name}`,
				sha256: createHash("sha256")
					.update(readFileSync(join(cell.dir, name)))
					.digest("hex"),
			}));
	const sealPath = join(cell.dir, "cell-seal.json"),
		seal = JSON.parse(readFileSync(sealPath, "utf8"));
	seal.files = files().filter(
		(file) =>
			![
				"cell-seal.json",
				"seal.stdout",
				"seal.stderr",
				"seal.receipt.json",
			].some((name) => file.path === `${prefix}/${name}`),
	);
	writeFileSync(sealPath, JSON.stringify(seal));
	const completionPath = join(cell.dir, "completion.json"),
		completion = JSON.parse(readFileSync(completionPath, "utf8"));
	completion.files = files();
	writeFileSync(completionPath, JSON.stringify(completion));
}

test("CLI init requires a complete verified BIND and has no caller-supplied producer option", async () => {
	const input = executionFixture();
	renameSync(
		join(input.root, "work-execution.json"),
		join(input.root, "synthetic-state-backup.json"),
	);
	setSystemTime(new Date("2026-09-05T00:02:00.000Z"));
	const args = [
		...cliArguments(input, "init"),
		"--deadline",
		"2026-09-05T02:00:00.000Z",
		"--candidate",
		"a".repeat(40),
		"--registration",
		"b".repeat(64),
		"--setup-receipt",
		"qualification/setup.receipt.json",
	];
	await expect(
		runWorkCli([...args, "--probe-producer", "e".repeat(64)]),
	).rejects.toThrow(/unknown/);
	await expect(runWorkCli(args)).rejects.toThrow(/missing --bound-root/);
	await expect(
		runWorkCli([...args, "--bound-root", input.root]),
	).rejects.toThrow(/missing --repository/);
	await expect(
		runWorkCli([
			...args,
			"--bound-root",
			input.root,
			"--repository",
			input.root,
		]),
	).rejects.toThrow();
	expect(() => readFileSync(join(input.root, "work-execution.json"))).toThrow();
});

test("online CLI ladder MISS from a lost session or receive error takes the lower repeat, never a higher rung", async () => {
	for (const defect of ["session", "receive"] as const) {
		const input = executionFixture(true),
			first = prepareCell(input);
		finishPreparedCell(first);
		const cell = prepareCell(
			input,
			(raw) => {
				if (defect === "session") loseSession(raw);
				else raw.diagnostic.serverHostUdp.idle.InErrors += 1;
			},
			first.replayAt,
		);
		expect(cell.nodeId).toBe("L10000-1");
		setSystemTime(new Date(cell.gradeAt));
		const result = await runWorkCli(cliArguments(input, "grade", cell.nodeId));
		expect(result).toMatchObject({ outcome: "MISS" });
		// CLI writes immutable grade; the normal finish path must replay it.
		sealPendingWorkCell({ ...input, nodeId: cell.nodeId, now: cell.sealAt });
		finishWorkCell({
			...input,
			nodeId: cell.nodeId,
			now: cell.finishAt,
			monotonicNs: "130000000001",
		});
		setSystemTime(new Date(cell.replayAt));
		expect(await runWorkCli(cliArguments(input, "next"))).toMatchObject({
			node: { id: "L5000-2" },
			terminal: null,
		});
		const progress = readWorkExecution({ ...input, now: cell.replayAt });
		expect(progress.completed).toEqual([
			{ nodeId: "L5000-1", outcome: "PASS" },
			{ nodeId: "L10000-1", outcome: "MISS" },
		]);
	}
});

test("online invalid native coverage stops attribution, while an ACK-only MISS still continues", async () => {
	for (const invalid of [true, false]) {
		const cell = prepareCell(executionFixture(), (raw) => {
			if (invalid)
				requireDefined(
					raw.diagnostic.sendPathDiagnostics.shards[0],
				).boundaries.drain.monoNs = "1";
			else {
				const report = JSON.parse(
					requireDefined(raw.scan.clientStdout.split("mmo-client: json ")[1]),
				);
				const histogram = new LatencyHistogram();
				histogram.record(100_000_000);
				report.windows.steadyDrain.rtt = histogram.toJson();
				raw.scan.clientStdout = `mmo-client: json ${JSON.stringify(report)}\n`;
			}
		});
		expect(finishPreparedCell(cell).grade.outcome).toBe(
			invalid ? "INVALID" : "MISS",
		);
		setSystemTime(new Date(cell.replayAt));
		expect(await runWorkCli(cliArguments(cell.input, "next"))).toMatchObject(
			invalid
				? { node: null, argv: [], terminal: "INCOMPLETE" }
				: { node: { id: "A1-1" }, terminal: null },
		);
	}
});

test("online probe absence, hidden probe-off output, and a short detailed probe are INVALID terminal steps", () => {
	for (const defect of ["absent", "hidden", "short"] as const) {
		const cell = prepareCell(executionFixture(defect !== "hidden"), (raw) => {
			raw.probe =
				defect === "absent"
					? null
					: workProbeFixture(raw.operation.startedAt, 1, 50);
		});
		expect(finishPreparedCell(cell).grade.outcome).toBe("INVALID");
		expect(
			readWorkExecution({ ...cell.input, now: cell.replayAt }),
		).toMatchObject({ nextNode: null, terminal: "INCOMPLETE" });
	}
});

test("online scan operation must be this cell's un-retried receipt within the actual cell clock", () => {
	for (const defect of [
		"run",
		"node",
		"retry",
		"before",
		"future",
		"cutoff",
		"duration",
	] as const) {
		const cell = prepareCell(),
			op = structuredClone(cell.raw.operation);
		if (defect === "run") op.envelope.runId = "other-run";
		if (defect === "node") op.envelope.operationId = "A1-1-scan";
		if (defect === "retry") op.attempt = 2;
		if (defect === "duration") op.durationMonotonicNs = "421000000000";
		if (defect === "before") op.startedAt = "2026-09-05T00:02:09.000Z";
		if (defect === "future" || defect === "cutoff")
			op.finishedAt = op.envelope.recordedAt =
				defect === "future" ? cell.finishAt : "2026-09-05T00:09:11.000Z";
		writeFileSync(join(cell.dir, "scan.receipt.json"), JSON.stringify(op));
		expect(() =>
			gradePendingWorkCell({
				...cell.input,
				nodeId: cell.nodeId,
				now: defect === "cutoff" ? "2026-09-05T00:09:12.000Z" : cell.gradeAt,
			}),
		).toThrow(/raw scan operation/);
		expect(
			readWorkExecution({ ...cell.input, now: cell.gradeAt }).completed,
		).toEqual([]);
	}
});

test("CLI replay regrades re-sealed raw evidence, refusing stale PASS for unclean or invalid cells", async () => {
	for (const defect of ["unclean", "native", "probe", "producer"] as const) {
		const cell = prepareCell(executionFixture(true));
		finishPreparedCell(cell);
		if (defect === "unclean") {
			loseSession(cell.raw);
			writeFileSync(
				join(cell.dir, "g6-sharded-scan.json"),
				JSON.stringify(cell.raw.scan),
			);
		} else if (defect === "native") {
			requireDefined(
				cell.raw.diagnostic.sendPathDiagnostics.shards[0],
			).boundaries.drain.monoNs = "1";
			writeFileSync(
				join(cell.dir, "g6-sharded-diagnostic.json"),
				JSON.stringify(cell.raw.diagnostic),
			);
		} else if (defect === "probe") {
			writeFileSync(
				join(cell.dir, "linux-probe.jsonl"),
				workProbeFixture(cell.raw.operation.startedAt, 1, 50),
			);
		} else {
			const statePath = join(cell.input.root, "work-execution.json"),
				state = JSON.parse(readFileSync(statePath, "utf8"));
			state.probeProducerSha256 = "e".repeat(64);
			writeFileSync(statePath, JSON.stringify(state));
		}
		resealFixture(cell);
		setSystemTime(new Date(cell.replayAt));
		await expect(runWorkCli(cliArguments(cell.input, "next"))).rejects.toThrow(
			defect === "producer"
				? /execution authority mismatch/
				: /stored grade does not match raw evidence/,
		);
	}
});

test("completed prefix is regraded and digest-checked; admission, restore and seal cannot be skipped", () => {
	const { input, dir, raw, nodeId } = completeFirstCell();
	expect(
		readWorkExecution({ ...input, now: "2026-09-05T00:04:21.000Z" }),
	).toMatchObject({
		completed: [{ nodeId, outcome: "PASS" }],
		nextNode: { id: "A1-1" },
		controlUsedSeconds: 11,
	});
	raw.scan.aggregate.steady.rxTotal = 0;
	writeFileSync(join(dir, "g6-sharded-scan.json"), JSON.stringify(raw.scan));
	expect(() =>
		readWorkExecution({ ...input, now: "2026-09-05T00:04:21.000Z" }),
	).toThrow(/artifact/);
});

test("final evidence replays at its recorded time before and after a later ledger seal", () => {
	const { input } = completeFirstCell(true),
		recordedAt = "2026-09-05T00:04:21.000Z";
	const result = createWorkFinal({ ...input, now: recordedAt });
	expect(result).toMatchObject({
		recordedAt,
		terminal: "INCOMPLETE",
		completed: [{ nodeId: "A0-1", outcome: "INVALID" }],
		elapsedPaidSeconds: 261,
		controlUsedSeconds: 11,
	});
	writeWorkJson(input.root, "closeout/work-final.json", result);
	expect(
		verifyWorkFinal({ ...input, now: "2026-10-05T00:00:00.000Z" }),
	).toEqual(result);
	for (const [offset, event] of [
		"DESTROY_INTENT",
		"DESTROY_CONFIRMED",
		"EMERGENCY_RECONCILIATION",
	].entries()) {
		const previous = requireDefined(input.ledger.at(-1));
		input.ledger.push(
			appendSpendLedgerEntry(previous, {
				...previous,
				event: event as
					| "DESTROY_INTENT"
					| "DESTROY_CONFIRMED"
					| "EMERGENCY_RECONCILIATION",
				recordedAt: `2026-09-05T00:05:0${offset}.000Z`,
				rigJournalEventArtifactSha256: "d".repeat(64),
				decision: null,
			}),
		);
	}
	expect(
		verifyWorkFinal({ ...input, now: "2026-09-05T00:06:00.000Z" }),
	).toEqual(result);
	const previous = requireDefined(input.ledger.at(-1));
	input.ledger.push(
		appendSpendLedgerEntry(previous, {
			...previous,
			recordedAt: "2026-09-05T00:10:00.000Z",
			event: "SEAL",
			decision: null,
		}),
	);
	expect(
		verifyWorkFinal({ ...input, now: "2027-09-05T00:00:00.000Z" }),
	).toEqual(result);
	input.ledger[input.ledger.length - 1] = {
		...requireDefined(input.ledger.at(-1)),
		previousEntryArtifactSha256: "0".repeat(64),
	};
	expect(() => verifyWorkFinal(input)).toThrow(/predecessor/);
});

test("post-final ledger cannot hide resumed paid creation or admission work", () => {
	const { input } = completeFirstCell(true);
	writeWorkJson(
		input.root,
		"closeout/work-final.json",
		createWorkFinal({ ...input, now: "2026-09-05T00:04:21.000Z" }),
	);
	for (const event of [
		"CREATE_INTENT",
		"CREATE_OBSERVED",
		"CELL_ADMISSION",
		"PRICE_VERIFIED",
	] as const) {
		const previous = requireDefined(input.ledger.at(-1));
		const later = appendSpendLedgerEntry(previous, {
			...previous,
			event,
			recordedAt: "2026-09-05T00:05:00.000Z",
			rigJournalEventArtifactSha256: event.startsWith("CREATE")
				? "d".repeat(64)
				: null,
			decision: event === "CELL_ADMISSION" ? "ADMIT" : null,
		});
		expect(() =>
			verifyWorkFinal({
				...input,
				ledger: [...input.ledger, later],
				now: "2026-09-05T00:06:00.000Z",
			}),
		).toThrow(/post-final work/);
	}
});

test("final evidence rejects invented result, extra fields, future or pre-completion time", () => {
	const { input } = completeFirstCell(true),
		recordedAt = "2026-09-05T00:04:21.000Z";
	const result = createWorkFinal({ ...input, now: recordedAt });
	writeWorkJson(input.root, "closeout/work-final.json", result);
	for (const change of [
		{ terminal: "ATTRIBUTION_COMPLETE" },
		{ completed: [] },
		{ elapsedPaidSeconds: 1 },
		{ controlUsedSeconds: 0 },
		{ lifecycle: "ladder-only" },
		{ policySha256: "d".repeat(64) },
		{ extra: true },
		{ recordedAt: "2026-09-05T00:04:19.000Z" },
		{ recordedAt: "2026-09-05T00:04:22.000Z" },
	]) {
		writeFileSync(
			join(input.root, "closeout/work-final.json"),
			JSON.stringify({ ...result, ...change }),
		);
		expect(() => verifyWorkFinal({ ...input, now: recordedAt })).toThrow();
	}
	expect(() =>
		createWorkFinal({ ...executionFixture(), now: "2026-09-05T00:02:10.000Z" }),
	).toThrow(/nonterminal/);
});
