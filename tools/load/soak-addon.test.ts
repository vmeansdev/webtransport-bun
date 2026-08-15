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
	bunVersionAtLeast,
	computeSegmentObservedOperationCounts,
	evaluateTrendAndRecovery,
	type H7HostedExpectations,
	loadProportionalRssCeilMb,
	resolveRssCeilMb,
	type Sample,
	verifyH7Hosted,
} from "./soak-addon.ts";

const ROOT = join(import.meta.dir, "..", "..");
const HARNESS = join(import.meta.dir, "soak-addon.ts");
const WORKFLOW = join(ROOT, ".github", "workflows", "soak-long.yml");
const VALIDATOR = join(ROOT, "scripts", "validate-soak-inputs.sh");
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
		source: { head: "a".repeat(40), dirty: false },
		workflowSource: { ref: null, sha: null },
		h7Delivery: {
			datagramBatchRequested: "64",
			datagramBatchResolved: 64,
			payloadDeliveryRequested: null,
			payloadDeliveryResolved: "arraybuffer",
			diagnosticsEnabled: false,
			diagnostics: null,
			datagramsSent: 10,
			datagramsReceived: 10,
			deliveryRatio: 1,
		},
		toolchain: {
			bun: "1.3.14",
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
			datagramsReceived: 10,
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

/** A GitHub Actions expression. Built rather than written literally so the
 * `${` sigil never appears inside a plain string. */
const gh = (body: string): string => `${"$"}{{ ${body} }}`;

const H7_SHA = "a".repeat(40);
const H7_REF = `refs/tags/h7-batch-delivery-${H7_SHA}`;
const H7_TOKEN = "h7-continuity-token";
const H7_SEED = "h7-campaign-seed";
const H7_DURATION_SECONDS = 7200;
const H7_RSS_CEIL_MB = 1750;

const H7_EXPECTATIONS: H7HostedExpectations = {
	sha: H7_SHA,
	batch: 64,
	rssCeilMb: H7_RSS_CEIL_MB,
	durationSeconds: H7_DURATION_SECONDS,
	seed: H7_SEED,
	continuityToken: H7_TOKEN,
	workflowRef: H7_REF,
};

/** A hosted-H7 segment: one 1/1 self-hosted dedicated fixed-profile segment
 * carrying every field `verify-h7-hosted` binds. Overrides are applied at the
 * top level, so a negative case supplies the whole replacement sub-object. */
function h7Segment(overrides: Record<string, unknown> = {}): SegmentArtifact {
	const base = segment(1) as unknown as Record<string, unknown>;
	const mainLoad = base.mainLoad as Record<string, unknown>;
	return seal({
		...base,
		segmentCount: 1,
		previousFinalHash: null,
		durationSeconds: H7_DURATION_SECONDS,
		candidateRef: H7_REF,
		seed: H7_SEED,
		continuityTokenDigest: createHash("sha256").update(H7_TOKEN).digest("hex"),
		runnerType: "self-hosted",
		runnerMode: "dedicated",
		runnerProfile: "h7-fixed-large",
		source: { head: H7_SHA, dirty: false },
		workflowSource: { ref: H7_REF, sha: H7_SHA },
		rates: { sessions: 500, datagramsPerSec: 500, streamsPerSec: 5 },
		thresholds: {
			maxSessionErrors: 250,
			maxDatagramErrors: 5000,
			maxStreamErrors: 2000,
			rssTrendMaxRel: 0.3,
			rssTrendMinAbsMb: 32,
			rssCeilMb: H7_RSS_CEIL_MB,
			maxGapMs: 300_000,
		},
		debugKnobs: {
			heapDebug: false,
			heapDebugIntervalMs: 60_000,
			committedAbortMb: 2200,
		},
		h7Delivery: {
			datagramBatchRequested: "64",
			datagramBatchResolved: 64,
			payloadDeliveryRequested: null,
			payloadDeliveryResolved: "arraybuffer",
			diagnosticsEnabled: false,
			diagnostics: null,
			datagramsSent: 1_000_000,
			datagramsReceived: 990_000,
			deliveryRatio: 0.99,
		},
		mainLoad: {
			...mainLoad,
			datagramsSent: 1_000_000,
			datagramsReceived: 990_000,
		},
		samples: [
			{
				ts_ms: 1,
				phase: "main-load",
				rss: 1200,
				heapUsedMb: 40,
				fd: 30,
				sockets: 4,
				sessions: 500,
				streams: 20,
				sessionTasks: 500,
				streamTasks: 20,
				queued: 0,
			},
		],
		...overrides,
	} as unknown as SegmentArtifact);
}

/** Write one segment plus the aggregate `aggregateSegments` derives from it,
 * optionally tampering with the aggregate after it was sealed. */
function writeH7Pair(
	label: string,
	seg: SegmentArtifact,
	mutateAggregate: (aggregate: Record<string, unknown>) => void = () => {},
): { aggregatePath: string; segmentPath: string } {
	const root = mkdtempSync(join(tmpdir(), `soak-h7-${label}-`));
	tempRoots.push(root);
	// A negative fixture may be one the aggregator refuses outright. Pairing it
	// with the aggregate of a pristine segment keeps the file on disk, and
	// leaves the verifier — not this helper — to reject it.
	let aggregate: Record<string, unknown>;
	try {
		aggregate = aggregateSegments([seg]) as unknown as Record<string, unknown>;
	} catch {
		aggregate = aggregateSegments([h7Segment()]) as unknown as Record<
			string,
			unknown
		>;
	}
	mutateAggregate(aggregate);
	const aggregatePath = join(root, "soak-aggregate-2h.json");
	const segmentPath = join(root, "soak-artifacts-seg-01-of-01.json");
	writeFileSync(aggregatePath, JSON.stringify(aggregate, null, 2), "utf8");
	writeFileSync(segmentPath, JSON.stringify(seg, null, 2), "utf8");
	return { aggregatePath, segmentPath };
}

function runValidator(overrides: Record<string, string | undefined> = {}) {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	Object.assign(env, {
		CANDIDATE_COMMIT: "a".repeat(40),
		CANDIDATE_REF: "refs/tags/v1.0.0",
		CAMPAIGN_SEED: "seed-01",
		CONTINUITY_TOKEN: "continuity-01",
		DURATION_HOURS: "1",
		RUNNER_TYPE: "github-hosted",
		RUNNER_MODE: "shared",
		SEGMENT_INDEX: "1",
		SEGMENT_COUNT: "1",
		DATAGRAM_BATCH: "64",
		RSS_CEILING_MB: "1750",
		COMMITTED_ABORT_MB: "1500",
		WORKFLOW_REF: "refs/heads/main",
		WORKFLOW_SHA: "b".repeat(40),
	});
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	return spawnSync("bash", [VALIDATOR], { cwd: ROOT, encoding: "utf8", env });
}

/** The fixed hosted-H7 lane tuple the validator pins before any setup runs. */
function runH7Validator(overrides: Record<string, string | undefined> = {}) {
	return runValidator({
		CANDIDATE_COMMIT: H7_SHA,
		CANDIDATE_REF: H7_REF,
		WORKFLOW_REF: H7_REF,
		WORKFLOW_SHA: H7_SHA,
		ACTUAL_HEAD: H7_SHA,
		DURATION_HOURS: "2",
		RUNNER_TYPE: "self-hosted",
		RUNNER_MODE: "dedicated",
		SEGMENT_INDEX: "1",
		SEGMENT_COUNT: "1",
		DATAGRAM_BATCH: "64",
		RSS_CEILING_MB: "1750",
		COMMITTED_ABORT_MB: "2200",
		...overrides,
	});
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

	test("aggregateSegments rejects segments recorded on a WritableStream-leaking Bun", () => {
		// Bun <=1.3.13 leaks one WritableStream per rejected writer.close();
		// a segment recorded there is not evidence regardless of its verdict.
		const leakyRuntime = segment(1, {
			toolchain: {
				bun: "1.3.13",
				rustc: "rustc 1.95.0",
				cc: { path: "/usr/bin/clang", version: "clang version 18.1.8" },
				cxx: { path: "/usr/bin/clang++", version: "clang version 18.1.8" },
			},
		});
		expect(() => aggregateSegments([leakyRuntime])).toThrow(
			/Bun 1\.3\.13.*requires Bun >= 1\.3\.14/,
		);
	});

	test("bunVersionAtLeast is strict and fails closed", () => {
		expect(bunVersionAtLeast("1.3.14", "1.3.14")).toBe(true);
		expect(bunVersionAtLeast("1.3.15", "1.3.14")).toBe(true);
		expect(bunVersionAtLeast("1.4.0", "1.3.14")).toBe(true);
		expect(bunVersionAtLeast("1.10.0", "1.3.14")).toBe(true);
		expect(bunVersionAtLeast("2.0.0", "1.3.14")).toBe(true);
		expect(bunVersionAtLeast("1.3.13", "1.3.14")).toBe(false);
		expect(bunVersionAtLeast("1.3.9", "1.3.14")).toBe(false);
		// Prereleases and malformed strings predate or obscure the fix: closed.
		expect(bunVersionAtLeast("1.3.14-canary.1", "1.3.14")).toBe(false);
		expect(bunVersionAtLeast("1.4.0-beta", "1.3.14")).toBe(false);
		expect(bunVersionAtLeast("x.3.14", "1.3.14")).toBe(false);
		expect(bunVersionAtLeast("1.3", "1.3.14")).toBe(false);
		expect(bunVersionAtLeast("", "1.3.14")).toBe(false);
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
		// 1.3.14 is a floor, not just a pin: Bun <=1.3.13 leaks WritableStreams
		// on rejected close (OOM-killed the 24h soak, run 31134714109).
		expect(workflow).toContain('bun-version: "1.3.14"');
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
		// Segment policy moved into the input validator when runner_mode was
		// added; the combos are asserted there, mode-explicitly.
		const validator = readFileSync(VALIDATOR, "utf8");
		for (const combo of [
			"github-hosted:shared:24:5",
			"github-hosted:dedicated:24:5",
			"github-hosted:shared:72:15",
			"github-hosted:dedicated:72:15",
			"self-hosted:shared:24:1",
			"self-hosted:dedicated:24:1",
			"self-hosted:shared:72:1",
			"self-hosted:dedicated:72:1",
		]) {
			expect(validator).toContain(`"${combo}"`);
		}
		expect(workflow).not.toContain("44640");
	});

	test("permits one-run self-hosted long soaks while retaining hosted segmentation", () => {
		const workflow = readFileSync(WORKFLOW, "utf8");
		const validator = readFileSync(VALIDATOR, "utf8");
		expect(validator).toContain('"self-hosted:shared:24:1"');
		expect(validator).toContain('"self-hosted:dedicated:72:1"');
		expect(validator).toContain('"github-hosted:shared:24:5"');
		expect(validator).toContain('"github-hosted:dedicated:72:15"');
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

	test("a dispatched RSS ceiling may tighten the load-proportional default but never loosen it", () => {
		// The H7 end: at the fixed 500-session profile the preregistered 1750 and
		// the harness default are the same number, so H7 keeps exactly 1750 and
		// verify-h7-hosted's thresholds.rssCeilMb equality is untouched.
		expect(loadProportionalRssCeilMb(500)).toBe(1750);
		expect(resolveRssCeilMb("1750", 500)).toBe(1750);

		// The other end: a routine shared large 1h lane runs 250 sessions, whose
		// default ceiling is 1024. Propagating the H7 input to every lane must not
		// hand it a 1750 ceiling it never had.
		expect(loadProportionalRssCeilMb(250)).toBe(1024);
		expect(resolveRssCeilMb("1750", 250)).toBe(1024);

		// Tightening is still honored, and an absent request is the plain default.
		expect(resolveRssCeilMb("512", 500)).toBe(512);
		expect(resolveRssCeilMb(undefined, 250)).toBe(1024);
		expect(resolveRssCeilMb("", 250)).toBe(1024);

		// The small-profile floor still applies, and a garbage or non-positive
		// knob aborts instead of silently disabling the guard it configures.
		expect(loadProportionalRssCeilMb(50)).toBe(1024);
		expect(() => resolveRssCeilMb("nonsense", 500)).toThrow(/positive number/);
		expect(() => resolveRssCeilMb("0", 500)).toThrow(/positive number/);
		expect(() => resolveRssCeilMb("-1", 500)).toThrow(/positive number/);
	});

	test("bounds the datagram batch and RSS ceiling inputs", () => {
		expect(runValidator().status).toBe(0);
		for (const batch of ["0", "256"]) {
			expect(runValidator({ DATAGRAM_BATCH: batch }).status, batch).toBe(0);
		}
		for (const batch of ["", "-1", "257", "1.5", "064x", "+1"]) {
			expect(runValidator({ DATAGRAM_BATCH: batch }).status, batch).toBe(1);
		}
		expect(runValidator({ DATAGRAM_BATCH: undefined }).status).toBe(1);
		expect(runValidator({ RSS_CEILING_MB: "1" }).status).toBe(0);
		for (const ceiling of ["", "0", "-1", "1.5"]) {
			expect(runValidator({ RSS_CEILING_MB: ceiling }).status, ceiling).toBe(1);
		}
		expect(runValidator({ RSS_CEILING_MB: undefined }).status).toBe(1);
	});

	test("declares and threads the new knobs through the validator and soak env", () => {
		const workflow = readFileSync(WORKFLOW, "utf8");
		expect(workflow).toContain("datagram_batch:");
		expect(workflow).toContain("rss_ceiling_mb:");
		expect(workflow).toContain(
			`DATAGRAM_BATCH: ${gh("github.event.inputs.datagram_batch")}`,
		);
		expect(workflow).toContain(
			`RSS_CEILING_MB: ${gh("github.event.inputs.rss_ceiling_mb")}`,
		);
		expect(workflow).toContain(
			`COMMITTED_ABORT_MB: ${gh("github.event.inputs.committed_abort_mb")}`,
		);
		expect(workflow).toContain(`WORKFLOW_REF: ${gh("github.ref")}`);
		expect(workflow).toContain(`WORKFLOW_SHA: ${gh("github.sha")}`);
		expect(workflow).toContain(
			"WEBTRANSPORT_DATAGRAM_BATCH=$INPUT_DATAGRAM_BATCH",
		);
		expect(workflow).toContain("SOAK_RSS_CEIL_MB=$INPUT_RSS_CEILING_MB");
		expect(workflow).toContain(
			`WEBTRANSPORT_DATAGRAM_BATCH: ${gh("github.event.inputs.datagram_batch")}`,
		);
		expect(workflow).toContain(
			`SOAK_RSS_CEIL_MB: ${gh("github.event.inputs.rss_ceiling_mb")}`,
		);
		// The runner must not be able to inject the diagnostic escape hatches
		// into a 2-hour product run.
		expect(workflow).toContain(
			"env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS \\",
		);
		expect(workflow).toContain(
			`run-name: soak-long-${gh("inputs.campaign_seed")}`,
		);
		// The validator computes the checked-out HEAD itself; a self-hosted
		// runner cannot pre-seed it through the workflow.
		expect(workflow).not.toContain("ACTUAL_HEAD");
	});

	test("validates campaign inputs before any toolchain setup", () => {
		const workflow = readFileSync(WORKFLOW, "utf8");
		const validateAt = workflow.indexOf("- name: Validate campaign inputs");
		const checkoutAt = workflow.indexOf("uses: actions/checkout@");
		expect(checkoutAt).toBeGreaterThan(0);
		expect(validateAt).toBeGreaterThan(checkoutAt);
		for (const setup of [
			"uses: dtolnay/rust-toolchain@",
			"uses: actions/setup-node@",
			"uses: oven-sh/setup-bun@",
			"- name: Install deps",
		]) {
			expect(workflow.indexOf(setup), setup).toBeGreaterThan(validateAt);
		}
	});

	test("pins the hosted H7 lane and refuses to downscale it", () => {
		expect(runH7Validator().status).toBe(0);
		for (const [key, value] of [
			["WORKFLOW_REF", "refs/heads/main"],
			["WORKFLOW_SHA", "b".repeat(40)],
			["ACTUAL_HEAD", "c".repeat(40)],
			["CANDIDATE_REF", `refs/tags/h7-batch-delivery-${"d".repeat(40)}`],
			["DURATION_HOURS", "1"],
			["RUNNER_TYPE", "github-hosted"],
			["RUNNER_MODE", "shared"],
			["DATAGRAM_BATCH", "32"],
			["RSS_CEILING_MB", "1024"],
			["COMMITTED_ABORT_MB", "1500"],
		] as const) {
			expect(runH7Validator({ [key]: value }).status, key).toBe(1);
		}

		const workflow = readFileSync(WORKFLOW, "utf8");
		expect(workflow).toContain("h7-batch-delivery-[0-9a-f]{40}");
		expect(workflow).toContain('PROFILE="h7-fixed-large"');
		expect(workflow).toContain("H7 hosted lane requires >= 5 CPUs");
		expect(workflow).toContain(
			`CANDIDATE_REF: ${gh("github.event.inputs.candidate_ref")}`,
		);
	});
});

describe("h7 hosted evidence contract", () => {
	test("accepts a complete hosted H7 campaign", () => {
		const { aggregatePath, segmentPath } = writeH7Pair("pass", h7Segment());
		expect(() =>
			verifyH7Hosted(aggregatePath, segmentPath, H7_EXPECTATIONS),
		).not.toThrow();
	});

	test("rejects tampered segment and aggregate hashes", () => {
		const tamperedSegment = h7Segment();
		tamperedSegment.segmentHash = "0".repeat(64);
		const first = writeH7Pair("seg-hash", tamperedSegment);
		expect(() =>
			verifyH7Hosted(first.aggregatePath, first.segmentPath, H7_EXPECTATIONS),
		).toThrow(/hash/i);

		const second = writeH7Pair("agg-hash", h7Segment(), (aggregate) => {
			aggregate.aggregateHash = "0".repeat(64);
		});
		expect(() =>
			verifyH7Hosted(second.aggregatePath, second.segmentPath, H7_EXPECTATIONS),
		).toThrow(/hash/i);
	});

	test("rejects an aggregate that does not re-derive from its segment", () => {
		const { aggregatePath, segmentPath } = writeH7Pair(
			"rederive",
			h7Segment(),
			(aggregate) => {
				aggregate.totalDurationSeconds = 3600;
				aggregate.aggregateHash = sha256Hex({
					...aggregate,
					aggregateHash: undefined,
				});
			},
		);
		expect(() =>
			verifyH7Hosted(aggregatePath, segmentPath, H7_EXPECTATIONS),
		).toThrow(/re-derive|canonical/i);
	});

	test("rejects one wrong field at a time", () => {
		const cases: Array<[string, Record<string, unknown>]> = [
			["dirty tree", { source: { head: H7_SHA, dirty: true } }],
			["wrong head", { source: { head: "e".repeat(40), dirty: false } }],
			["missing workflow ref", { workflowSource: { ref: null, sha: H7_SHA } }],
			[
				"wrong workflow ref",
				{ workflowSource: { ref: "refs/heads/main", sha: H7_SHA } },
			],
			["missing workflow sha", { workflowSource: { ref: H7_REF, sha: null } }],
			[
				"wrong workflow sha",
				{ workflowSource: { ref: H7_REF, sha: "f".repeat(40) } },
			],
			["wrong seed", { seed: "other-seed" }],
			["wrong continuity token", { continuityTokenDigest: "0".repeat(64) }],
			["wrong runner type", { runnerType: "github-hosted" }],
			["wrong runner mode", { runnerMode: "shared" }],
			["wrong runner profile", { runnerProfile: "large" }],
			[
				"wrong sessions rate",
				{ rates: { sessions: 300, datagramsPerSec: 500, streamsPerSec: 5 } },
			],
			[
				"wrong datagram rate",
				{ rates: { sessions: 500, datagramsPerSec: 300, streamsPerSec: 5 } },
			],
			[
				"wrong stream rate",
				{ rates: { sessions: 500, datagramsPerSec: 500, streamsPerSec: 4 } },
			],
			["wrong duration", { durationSeconds: 3600 }],
			["wrong segment count", { segmentCount: 2 }],
		];
		for (const [label, override] of cases) {
			const { aggregatePath, segmentPath } = writeH7Pair(
				"neg",
				h7Segment(override),
			);
			expect(
				() => verifyH7Hosted(aggregatePath, segmentPath, H7_EXPECTATIONS),
				label,
			).toThrow();
		}
	});

	test("rejects one wrong delivery field at a time", () => {
		const delivery = (
			patch: Record<string, unknown>,
		): Record<string, unknown> => ({
			h7Delivery: {
				datagramBatchRequested: "64",
				datagramBatchResolved: 64,
				payloadDeliveryRequested: null,
				payloadDeliveryResolved: "arraybuffer",
				diagnosticsEnabled: false,
				diagnostics: null,
				datagramsSent: 1_000_000,
				datagramsReceived: 990_000,
				deliveryRatio: 0.99,
				...patch,
			},
		});
		const cases: Array<[string, Record<string, unknown>]> = [
			["requested batch", delivery({ datagramBatchRequested: "32" })],
			["resolved batch", delivery({ datagramBatchResolved: 32 })],
			[
				"requested payload mode",
				delivery({ payloadDeliveryRequested: "buffer-copy" }),
			],
			[
				"resolved payload mode",
				delivery({ payloadDeliveryResolved: "buffer-copy" }),
			],
			[
				"diagnostics enabled",
				delivery({
					diagnosticsEnabled: true,
					diagnostics: { batchReadCalls: 1 },
				}),
			],
			[
				"low delivery ratio",
				delivery({ datagramsReceived: 900_000, deliveryRatio: 0.9 }),
			],
			["no datagrams sent", delivery({ datagramsSent: 0, deliveryRatio: 0 })],
			[
				"non-finite ratio",
				delivery({ deliveryRatio: null as unknown as number }),
			],
		];
		for (const [label, override] of cases) {
			const { aggregatePath, segmentPath } = writeH7Pair(
				"delivery",
				h7Segment(override),
			);
			expect(
				() => verifyH7Hosted(aggregatePath, segmentPath, H7_EXPECTATIONS),
				label,
			).toThrow();
		}
	});

	test("rejects an excessive charged peak, heap debug, and a wrong breaker", () => {
		const peak = writeH7Pair(
			"peak",
			h7Segment({
				samples: [
					{
						ts_ms: 1,
						phase: "overload",
						rss: H7_RSS_CEIL_MB + 1,
						heapUsedMb: 40,
						fd: 30,
						sockets: 4,
						sessions: 500,
						streams: 20,
						sessionTasks: 500,
						streamTasks: 20,
						queued: 0,
					},
				],
			}),
		);
		expect(() =>
			verifyH7Hosted(peak.aggregatePath, peak.segmentPath, H7_EXPECTATIONS),
		).toThrow(/peak|ceiling/i);

		for (const knobs of [
			{ heapDebug: true, heapDebugIntervalMs: 60_000, committedAbortMb: 2200 },
			{ heapDebug: false, heapDebugIntervalMs: 60_000, committedAbortMb: 1500 },
		]) {
			const run = writeH7Pair("knobs", h7Segment({ debugKnobs: knobs }));
			expect(() =>
				verifyH7Hosted(run.aggregatePath, run.segmentPath, H7_EXPECTATIONS),
			).toThrow();
		}
	});

	test("rejects a wrong expected SHA and non-baseline final gauges", () => {
		const clean = writeH7Pair("sha", h7Segment());
		expect(() =>
			verifyH7Hosted(clean.aggregatePath, clean.segmentPath, {
				...H7_EXPECTATIONS,
				sha: "9".repeat(40),
			}),
		).toThrow(/sha|commit/i);
		expect(() =>
			verifyH7Hosted(clean.aggregatePath, clean.segmentPath, {
				...H7_EXPECTATIONS,
				continuityToken: "not-the-token",
			}),
		).toThrow(/continuity/i);

		const drifted = h7Segment();
		const finalMetrics = drifted.finalMetrics as Record<string, number>;
		finalMetrics.sessionsActive = 3;
		const sealed = seal(drifted);
		const run = writeH7Pair("gauges", sealed);
		expect(() =>
			verifyH7Hosted(run.aggregatePath, run.segmentPath, H7_EXPECTATIONS),
		).toThrow();
	});

	test("records the resolved knob and ceiling and carries them into the aggregate", () => {
		const harness = readFileSync(HARNESS, "utf8");
		expect(harness).toContain("datagramBatchResolved");
		expect(harness).toContain("rssCeilMb: RSS_CEIL_MB");
		expect(harness).toContain("datagramBatchConfigForTests");
		expect(harness).toContain("nativePayloadDeliveryModeForTests");

		const aggregate = aggregateSegments([h7Segment()]) as unknown as Record<
			string,
			unknown
		>;
		expect(aggregate.runnerType).toBe("self-hosted");
		expect(aggregate.runnerMode).toBe("dedicated");
		expect(aggregate.runnerProfile).toBe("h7-fixed-large");
		expect(aggregate.rates).toEqual({
			sessions: 500,
			datagramsPerSec: 500,
			streamsPerSec: 5,
		});
		expect(aggregate.workflowSource).toEqual({ ref: H7_REF, sha: H7_SHA });
		expect(aggregate.source).toEqual({ head: H7_SHA, dirty: false });
		expect((aggregate.thresholds as { rssCeilMb: number }).rssCeilMb).toBe(
			H7_RSS_CEIL_MB,
		);
		expect(
			(aggregate.h7Delivery as { datagramBatchResolved: number })
				.datagramBatchResolved,
		).toBe(64);
		expect(aggregate.datagramsSent).toBe(1_000_000);
		expect(aggregate.datagramsReceived).toBe(990_000);
		expect(aggregate.deliveryRatio).toBeCloseTo(0.99, 6);
		// The counters themselves are per-segment measurement, not configuration.
		expect(aggregate.h7Delivery).not.toHaveProperty("diagnostics");
	});

	test("verify-h7-hosted exits nonzero from the CLI on a mismatch", () => {
		const { aggregatePath, segmentPath } = writeH7Pair("cli", h7Segment());
		const args = (sha: string) => [
			HARNESS,
			"verify-h7-hosted",
			aggregatePath,
			segmentPath,
			"--sha",
			sha,
			"--batch",
			"64",
			"--rss-ceil-mb",
			String(H7_RSS_CEIL_MB),
			"--duration-seconds",
			String(H7_DURATION_SECONDS),
			"--seed",
			H7_SEED,
			"--continuity-token",
			H7_TOKEN,
			"--workflow-ref",
			H7_REF,
		];
		const ok = spawnSync(process.execPath, args(H7_SHA), {
			cwd: ROOT,
			encoding: "utf8",
		});
		expect(ok.status).toBe(0);
		expect(ok.stdout).toContain("soak-addon: H7 hosted PASS");

		const bad = spawnSync(process.execPath, args("9".repeat(40)), {
			cwd: ROOT,
			encoding: "utf8",
		});
		expect(bad.status).not.toBe(0);
		expect(bad.stdout).not.toContain("soak-addon: H7 hosted PASS");
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
				rss: 300,
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
				rss: 340,
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
		expect(
			result.failures.some((failure) => failure.includes("charged memory")),
		).toBe(true);
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
				streams: 64,
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
				streams: 64,
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
		// Per-phase stream recovery was removed deliberately (churn variance
		// under the continuous main load); stuck streams are asserted by the
		// run-final streamsActive===0 requirement instead.
		expect(
			result.failures.some((failure) => failure.includes("recovery streams")),
		).toBe(false);
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
