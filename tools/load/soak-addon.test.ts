import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	aggregateSegments,
	computeSegmentObservedOperationCounts,
	evaluateTrendAndRecovery,
	type Sample,
} from "./soak-addon.ts";

const ROOT = join(import.meta.dir, "..", "..");
const HARNESS = join(import.meta.dir, "soak-addon.ts");
const WORKFLOW = join(ROOT, ".github", "workflows", "soak-long.yml");
const tempRoots: string[] = [];

type SegmentArtifact = Parameters<typeof aggregateSegments>[0][number];

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { force: true, recursive: true });
	}
});

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, nested]) => [key, canonicalize(nested)]),
		);
	}
	return value;
}

function sha256Hex(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex");
}

function seal(segment: SegmentArtifact): SegmentArtifact {
	segment.segmentHash = sha256Hex({ ...segment, segmentHash: undefined });
	return segment;
}

function segment(
	index: number,
	overrides: Partial<SegmentArtifact> = {},
): SegmentArtifact {
	const startedAtMs = index === 1 ? 1_000 : 2_500;
	return seal({
		version: 1,
		status: "pass",
		mode: "segment",
		repoRoot: "/stable/logical/repo",
		segmentIndex: index,
		segmentCount: 2,
		candidateCommit: "a".repeat(40),
		actualCommit: "a".repeat(40),
		candidateRef: "refs/tags/v1.0.0",
		seed: "campaign-seed",
		continuityTokenDigest: "b".repeat(64),
		previousFinalHash: index === 1 ? null : "state-1",
		startedAtMs,
		endedAtMs: startedAtMs + 1_000,
		durationSeconds: 21_600,
		runnerType: "github-hosted",
		runnerMode: "dedicated",
		runnerProfile: "large",
		toolchain: {
			bun: "1.3.9",
			rustc: "rustc 1.95.0",
			cc: { path: "/usr/bin/clang", version: "clang version 18.1.8" },
			cxx: { path: "/usr/bin/clang++", version: "clang version 18.1.8" },
		},
		rates: { sessions: 100, datagramsPerSec: 100, streamsPerSec: 5 },
		requiredOperationClasses: [
			"datagram-echo",
			"uni-echo",
			"bidi-echo",
			"stream-reset",
			"stop-sending",
			"idle-peers",
			"overload",
			"reconnect-churn",
			"cert-rotation",
		],
		observedOperationCounts: {
			"datagram-echo": 3,
			"uni-echo": 3,
			"bidi-echo": 3,
			"stream-reset": 2,
			"stop-sending": 2,
			"idle-peers": 1,
			overload: 1,
			"reconnect-churn": 1,
			"cert-rotation": 1,
		},
		thresholds: {
			maxSessionErrors: 10,
			maxDatagramErrors: 100,
			maxStreamErrors: 100,
			rssTrendMaxRel: 0.2,
			rssTrendMinAbsMb: 32,
			rssCeilMb: 1024,
			maxGapMs: 300_000,
		},
		phasePlan: [],
		baselineMetrics: {
			rssMb: 100,
			heapUsedMb: 24,
			fd: 20,
			sockets: 3,
			sessionsActive: 0,
			streamsActive: 0,
			sessionTasksActive: 0,
			streamTasksActive: 0,
			queuedBytesGlobal: 0,
		},
		mainLoad: {
			name: "main",
			startedAtMs: 0,
			endedAtMs: 1,
			durationMs: 1,
			timedOut: false,
			exitCode: 0,
			stdout: "load-client: PASS",
			stderr: "",
			sessionsOk: 10,
			sessionsErr: 0,
			datagramsSent: 10,
			datagramsErr: 0,
			streamsOpened: 10,
			streamsErr: 0,
			passLineSeen: true,
			requiredOperationClasses: [
				"datagram-echo",
				"uni-echo",
				"bidi-echo",
				"stream-reset",
				"stop-sending",
			],
			observedOperationCounts: {
				"datagram-echo": 3,
				"uni-echo": 3,
				"bidi-echo": 3,
				"stream-reset": 2,
				"stop-sending": 2,
			},
			observedReconnects: 0,
		},
		phaseRecords: [],
		trend: { pass: true, failures: [], phaseMedians: {}, steadyState: null },
		finalMetrics: {
			rssMb: 100,
			heapUsedMb: 24,
			fd: 20,
			sockets: 3,
			sessionsActive: 0,
			streamsActive: 0,
			peakSessions: 50,
			peakStreams: 75,
			sessionTasksActive: 0,
			streamTasksActive: 0,
			queuedBytesGlobal: 0,
		},
		samples: [],
		initialStateHash: `initial-${index}`,
		finalStateHash: `state-${index}`,
		segmentHash: "",
		...overrides,
	} as SegmentArtifact);
}

function writeCampaign(root: string): string {
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, "arbitrary-first.json"),
		JSON.stringify(segment(1)),
		"utf8",
	);
	writeFileSync(
		join(root, "arbitrary-second.json"),
		JSON.stringify(segment(2)),
		"utf8",
	);
	return root;
}

function runAggregate(input: string, output: string) {
	return spawnSync(process.execPath, [HARNESS, "aggregate", input], {
		cwd: ROOT,
		encoding: "utf8",
		env: { ...process.env, SOAK_AGGREGATE_OUT: output },
	});
}

describe("soak campaign integrity", () => {
	test("runLoadClient parses structured operation evidence", async () => {
		const summaryJson = JSON.stringify({
			requiredOperationClasses: [
				"datagram-echo",
				"uni-echo",
				"bidi-echo",
				"stream-reset",
				"stop-sending",
			],
			observedOperationCounts: {
				"datagram-echo": 3,
				"uni-echo": 2,
				"bidi-echo": 2,
				"stream-reset": 1,
				"stop-sending": 1,
			},
		});
		const script = [
			`console.log(${JSON.stringify(`load-client: summary ${summaryJson}`)});`,
			'console.log("load-client: sessions ok=2 err=0");',
			'console.log("load-client: datagrams sent=4 err=0");',
			'console.log("load-client: streams opened=4 err=0");',
			'console.log("load-client: PASS");',
		].join("\n");

		const result = await import("./soak-addon.ts").then(({ runLoadClient }) =>
			runLoadClient(
				"structured-summary",
				[process.execPath, "-e", script],
				1_000,
			),
		);
		const structured = result as {
			requiredOperationClasses: string[];
			observedOperationCounts: Record<string, number>;
		};

		expect(structured.requiredOperationClasses).toEqual([
			"datagram-echo",
			"uni-echo",
			"bidi-echo",
			"stream-reset",
			"stop-sending",
		]);
		expect(structured.observedOperationCounts).toEqual({
			"datagram-echo": 3,
			"uni-echo": 2,
			"bidi-echo": 2,
			"stream-reset": 1,
			"stop-sending": 1,
		});
	});

	test("runLoadClient parses structured reconnect evidence", async () => {
		const summaryJson = JSON.stringify({
			requiredOperationClasses: [
				"datagram-echo",
				"uni-echo",
				"bidi-echo",
				"stream-reset",
				"stop-sending",
			],
			observedOperationCounts: {
				"datagram-echo": 3,
				"uni-echo": 2,
				"bidi-echo": 2,
				"stream-reset": 1,
				"stop-sending": 1,
			},
			observedReconnects: 4,
		});
		const script = [
			`console.log(${JSON.stringify(`load-client: summary ${summaryJson}`)});`,
			'console.log("load-client: sessions ok=2 err=0");',
			'console.log("load-client: datagrams sent=4 err=0");',
			'console.log("load-client: streams opened=4 err=0");',
			'console.log("load-client: PASS");',
		].join("\n");

		const result = await import("./soak-addon.ts").then(({ runLoadClient }) =>
			runLoadClient(
				"structured-reconnect-summary",
				[process.execPath, "-e", script],
				1_000,
			),
		);
		const structured = result as {
			observedReconnects: number;
		};

		expect(structured.observedReconnects).toBe(4);
	});

	test("computeSegmentObservedOperationCounts uses actual reconnect counts", () => {
		const mainLoad = segment(1).mainLoad;
		const reconnectPhase = {
			name: "reconnect-churn",
			startedAtMs: 0,
			endedAtMs: 1,
			pass: true,
			notes: [],
			load: {
				...mainLoad,
				observedReconnects: 0,
			},
		};
		const rotationPhase = {
			name: "cert-rotation",
			startedAtMs: 1,
			endedAtMs: 2,
			pass: true,
			notes: [],
			rotationFingerprint: "fingerprint",
		};

		expect(
			computeSegmentObservedOperationCounts(mainLoad, [
				reconnectPhase,
				rotationPhase,
			]),
		).toMatchObject({
			"reconnect-churn": 0,
			"cert-rotation": 1,
		});
		expect(
			computeSegmentObservedOperationCounts(mainLoad, [
				{
					...reconnectPhase,
					load: {
						...mainLoad,
						observedReconnects: 3,
					},
				},
				rotationPhase,
			]),
		).toMatchObject({
			"reconnect-churn": 3,
			"cert-rotation": 1,
		});
	});

	test("aggregateSegments accepts a contiguous hash chain", () => {
		const aggregate = aggregateSegments([segment(2), segment(1)]);
		expect(aggregate.status).toBe("pass");
		expect(aggregate.segmentCount).toBe(2);
		expect(aggregate.segments.map((item) => item.file)).toEqual([
			"soak-segment-01-of-02.json",
			"soak-segment-02-of-02.json",
		]);
	});

	test("aggregateSegments rejects commit drift, time gaps, and compiler drift", () => {
		const unexpectedPredecessor = segment(1, {
			previousFinalHash: "unexpected-predecessor",
		});
		expect(() =>
			aggregateSegments([unexpectedPredecessor, segment(2)]),
		).toThrow("segment 1 cannot have a predecessor");

		const commitDrift = segment(2, {
			candidateCommit: "c".repeat(40),
			actualCommit: "c".repeat(40),
		});
		expect(() => aggregateSegments([segment(1), commitDrift])).toThrow(
			"commit drifted",
		);

		const timeGap = segment(2, { startedAtMs: 400_001, endedAtMs: 401_001 });
		expect(() => aggregateSegments([segment(1), timeGap])).toThrow("gap");

		const compilerDrift = segment(2, {
			toolchain: {
				...segment(2).toolchain,
				cc: { path: "/usr/bin/gcc", version: "gcc 14.2.0" },
			},
		});
		expect(() => aggregateSegments([segment(1), compilerDrift])).toThrow(
			"toolchain drifted",
		);
	});

	test("aggregateSegments rejects missing required operation evidence and cleanup drift", () => {
		const base = segment(1);
		const missingEvidence = seal({
			...base,
			requiredOperationClasses: [
				"datagram-echo",
				"uni-echo",
				"bidi-echo",
				"stream-reset",
				"stop-sending",
				"idle-peers",
				"overload",
				"reconnect-churn",
				"cert-rotation",
			],
			observedOperationCounts: {
				"datagram-echo": 2,
				"uni-echo": 2,
				"bidi-echo": 0,
				"stream-reset": 1,
				"stop-sending": 1,
				"idle-peers": 1,
				overload: 1,
				"reconnect-churn": 1,
				"cert-rotation": 1,
			},
			baselineMetrics: {
				rssMb: 100,
				heapUsedMb: 24,
				fd: 20,
				sockets: 3,
				sessionsActive: 0,
				streamsActive: 0,
				sessionTasksActive: 0,
				streamTasksActive: 0,
				queuedBytesGlobal: 0,
			},
			finalMetrics: {
				...base.finalMetrics,
				heapUsedMb: 28,
				sockets: 7,
				sessionsActive: 0,
				streamsActive: 0,
			},
		} as SegmentArtifact);
		expect(() => aggregateSegments([missingEvidence, segment(2)])).toThrow(
			/required operation|cleanup/i,
		);
	});

	test("aggregate executable exits cleanly outside bun test", () => {
		const root = mkdtempSync(join(tmpdir(), "soak-executable-"));
		tempRoots.push(root);
		const output = join(root, "aggregate.json");
		const result = runAggregate(writeCampaign(join(root, "input")), output);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("soak-addon: aggregate PASS");
		expect(result.stderr).not.toContain("outside of the test runner");
	});

	test("aggregate hash is independent of input directory and source filenames", () => {
		const root = mkdtempSync(join(tmpdir(), "soak-paths-"));
		tempRoots.push(root);
		const left = writeCampaign(join(root, "left", "nested"));
		const right = join(root, "right");
		mkdirSync(right, { recursive: true });
		writeFileSync(join(right, "z.json"), JSON.stringify(segment(1)), "utf8");
		writeFileSync(join(right, "a.json"), JSON.stringify(segment(2)), "utf8");
		const leftOut = join(root, "left-aggregate.json");
		const rightOut = join(root, "right-aggregate.json");

		const leftResult = runAggregate(left, leftOut);
		const rightResult = runAggregate(right, rightOut);
		expect(leftResult.status).toBe(0);
		expect(rightResult.status).toBe(0);
		const leftAggregate = JSON.parse(readFileSync(leftOut, "utf8"));
		const rightAggregate = JSON.parse(readFileSync(rightOut, "utf8"));
		expect(leftAggregate.aggregateHash).toBe(rightAggregate.aggregateHash);
		expect(
			leftAggregate.segments.map((item: { file: string }) => item.file),
		).toEqual(["soak-segment-01-of-02.json", "soak-segment-02-of-02.json"]);
	});

	test("timed-out load clients are hard-killed and output draining stays bounded", () => {
		const stubbornChild = [
			'process.on("SIGTERM", () => {});',
			'process.stdout.write("child-ready\\n");',
			"setTimeout(() => process.exit(0), 10_000);",
		].join("");
		const probe = [
			`import { runLoadClient } from ${JSON.stringify(HARNESS)};`,
			`const result = await runLoadClient("kill-probe", [process.execPath, "-e", ${JSON.stringify(stubbornChild)}], 25);`,
			'if (!result.timedOut) throw new Error("expected timeout");',
			'console.log("PROBE_PASS");',
		].join("\n");
		const result = spawnSync(process.execPath, ["-e", probe], {
			cwd: ROOT,
			encoding: "utf8",
			env: {
				...process.env,
				SOAK_CHILD_EXIT_GRACE_MS: "25",
				SOAK_CHILD_OUTPUT_DRAIN_MS: "25",
			},
			killSignal: "SIGKILL",
			timeout: 2_000,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("PROBE_PASS");
	}, 5_000);

	test("bounded process stdout reads kill stubborn children on timeout", async () => {
		const stubbornChild = [
			'process.on("SIGTERM", () => {});',
			'process.stdout.write("child-ready\\n");',
			"setTimeout(() => process.exit(0), 10_000);",
		].join("");
		const { readProcessTextBounded } = await import("./soak-addon.ts");
		const proc = Bun.spawn([process.execPath, "-e", stubbornChild], {
			stdout: "pipe",
			stderr: "ignore",
		});

		await expect(
			readProcessTextBounded("stubborn-probe", proc, 25),
		).rejects.toThrow(/timed out/i);
	}, 5_000);
});

describe("hosted soak orchestration policy", () => {
	test("pins actions and exact release toolchains", () => {
		const workflow = readFileSync(WORKFLOW, "utf8");
		const actionRefs = [...workflow.matchAll(/uses:\s*([^\s#]+)/g)].map(
			(match) => match[1] ?? "",
		);
		expect(actionRefs.length).toBeGreaterThan(0);
		for (const actionRef of actionRefs) {
			expect(actionRef).toMatch(/@[0-9a-f]{40}$/);
		}
		expect(workflow).toContain("toolchain: 1.95.0");
		expect(workflow).toContain('node-version: "22.23.1"');
		expect(workflow).toContain('bun-version: "1.3.9"');
	});

	test("downloads the prior artifact chain and makes aggregation mandatory", () => {
		const workflow = readFileSync(WORKFLOW, "utf8");
		expect(workflow).toContain(
			"Resolve previous segment artifact automatically",
		);
		expect(workflow).toContain("Download prior campaign segment artifacts");
		expect(workflow).toContain("/actions/artifacts");
		expect(workflow).toContain("jq -rs --arg name");
		expect(workflow).not.toContain("head -n1");
		expect(workflow).toContain("Aggregate the complete campaign");
		expect(workflow).not.toContain("Aggregate skipped");
		expect(workflow).not.toContain("previous_final_hash:");
		expect(workflow).not.toContain("1 for 1h/self-hosted");
	});

	test("caps each job and soak step near one hosted segment", () => {
		const workflow = readFileSync(WORKFLOW, "utf8");
		expect(workflow).toContain(
			"github.event.inputs.runner_type == 'github-hosted' && 330 || (github.event.inputs.segment_count == '1' && github.event.inputs.duration_hours == '72' && 4380 || github.event.inputs.segment_count == '1' && github.event.inputs.duration_hours == '24' && 1500 || 390)",
		);
		expect(workflow).toContain(
			"github.event.inputs.runner_type == 'github-hosted' && 300 || (github.event.inputs.segment_count == '1' && github.event.inputs.duration_hours == '72' && 4350 || github.event.inputs.segment_count == '1' && github.event.inputs.duration_hours == '24' && 1470 || 365)",
		);
		expect(workflow).toContain('"github-hosted:24:5"');
		expect(workflow).toContain('"github-hosted:72:15"');
		expect(workflow).toContain('"self-hosted:24:1"');
		expect(workflow).toContain('"self-hosted:72:1"');
		expect(workflow).not.toContain("44640");
	});

	test("permits one-run self-hosted long soaks while retaining hosted segmentation", () => {
		const workflow = readFileSync(WORKFLOW, "utf8");
		expect(workflow).toContain('"self-hosted:24:1"');
		expect(workflow).toContain('"self-hosted:72:1"');
		expect(workflow).toContain('"github-hosted:24:5"');
		expect(workflow).toContain('"github-hosted:72:15"');
		expect(workflow).toContain(
			"24h/72h github-hosted campaigns must use bounded multi-job segments",
		);
		expect(workflow).toContain(
			"automatic predecessor resolution did not provide previousFinalHash",
		);
	});

	test("validates structured segment evidence before upload", () => {
		const workflow = readFileSync(WORKFLOW, "utf8");
		expect(workflow).toContain("Validate segment evidence contract");
		expect(workflow).toContain("requiredOperationClasses");
		expect(workflow).toContain("observedOperationCounts");
		expect(workflow).toContain("baselineMetrics");
		expect(workflow).toContain("heapUsedMb");
		expect(workflow).toContain("sockets");
	});
});

describe("soak trend analysis", () => {
	test("rejects sustained RSS growth after a stress phase", () => {
		const samples: Sample[] = [
			{
				ts_ms: 0,
				phase: "baseline",
				rss: 100,
				heapUsedMb: 24,
				fd: 10,
				sockets: 4,
				sessions: 10,
				streams: 10,
				sessionTasks: 1,
				streamTasks: 1,
				queued: 0,
			},
			{
				ts_ms: 60_000,
				phase: "baseline",
				rss: 102,
				heapUsedMb: 25,
				fd: 10,
				sockets: 4,
				sessions: 10,
				streams: 10,
				sessionTasks: 1,
				streamTasks: 1,
				queued: 0,
			},
			{
				ts_ms: 120_000,
				phase: "overload",
				rss: 180,
				heapUsedMb: 42,
				fd: 12,
				sockets: 7,
				sessions: 20,
				streams: 30,
				sessionTasks: 3,
				streamTasks: 4,
				queued: 2_000_000,
			},
			{
				ts_ms: 180_000,
				phase: "overload",
				rss: 190,
				heapUsedMb: 44,
				fd: 13,
				sockets: 8,
				sessions: 20,
				streams: 30,
				sessionTasks: 3,
				streamTasks: 4,
				queued: 2_100_000,
			},
			{
				ts_ms: 240_000,
				phase: "recovery",
				rss: 170,
				heapUsedMb: 39,
				fd: 13,
				sockets: 8,
				sessions: 10,
				streams: 10,
				sessionTasks: 2,
				streamTasks: 2,
				queued: 0,
			},
			{
				ts_ms: 300_000,
				phase: "recovery",
				rss: 168,
				heapUsedMb: 38,
				fd: 13,
				sockets: 8,
				sessions: 10,
				streams: 10,
				sessionTasks: 2,
				streamTasks: 2,
				queued: 0,
			},
		];
		const result = evaluateTrendAndRecovery(
			samples,
			[
				{
					name: "overload",
					startedAtMs: 120_000,
					endedAtMs: 180_000,
					pass: true,
					notes: [],
				},
			],
			512 * 1024 * 1024,
		);
		expect(result.pass).toBe(false);
		expect(result.failures.some((failure) => failure.includes("RSS"))).toBe(
			true,
		);
	});

	test("rejects recovery that leaves heap and sockets above baseline", () => {
		const samples: Sample[] = [
			{
				ts_ms: 0,
				phase: "baseline",
				rss: 100,
				heapUsedMb: 20,
				fd: 10,
				sockets: 2,
				sessions: 10,
				streams: 10,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			} as Sample,
			{
				ts_ms: 60_000,
				phase: "baseline",
				rss: 100,
				heapUsedMb: 21,
				fd: 10,
				sockets: 2,
				sessions: 10,
				streams: 10,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			} as Sample,
			{
				ts_ms: 120_000,
				phase: "overload",
				rss: 130,
				heapUsedMb: 45,
				fd: 12,
				sockets: 6,
				sessions: 20,
				streams: 20,
				sessionTasks: 3,
				streamTasks: 3,
				queued: 1_000_000,
			} as Sample,
			{
				ts_ms: 180_000,
				phase: "recovery",
				rss: 105,
				heapUsedMb: 41,
				fd: 11,
				sockets: 5,
				sessions: 10,
				streams: 10,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			} as Sample,
			{
				ts_ms: 240_000,
				phase: "recovery",
				rss: 104,
				heapUsedMb: 40,
				fd: 11,
				sockets: 5,
				sessions: 10,
				streams: 10,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			} as Sample,
		];

		const result = evaluateTrendAndRecovery(
			samples,
			[
				{
					name: "overload",
					startedAtMs: 120_000,
					endedAtMs: 180_000,
					pass: true,
					notes: [],
				},
			],
			512 * 1024 * 1024,
		);

		expect(result.pass).toBe(false);
		expect(
			result.failures.some(
				(failure) => failure.includes("heap") || failure.includes("socket"),
			),
		).toBe(true);
	});

	test("does not flag recovered overload peaks as RSS or heap drift", () => {
		const samples: Sample[] = [
			{
				ts_ms: 0,
				phase: "baseline",
				rss: 100,
				heapUsedMb: 20,
				fd: 10,
				sockets: 2,
				sessions: 12,
				streams: 18,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			},
			{
				ts_ms: 60_000,
				phase: "steady-state",
				rss: 102,
				heapUsedMb: 22,
				fd: 10,
				sockets: 2,
				sessions: 12,
				streams: 18,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			},
			{
				ts_ms: 120_000,
				phase: "steady-state",
				rss: 103,
				heapUsedMb: 23,
				fd: 10,
				sockets: 2,
				sessions: 12,
				streams: 18,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			},
			{
				ts_ms: 180_000,
				phase: "overload",
				rss: 185,
				heapUsedMb: 48,
				fd: 14,
				sockets: 6,
				sessions: 20,
				streams: 32,
				sessionTasks: 3,
				streamTasks: 4,
				queued: 1_500_000,
			},
			{
				ts_ms: 240_000,
				phase: "recovery",
				rss: 104,
				heapUsedMb: 24,
				fd: 10,
				sockets: 2,
				sessions: 12,
				streams: 18,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			},
			{
				ts_ms: 300_000,
				phase: "recovery",
				rss: 103,
				heapUsedMb: 23,
				fd: 10,
				sockets: 2,
				sessions: 12,
				streams: 18,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			},
		];

		const result = evaluateTrendAndRecovery(
			samples,
			[
				{
					name: "steady-state",
					startedAtMs: 60_000,
					endedAtMs: 120_000,
					pass: true,
					notes: [],
				},
				{
					name: "overload",
					startedAtMs: 180_000,
					endedAtMs: 180_000,
					pass: true,
					notes: [],
				},
			],
			512 * 1024 * 1024,
		);

		expect(result.pass).toBe(true);
		expect(
			result.failures.some(
				(failure) => failure.includes("RSS") || failure.includes("heap"),
			),
		).toBe(false);
	});

	test("rejects steady-state recovery that leaves fd sessions and streams elevated", () => {
		const samples: Sample[] = [
			{
				ts_ms: 0,
				phase: "baseline",
				rss: 100,
				heapUsedMb: 20,
				fd: 10,
				sockets: 2,
				sessions: 12,
				streams: 18,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			},
			{
				ts_ms: 60_000,
				phase: "steady-state",
				rss: 101,
				heapUsedMb: 21,
				fd: 10,
				sockets: 2,
				sessions: 12,
				streams: 18,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			},
			{
				ts_ms: 120_000,
				phase: "steady-state",
				rss: 101,
				heapUsedMb: 21,
				fd: 10,
				sockets: 2,
				sessions: 12,
				streams: 18,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			},
			{
				ts_ms: 180_000,
				phase: "recovery",
				rss: 101,
				heapUsedMb: 21,
				fd: 15,
				sockets: 2,
				sessions: 16,
				streams: 24,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			},
			{
				ts_ms: 240_000,
				phase: "recovery",
				rss: 101,
				heapUsedMb: 21,
				fd: 15,
				sockets: 2,
				sessions: 16,
				streams: 24,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			},
		];

		const result = evaluateTrendAndRecovery(
			samples,
			[
				{
					name: "steady-state",
					startedAtMs: 60_000,
					endedAtMs: 120_000,
					pass: true,
					notes: [],
				},
			],
			512 * 1024 * 1024,
		);

		expect(result.pass).toBe(false);
		expect(
			result.failures.some((failure) => failure.includes("recovery fd")),
		).toBe(true);
		expect(
			result.failures.some((failure) => failure.includes("recovery sessions")),
		).toBe(true);
		expect(
			result.failures.some((failure) => failure.includes("recovery streams")),
		).toBe(true);
	});

	test("rejects overload recovery that leaves fd sessions and streams elevated", () => {
		const samples: Sample[] = [
			{
				ts_ms: 0,
				phase: "baseline",
				rss: 100,
				heapUsedMb: 20,
				fd: 10,
				sockets: 2,
				sessions: 12,
				streams: 18,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			},
			{
				ts_ms: 60_000,
				phase: "steady-state",
				rss: 101,
				heapUsedMb: 21,
				fd: 10,
				sockets: 2,
				sessions: 12,
				streams: 18,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			},
			{
				ts_ms: 120_000,
				phase: "steady-state",
				rss: 101,
				heapUsedMb: 21,
				fd: 10,
				sockets: 2,
				sessions: 12,
				streams: 18,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			},
			{
				ts_ms: 180_000,
				phase: "overload",
				rss: 140,
				heapUsedMb: 32,
				fd: 14,
				sockets: 5,
				sessions: 20,
				streams: 30,
				sessionTasks: 2,
				streamTasks: 2,
				queued: 800_000,
			},
			{
				ts_ms: 240_000,
				phase: "recovery",
				rss: 104,
				heapUsedMb: 22,
				fd: 15,
				sockets: 2,
				sessions: 16,
				streams: 24,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			},
			{
				ts_ms: 300_000,
				phase: "recovery",
				rss: 104,
				heapUsedMb: 22,
				fd: 15,
				sockets: 2,
				sessions: 16,
				streams: 24,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			},
		];

		const result = evaluateTrendAndRecovery(
			samples,
			[
				{
					name: "steady-state",
					startedAtMs: 60_000,
					endedAtMs: 120_000,
					pass: true,
					notes: [],
				},
				{
					name: "overload",
					startedAtMs: 180_000,
					endedAtMs: 180_000,
					pass: true,
					notes: [],
				},
			],
			512 * 1024 * 1024,
		);

		expect(result.pass).toBe(false);
		expect(
			result.failures.some(
				(failure) =>
					failure.includes("phase overload recovery fd") ||
					failure.includes("phase overload recovery sessions") ||
					failure.includes("phase overload recovery streams"),
			),
		).toBe(true);
	});

	test("rejects reconnect-churn recovery that leaves fd sessions and streams elevated", () => {
		const samples: Sample[] = [
			{
				ts_ms: 0,
				phase: "baseline",
				rss: 100,
				heapUsedMb: 20,
				fd: 10,
				sockets: 2,
				sessions: 12,
				streams: 18,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			},
			{
				ts_ms: 60_000,
				phase: "steady-state",
				rss: 101,
				heapUsedMb: 21,
				fd: 10,
				sockets: 2,
				sessions: 12,
				streams: 18,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			},
			{
				ts_ms: 120_000,
				phase: "steady-state",
				rss: 101,
				heapUsedMb: 21,
				fd: 10,
				sockets: 2,
				sessions: 12,
				streams: 18,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			},
			{
				ts_ms: 180_000,
				phase: "reconnect-churn",
				rss: 125,
				heapUsedMb: 28,
				fd: 13,
				sockets: 4,
				sessions: 18,
				streams: 26,
				sessionTasks: 2,
				streamTasks: 2,
				queued: 200_000,
			},
			{
				ts_ms: 240_000,
				phase: "recovery",
				rss: 103,
				heapUsedMb: 22,
				fd: 15,
				sockets: 2,
				sessions: 16,
				streams: 24,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			},
			{
				ts_ms: 300_000,
				phase: "recovery",
				rss: 103,
				heapUsedMb: 22,
				fd: 15,
				sockets: 2,
				sessions: 16,
				streams: 24,
				sessionTasks: 0,
				streamTasks: 0,
				queued: 0,
			},
		];

		const result = evaluateTrendAndRecovery(
			samples,
			[
				{
					name: "steady-state",
					startedAtMs: 60_000,
					endedAtMs: 120_000,
					pass: true,
					notes: [],
				},
				{
					name: "reconnect-churn",
					startedAtMs: 180_000,
					endedAtMs: 180_000,
					pass: true,
					notes: [],
				},
			],
			512 * 1024 * 1024,
		);

		expect(result.pass).toBe(false);
		expect(
			result.failures.some(
				(failure) =>
					failure.includes("phase reconnect-churn recovery fd") ||
					failure.includes("phase reconnect-churn recovery sessions") ||
					failure.includes("phase reconnect-churn recovery streams"),
			),
		).toBe(true);
	});
});
