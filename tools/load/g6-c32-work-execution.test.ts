import { afterEach, expect, setSystemTime, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
	evaluateWorkAdmission,
	spendLedgerEntryArtifactSha256,
} from "./g6-c32-budget.ts";
import { runBudgetCli } from "./g6-c32-budget-cli.ts";
import { createCellAdmission } from "./g6-c32-cell-admission.ts";
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

test("actual budget CLI admissions finish and replay two cells including ACK-only MISS", async () => {
	const input = executionFixture();
	let now = "2026-09-05T00:02:10.000Z";
	for (let index = 0; index < 2; index++) {
		const cell = prepareCell(
			input,
			(raw) => {
				if (index === 0) {
					const report = JSON.parse(
						requireDefined(raw.scan.clientStdout.split("mmo-client: json ")[1]),
					);
					const histogram = new LatencyHistogram();
					histogram.record(100_000_000);
					report.windows.steadyDrain.rtt = histogram.toJson();
					raw.scan.clientStdout = `mmo-client: json ${JSON.stringify(report)}\n`;
				}
			},
			now,
		);
		input.ledger.pop();
		const policyPath = join(input.root, "cli-policy.json"),
			ledgerPath = join(input.root, "cli-ledger.json"),
			requestPath = join(input.root, "cli-request.json");
		writeFileSync(policyPath, JSON.stringify(input.policy));
		writeFileSync(ledgerPath, JSON.stringify(input.ledger));
		writeFileSync(
			requestPath,
			JSON.stringify({
				schema: "g6-c32-work-admission-request/1",
				evidenceRoot: input.root,
				nodeId: cell.nodeId,
			}),
		);
		expect(
			await runBudgetCli(
				[
					"admit-cell",
					"--policy",
					policyPath,
					"--ledger",
					ledgerPath,
					"--request",
					requestPath,
					"--out",
					join(cell.dir, "admission.json"),
				],
				() => now,
			),
		).toBe(0);
		input.ledger.splice(
			0,
			input.ledger.length,
			...JSON.parse(readFileSync(ledgerPath, "utf8")),
		);
		const receipt = JSON.parse(
			readFileSync(join(cell.dir, "admission.json"), "utf8"),
		);
		expect(Object.keys(receipt)).toHaveLength(19);
		if (index === 1) {
			const entry = requireDefined(input.ledger.at(-1));
			expect(entry.totalAuthorizedMicrousd).toBe(
				requireDefined(input.ledger.at(-2)).totalAuthorizedMicrousd,
			);
			expect(entry.totalAuthorizedMicrousd).toBeGreaterThan(
				receipt.spentBeforeMicrousd +
					receipt.accruedLifecycleMicrousd +
					receipt.prospectiveCellMicrousd,
			);
		}
		const completion = finishPreparedCell(cell);
		if (index === 0) expect(completion.grade.outcome).toBe("MISS");
		expect(
			readWorkExecution({ ...input, now: cell.replayAt }).completed,
		).toHaveLength(index + 1);
		now = cell.replayAt;
	}
}, 15000);

test("actual CLI admission does not allow continuation after an INVALID cell", async () => {
	const cell = prepareCell(executionFixture(), (raw) => {
		requireDefined(
			raw.diagnostic.sendPathDiagnostics.shards[0],
		).boundaries.drain.monoNs = "1";
	});
	const { input } = cell;
	input.ledger.pop();
	const policyPath = join(input.root, "cli-policy.json"),
		ledgerPath = join(input.root, "cli-ledger.json"),
		requestPath = join(input.root, "cli-request.json");
	writeFileSync(policyPath, JSON.stringify(input.policy));
	writeFileSync(ledgerPath, JSON.stringify(input.ledger));
	writeFileSync(
		requestPath,
		JSON.stringify({
			schema: "g6-c32-work-admission-request/1",
			evidenceRoot: input.root,
			nodeId: cell.nodeId,
		}),
	);
	const args = [
		"admit-cell",
		"--policy",
		policyPath,
		"--ledger",
		ledgerPath,
		"--request",
		requestPath,
		"--out",
		join(cell.dir, "admission.json"),
	];
	expect(await runBudgetCli(args, () => "2026-09-05T00:02:10.000Z")).toBe(0);
	input.ledger.splice(
		0,
		input.ledger.length,
		...JSON.parse(readFileSync(ledgerPath, "utf8")),
	);
	expect(finishPreparedCell(cell).grade.outcome).toBe("INVALID");
	expect(readWorkExecution({ ...input, now: cell.replayAt }).terminal).toBe(
		"INCOMPLETE",
	);
	const before = readFileSync(ledgerPath);
	await expect(runBudgetCli(args, () => cell.replayAt)).rejects.toThrow(
		/next started/,
	);
	expect(readFileSync(ledgerPath)).toEqual(before);
}, 15000);

test("resealed admission drift is rejected against the prior-prefix calculation", () => {
	const cell = prepareCell();
	finishPreparedCell(cell);
	const path = join(cell.dir, "admission.json");
	const valid = JSON.parse(readFileSync(path, "utf8"));
	const mutations = [
		{ campaignId: "other-campaign" },
		{ runId: "other-run" },
		{ nextNodeId: "A1-1" },
		{ budgetPolicySha256: "f".repeat(64) },
		{ ledgerEntryArtifactSha256: "f".repeat(64) },
		{ decision: "REFUSED_BUDGET" },
		{ decision: "TEARDOWN", nextNodeId: null, terminal: "COMPLETE" },
		{ stage: "ladder" },
		{ recordedAt: "2026-09-05T00:02:10.001Z" },
		{ extra: 1 },
		...Object.keys(valid)
			.filter((key) => key.endsWith("Microusd") || key.endsWith("Seconds"))
			.map((key) => ({ [key]: valid[key] + 1 })),
	];
	for (const patch of mutations) {
		writeFileSync(path, JSON.stringify({ ...valid, ...patch }));
		resealFixture(cell);
		expect(() =>
			readWorkExecution({ ...cell.input, now: cell.replayAt }),
		).toThrow(/admission/);
	}
	writeFileSync(
		path,
		JSON.stringify(
			Object.fromEntries(
				[
					"schema",
					"decision",
					"nextNodeId",
					"budgetPolicySha256",
					"recordedAt",
					"ledgerEntryArtifactSha256",
				].map((key) => [key, valid[key]]),
			),
		),
	);
	resealFixture(cell);
	expect(() =>
		readWorkExecution({ ...cell.input, now: cell.replayAt }),
	).toThrow(/admission/);
}, 15000);

test("admission replay validates max accrued envelope and rejects resealed ledger drift", () => {
	const input = executionFixture();
	const previous = requireDefined(input.ledger.at(-1));
	input.ledger.push(
		appendSpendLedgerEntry(previous, {
			...previous,
			event: "ABORT",
			accruedLifecycleMicrousd: 1000000,
			totalAuthorizedMicrousd: input.policy.spentBeforeMicrousd + 10000000,
			recordedAt: "2026-09-05T00:02:00.000Z",
		}),
	);
	const cell = prepareCell(input);
	finishPreparedCell(cell);
	const path = join(cell.dir, "admission.json"),
		receipt = JSON.parse(readFileSync(path, "utf8"));
	expect(
		requireDefined(input.ledger.at(-1)).accruedLifecycleMicrousd,
	).toBeGreaterThan(receipt.accruedLifecycleMicrousd);
	expect(
		readWorkExecution({ ...input, now: cell.replayAt }).completed,
	).toHaveLength(1);
	const current = requireDefined(input.ledger.pop());
	const changed = appendSpendLedgerEntry(requireDefined(input.ledger.at(-1)), {
		...current,
		prospectiveCellMicrousd: current.prospectiveCellMicrousd + 1,
		remainingBudgetMicrousd: current.remainingBudgetMicrousd - 1,
	});
	input.ledger.push(changed);
	receipt.prospectiveCellMicrousd++;
	receipt.totalAfterMicrousd++;
	receipt.remainingAfterMicrousd--;
	receipt.ledgerEntryArtifactSha256 = spendLedgerEntryArtifactSha256(changed);
	writeFileSync(path, JSON.stringify(receipt));
	resealFixture(cell);
	expect(() => readWorkExecution({ ...input, now: cell.replayAt })).toThrow(
		/admission/,
	);
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

test("new work records persist clock identity and exact start and finish samples", () => {
	const cell = prepareCell();
	const completion = finishPreparedCell(cell);
	const start = JSON.parse(readFileSync(join(cell.dir, "start.json"), "utf8"));
	expect(start.schema).toBe("g6-c32-work-cell-start/2");
	expect(start.clockDomain).toEqual(cell.input.clockDomain);
	expect(completion).toMatchObject({
		schema: "g6-c32-work-cell-completion/2",
		clockDomain: cell.input.clockDomain,
		startedMonotonicNs: "1",
		finishedMonotonicNs: "130000000001",
		durationMonotonicNs: "130000000000",
	});
});

test("finish refuses a different clock domain without publishing completion", () => {
	const cell = prepareCell();
	cell.input.clockDomain.bootId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
	expect(() => finishPreparedCell(cell)).toThrow(/domain/);
	expect(() => readFileSync(join(cell.dir, "completion.json"))).toThrow();
});

test("a reboot between cells refuses continuation even when the next cell has not started", () => {
	const cell = prepareCell();
	finishPreparedCell(cell);
	const next = readWorkExecution({
		...cell.input,
		now: cell.replayAt,
	}).nextNode;
	expect(() =>
		startWorkCell({
			...cell.input,
			nodeId: requireDefined(next).id,
			now: cell.replayAt,
			monotonicNs: "1",
			clockDomain: {
				...cell.input.clockDomain,
				bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			},
		}),
	).toThrow(/domain/);
});

test("live next start refuses a regressed prefix sample without publishing start", () => {
	const first = prepareCell();
	finishPreparedCell(first);
	const nodeId = requireDefined(
		readWorkExecution({ ...first.input, now: first.replayAt }).nextNode,
	).id;
	expect(() =>
		startWorkCell({
			...first.input,
			nodeId,
			now: first.replayAt,
			monotonicNs: "130000000000",
		}),
	).toThrow(/regress/);
	expect(() =>
		readFileSync(join(first.input.root, "work", nodeId, "start.json")),
	).toThrow();
});

test("pending replay refuses a regressed prefix sample", () => {
	const first = prepareCell();
	finishPreparedCell(first);
	const second = prepareCell(first.input, () => {}, first.replayAt);
	const path = join(second.dir, "start.json");
	const start = JSON.parse(readFileSync(path, "utf8"));
	start.startedMonotonicNs = "130000000000";
	writeFileSync(path, JSON.stringify(start));
	expect(() =>
		readWorkExecution({ ...second.input, now: second.replayAt }),
	).toThrow(/regress/);
});

test("completed replay refuses a regressed prefix with valid individual durations", () => {
	const first = prepareCell();
	finishPreparedCell(first);
	const second = prepareCell(first.input, () => {}, first.replayAt);
	finishPreparedCell(second);
	expect(
		readWorkExecution({ ...second.input, now: second.replayAt }).completed,
	).toHaveLength(2);
	for (const name of ["start.json", "completion.json"]) {
		const path = join(second.dir, name);
		const record = JSON.parse(readFileSync(path, "utf8"));
		record.startedMonotonicNs = "130000000000";
		if (name === "completion.json") record.finishedMonotonicNs = "260000000000";
		writeFileSync(path, JSON.stringify(record));
	}
	resealFixture(second);
	expect(() =>
		readWorkExecution({ ...second.input, now: second.replayAt }),
	).toThrow(/regress/);
});

test("legacy pending records cannot become new live completion", () => {
	const cell = prepareCell();
	const path = join(cell.dir, "start.json"),
		start = JSON.parse(readFileSync(path, "utf8"));
	start.schema = "g6-c32-work-cell-start/1";
	delete start.clockDomain;
	writeFileSync(path, JSON.stringify(start));
	expect(() => finishPreparedCell(cell)).toThrow();
	expect(() => readFileSync(join(cell.dir, "completion.json"))).toThrow();
});

test("replay refuses a rewritten pending clock domain before grading", () => {
	const cell = prepareCell();
	finishPreparedCell(cell);
	const nodeId = requireDefined(
		readWorkExecution({ ...cell.input, now: cell.replayAt }).nextNode,
	).id;
	startWorkCell({
		...cell.input,
		nodeId,
		now: cell.replayAt,
		monotonicNs: "130000000002",
	});
	const path = join(cell.input.root, "work", nodeId, "start.json");
	const start = JSON.parse(readFileSync(path, "utf8"));
	start.clockDomain.bootId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
	writeFileSync(path, JSON.stringify(start));
	expect(() =>
		readWorkExecution({ ...cell.input, now: cell.replayAt }),
	).toThrow(/domain/);
});

test("different-age processes start and finish the same identity-bound cell", async () => {
	const invoke = (method: string, args: unknown, age: number) => {
		const code = `import {${method}} from ${JSON.stringify(`${import.meta.dir}/g6-c32-work-execution.ts`)}; import {readSystemClock} from ${JSON.stringify(`${import.meta.dir}/g6-c32-system-clock.ts`)}; await Bun.sleep(${age}); const snapshot=readSystemClock(); console.log(JSON.stringify(${method}({...${JSON.stringify(args)},monotonicNs:snapshot.nanoseconds,clockDomain:snapshot.domain})));`;
		const result = spawnSync(process.execPath, ["-e", code], {
			encoding: "utf8",
			timeout: 5000,
		});
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		return JSON.parse(result.stdout);
	};
	const cell = prepareCell(undefined, undefined, undefined, (args) =>
		invoke("startWorkCell", args, 400),
	);
	await Bun.sleep(350);
	const completion = finishPreparedCell(cell, undefined, (args) =>
		invoke("finishWorkCell", args, 0),
	);
	expect(BigInt(completion.durationMonotonicNs)).toBeGreaterThanOrEqual(
		350_000_000n,
	);
	expect(BigInt(completion.durationMonotonicNs)).toBeLessThan(5_000_000_000n);
	expect(
		readWorkExecution({ ...cell.input, now: cell.replayAt }).completed,
	).toHaveLength(1);
}, 15000);

test("replay derives elapsed time rather than trusting stored duration", () => {
	const cell = prepareCell();
	const completion = finishPreparedCell(cell);
	writeFileSync(
		join(cell.dir, "completion.json"),
		JSON.stringify({ ...completion, durationMonotonicNs: "0" }),
	);
	expect(() =>
		readWorkExecution({ ...cell.input, now: cell.replayAt }),
	).toThrow(/duration mismatch/);
});

test("finish guard diagnostics retain bounded actual clock observations without publication", () => {
	for (const variant of [
		"elapsed",
		"final-elapsed",
		"regression",
		"domain",
		"wall",
		"final-wall",
		"final-domain",
		"final-regression",
	] as const) {
		const cell = prepareCell();
		let message = "";
		try {
			finishPreparedCell(cell, undefined, (args) => {
				const observed = {
					...args,
					now: variant.includes("wall") ? "2026-09-05T00:09:11.000Z" : args.now,
					monotonicNs: variant.includes("regression") ? "0" : "421000000001",
					clockDomain: variant.includes("domain")
						? { ...args.clockDomain, hostId: "darwin:other" }
						: args.clockDomain,
				};
				return variant.startsWith("final-")
					? finishWorkCell({ ...args, finishedClock: () => observed })
					: finishWorkCell(observed);
			});
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain('"start"');
		expect(message).toContain('"initial"');
		expect(message).toContain('"cutoffAt"');
		expect(message).toContain('"maximumSeconds"');
		expect(message).toContain(
			variant.includes("regression") ? '"monotonicNs":"0"' : "421000000001",
		);
		if (variant.includes("domain")) expect(message).toContain("darwin:other");
		if (variant.startsWith("final-")) expect(message).toContain('"final"');
		expect(message.length).toBeLessThan(3000);
		expect(() => readFileSync(join(cell.dir, "completion.json"))).toThrow();
	}
});

test("independent wall, elapsed, regression and final-verification guards refuse publication", () => {
	for (const variant of [
		"reversed",
		"elapsed",
		"wall",
		"final-regression",
		"final-domain",
		"final-failure",
	] as const) {
		const cell = prepareCell();
		expect(() =>
			finishPreparedCell(cell, undefined, (args) => {
				if (variant === "reversed")
					return finishWorkCell({ ...args, monotonicNs: "0" });
				if (variant === "elapsed")
					return finishWorkCell({ ...args, monotonicNs: "421000000001" });
				if (variant === "wall")
					return finishWorkCell({ ...args, now: "2026-09-05T00:09:11.000Z" });
				return finishWorkCell({
					...args,
					finishedClock: () => {
						if (variant === "final-failure")
							throw Error("fixture clock unavailable");
						return {
							now: args.now,
							monotonicNs:
								variant === "final-regression" ? "2" : args.monotonicNs,
							clockDomain:
								variant === "final-domain"
									? { ...args.clockDomain, hostId: "darwin:other" }
									: args.clockDomain,
						};
					},
				});
			}),
		).toThrow();
		expect(() => readFileSync(join(cell.dir, "completion.json"))).toThrow();
	}
});

function prepareCell(
	input = executionFixture(),
	mutate: (raw: WorkGradeFixture) => void = () => {},
	now = "2026-09-05T00:02:10.000Z",
	starter: typeof startWorkCell = startWorkCell,
) {
	const progress = readWorkExecution({ ...input, now }),
		node = requireDefined(progress.nextNode),
		nodeId = node.id;
	const startedMonotonicNs =
		progress.completions.at(-1)?.finishedMonotonicNs ?? "1";
	starter({ ...input, nodeId, now, monotonicNs: startedMonotonicNs });
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
	const { entry: admission, receipt } = createCellAdmission({
		policy: input.policy,
		previous: requireDefined(input.ledger.at(-1)),
		recordedAt: now,
		result: evaluateWorkAdmission({
			policy: input.policy,
			stage: node.kind,
			completed: progress.completed,
			setupComplete: true,
			elapsedPaidSeconds: progress.elapsedPaidSeconds,
			controlUsedSeconds: progress.controlUsedSeconds,
			remainingDeadlineSeconds: progress.remainingDeadlineSeconds,
		}),
	});
	input.ledger.push(admission);
	writeFileSync(join(dir, "admission.json"), JSON.stringify(receipt));
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
		startedMonotonicNs,
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
	finisher: typeof finishWorkCell = finishWorkCell,
) {
	const { input, nodeId, dir } = cell;
	writeFileSync(join(dir, "work-grade.json"), JSON.stringify(stored));
	sealPendingWorkCell({ ...input, nodeId, now: cell.sealAt });
	// The active seal operation appends its own output after the raw seal.
	writeFileSync(join(dir, "seal.stdout"), "sealed\n");
	return finisher({
		...input,
		nodeId,
		now: cell.finishAt,
		monotonicNs: String(BigInt(cell.startedMonotonicNs) + 130000000000n),
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
				clockDomain: input.clockDomain,
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
