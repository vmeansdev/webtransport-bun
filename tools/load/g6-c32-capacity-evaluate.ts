import { readFileSync, writeFileSync } from "node:fs";

type Status = "CLEAN" | "UNCLEAN_OVERFLOW" | "UNCLEAN_QUALITY" | "INCOMPLETE";

type UdpTotals = {
	InErrors: number;
	RcvbufErrors: number;
	SndbufErrors: number;
};

export type CapacityRungDecision = {
	schema: "g6-c32-capacity-rung/1";
	rung: number;
	status: Status;
	reasons: string[];
	gradeGate: "PASS" | "MISS" | null;
	serverUdpTotal: UdpTotals | null;
	generatorUdpTotal: UdpTotals | null;
	sessionsErr: number | null;
	steadySessionsLost: number | null;
	lifecycleClean: boolean;
};

type RecordValue = Record<string, unknown>;
const udpFields = ["InErrors", "RcvbufErrors", "SndbufErrors"] as const;
const phases = ["connect", "steady", "drain", "idle"] as const;
const lifecyclePhases = [...phases, "stop"] as const;

function record(value: unknown): RecordValue | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as RecordValue)
		: null;
}

function counter(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function udpTotal(value: unknown): UdpTotals | null {
	const samples = record(value);
	if (!samples || Object.keys(samples).length !== phases.length) return null;
	const start = record(samples.connect);
	const end = record(samples.idle);
	if (!start || !end) return null;
	const total = {} as UdpTotals;
	for (const field of udpFields) {
		if (
			!counter(start[field]) ||
			!counter(end[field]) ||
			end[field] < start[field]
		)
			return null;
		total[field] = end[field] - start[field];
	}
	for (const phase of phases) {
		const sample = record(samples[phase]);
		if (!sample || udpFields.some((field) => !counter(sample[field])))
			return null;
	}
	return total;
}

function cleanBpfPreArm(value: unknown): boolean {
	const preArm = record(value);
	const receipt = record(preArm?.receiptValidation);
	const steer = record(preArm?.steerStats);
	return (
		preArm?.fresh === true &&
		preArm.socksEntries === 16 &&
		receipt?.valid === true &&
		receipt.instances === 16 &&
		steer?.steered === 0 &&
		steer.fallback === 0
	);
}

function cleanLifecycle(value: unknown): boolean {
	if (!Array.isArray(value) || value.length !== 16) return false;
	const ids = new Set<number>();
	for (const shard of value) {
		const row = record(shard);
		if (
			!counter(row?.serverId) ||
			row.serverId < 1 ||
			row.serverId > 16 ||
			ids.has(row.serverId)
		)
			return false;
		ids.add(row.serverId);
		const boundaries = Array.isArray(row.boundaries) ? row.boundaries : null;
		const exits = Array.isArray(row.exits) ? row.exits : null;
		if (
			!boundaries ||
			boundaries.length !== lifecyclePhases.length ||
			boundaries.some(
				(boundary, index) => record(boundary)?.phase !== lifecyclePhases[index],
			) ||
			!exits ||
			exits.length !== 1 ||
			record(exits[0])?.code !== 0 ||
			record(exits[0])?.signal !== null
		)
			return false;
	}
	return (
		ids.size === 16 &&
		Array.from({ length: 16 }, (_, index) => ids.has(index + 1)).every(Boolean)
	);
}

function gradeGate(
	value: unknown,
): { valid: boolean; gate: "PASS" | "MISS" | null } | null {
	const grade = record(value);
	const rungs = Array.isArray(grade?.rungs) ? grade.rungs : null;
	if (!rungs || rungs.length !== 1) return null;
	const rung = record(rungs[0]);
	if (typeof rung?.valid !== "boolean") return null;
	const gate = rung.gate === "PASS" || rung.gate === "MISS" ? rung.gate : null;
	return { valid: rung.valid, gate };
}

export function evaluateCapacityRung(input: unknown): CapacityRungDecision {
	const root = record(input);
	const rung = root?.rung;
	const scan = record(root?.scan);
	const diagnostic = record(root?.diagnostic);
	const report = record(root?.report);
	const producerStatus = root?.producerStatus;
	const extractMmoStatus = root?.extractMmoStatus;
	const extractSteerStatus = root?.extractSteerStatus;
	const gradeStatus = root?.gradeStatus;
	const artifactErrors = Array.isArray(root?.artifactErrors)
		? root.artifactErrors.filter(
				(value): value is string => typeof value === "string",
			)
		: [];
	const grade = gradeGate(root?.grade);
	const serverUdpTotal = udpTotal(diagnostic?.serverHostUdp);
	const generatorUdpTotal = udpTotal(report?.hostUdp);
	const sessionsErr = report?.sessionsErr;
	const steadySessionsLost = record(
		record(report?.windows)?.steady,
	)?.sessionsLost;
	const lifecycleClean = cleanLifecycle(diagnostic?.perShardLifecycle);
	const reasons: string[] = [];

	if (!counter(rung) || rung === 0)
		reasons.push("rung must be a positive integer");
	if (producerStatus !== 0) reasons.push("producer status must be zero");
	if (extractMmoStatus !== 0)
		reasons.push("mmo-client extraction status must be zero");
	if (extractSteerStatus !== 0)
		reasons.push("post-steer extraction status must be zero");
	if (gradeStatus !== 0) reasons.push("grade status must be zero");
	reasons.push(...artifactErrors);
	if (scan?.clientExit !== 0) reasons.push("clientExit must be zero");
	if (!cleanBpfPreArm(diagnostic?.bpfPreArm))
		reasons.push("BPF pre-arm is invalid");
	if (!serverUdpTotal)
		reasons.push("server UDP samples are incomplete or non-monotonic");
	if (!generatorUdpTotal)
		reasons.push("generator UDP samples are incomplete or non-monotonic");
	if (!grade || !grade.valid || grade.gate === null)
		reasons.push("grade must contain one valid PASS or MISS rung");
	if (!counter(sessionsErr))
		reasons.push("sessionsErr must be a nonnegative integer");
	if (!counter(steadySessionsLost))
		reasons.push("steady sessionsLost must be a nonnegative integer");
	if (!lifecycleClean) reasons.push("all 16 shard lifecycles must be clean");

	if (reasons.length > 0) {
		return {
			schema: "g6-c32-capacity-rung/1",
			rung: counter(rung) ? rung : 0,
			status: "INCOMPLETE",
			reasons,
			gradeGate: grade?.gate ?? null,
			serverUdpTotal,
			generatorUdpTotal,
			sessionsErr: counter(sessionsErr) ? sessionsErr : null,
			steadySessionsLost: counter(steadySessionsLost)
				? steadySessionsLost
				: null,
			lifecycleClean,
		};
	}
	const checkedServerUdpTotal = serverUdpTotal as UdpTotals;
	const checkedGeneratorUdpTotal = generatorUdpTotal as UdpTotals;
	const checkedRung = rung as number;
	const checkedSessionsErr = sessionsErr as number;
	const checkedSteadySessionsLost = steadySessionsLost as number;
	const overflow = [checkedServerUdpTotal, checkedGeneratorUdpTotal].some(
		(total) => udpFields.some((field) => total[field] > 0),
	);
	const quality =
		grade?.gate !== "PASS" ||
		checkedSessionsErr !== 0 ||
		checkedSteadySessionsLost !== 0;
	return {
		schema: "g6-c32-capacity-rung/1",
		rung: checkedRung,
		status: overflow
			? "UNCLEAN_OVERFLOW"
			: quality
				? "UNCLEAN_QUALITY"
				: "CLEAN",
		reasons: overflow
			? ["positive host UDP error delta"]
			: quality
				? ["registered grade or strict session criterion failed"]
				: [],
		gradeGate: grade?.gate ?? null,
		serverUdpTotal: checkedServerUdpTotal,
		generatorUdpTotal: checkedGeneratorUdpTotal,
		sessionsErr: checkedSessionsErr,
		steadySessionsLost: checkedSteadySessionsLost,
		lifecycleClean,
	};
}

function arg(name: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index === -1 ? undefined : process.argv[index + 1];
	if (!value) throw new Error(`--${name} is required`);
	return value;
}

if (import.meta.main) {
	const artifactErrors: string[] = [];
	const parse = (name: string): unknown => {
		const path = arg(name);
		try {
			return JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			const detail =
				error instanceof SyntaxError
					? "malformed"
					: (error as NodeJS.ErrnoException).code === "ENOENT"
						? "missing"
						: "unreadable";
			artifactErrors.push(`${name} artifact is ${detail}`);
			return null;
		}
	};
	const decision = evaluateCapacityRung({
		rung: Number(arg("rung")),
		producerStatus: Number(arg("producer-status")),
		extractMmoStatus: Number(arg("extract-mmo-status")),
		extractSteerStatus: Number(arg("extract-steer-status")),
		gradeStatus: Number(arg("grade-status")),
		scan: parse("scan"),
		diagnostic: parse("diagnostic"),
		report: parse("report"),
		grade: parse("grade"),
		artifactErrors,
	});
	writeFileSync(arg("out"), `${JSON.stringify(decision, null, 2)}\n`);
	console.log(JSON.stringify(decision));
}
