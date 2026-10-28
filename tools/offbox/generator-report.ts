/**
 * Reading a remote generator's run back off an ssh channel.
 *
 * On-box, the harness spawns `load-client` itself and knows everything about it:
 * which binary, which tree, which host. Off-box it knows none of that — it has a
 * pipe with some text in it. Every fact the on-box harness got for free has to
 * be carried explicitly, and the honesty floor is the sharpest case: the floor
 * arm measures the *generator's* own schedule lag, so an off-box gate that reads
 * its floor from a co-resident process is measuring the wrong machine. This
 * module is what makes the floor arm a statement about the Mac.
 *
 * It deliberately does not decode histograms. The percentile machinery lives
 * with the gate (`latency-histogram.ts` / `latency-ab-classify.ts`) and is
 * already tested there; duplicating it would create a second answer to the same
 * question. What is missing off-box is provenance and transport, so that is all
 * this does: the `scheduleLag` blob comes back untouched after being validated
 * by the existing `LatencyHistogram.fromJson`, ready for the gate to read.
 */

import { G6_CLOSEOUT_SPEC_ID, G6_CLOSEOUT_SPEC_PATH } from "../load/g6-plan.ts";
import {
	LatencyHistogram,
	type LatencyHistogramJson,
} from "../load/latency-histogram.ts";

/** Provenance lines `mac-generator-entry.sh` prints before the run. */
export type GeneratorProvenance = {
	host: string | null;
	arch: string | null;
	os: string | null;
	/** The SHA the harness asked for. */
	candidate: string | null;
	/** The SHA the generator actually checked out. */
	head: string | null;
	dirty: boolean | null;
	binarySha256: string | null;
	rustc: string | null;
	buildSeconds: number | null;
	/** Set when the watchdog killed the run instead of load-client exiting. */
	watchdogFired: boolean;
	exitCode: number | null;
};

export type GeneratorReport = {
	provenance: GeneratorProvenance;
	/** Legacy `latency-json` or the retained MMO envelope, passed through verbatim. */
	latencyJson: unknown | null;
	schema: string | null;
	startedAt: string | null;
	preRegistration: { id: string; path: string; sha256: string } | null;
	historicalOnly: boolean;
	sessionsOk: number | null;
	sessionsErr: number | null;
	datagramsSent: number | null;
	datagramsErr: number | null;
	datagramsReceived: number | null;
	/** Window the generator actually offered load over, from the retained report. */
	driveWindowSec: number | null;
	/** Connected/driving sessions as the transcript explicitly reported them. */
	sessionsDriving: number | null;
	connectConcurrency: number | null;
	connectRatePerSec: number | null;
	connectStarts: {
		offered: number;
		achieved: number;
		achievedRatePerSec: number | null;
	} | null;
	fixedSourcePortBase: number | null;
	bindDefault: boolean | null;
	endpointSourceAddresses: string[] | null;
	/** Everything that stopped this from being a usable generator observation. */
	problems: string[];
};

function num(text: string, re: RegExp): number | null {
	const match = text.match(re);
	return match?.[1] !== undefined ? Number(match[1]) : null;
}

function str(text: string, re: RegExp): string | null {
	return text.match(re)?.[1] ?? null;
}

type JsonMap = Record<string, unknown>;

type ParsedMmoReport = {
	latencyJson: JsonMap;
	schema: string;
	startedAt: string | null;
	preRegistration: { id: string; path: string; sha256: string } | null;
	historicalOnly: boolean;
	sessionsOk: number;
	sessionsErr: number;
	datagramsSent: number;
	datagramsErr: number;
	datagramsReceived: number;
	driveWindowSec: number;
	sessionsDriving: number;
	connectConcurrency: number | null;
	connectRatePerSec: number | null;
	connectStarts: {
		offered: number;
		achieved: number;
		achievedRatePerSec: number | null;
	} | null;
	fixedSourcePortBase: number | null;
	bindDefault: boolean | null;
	endpointSourceAddresses: string[] | null;
};

function jsonMap(value: unknown): JsonMap | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonMap)
		: null;
}

function jsonNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function jsonFieldNumber(obj: JsonMap | null, key: string): number | null {
	return obj ? jsonNumber(obj[key]) : null;
}

function jsonStringArray(value: unknown): string[] | null {
	return Array.isArray(value) &&
		value.every((entry) => typeof entry === "string")
		? value
		: null;
}

function scheduleLagCount(latencyJson: unknown): number | null {
	const root = jsonMap(latencyJson);
	const schema = root?.schema;
	if (schema === "mmo-client/2") {
		return jsonFieldNumber(
			jsonMap(jsonMap(jsonMap(root?.windows)?.steady)?.scheduleLag),
			"count",
		);
	}
	return jsonFieldNumber(jsonMap(jsonMap(root)?.scheduleLag), "count");
}

function parseMmoClientEnvelope(
	json: unknown,
	expectedPreRegistrationSha256?: string,
): ParsedMmoReport | string {
	const root = jsonMap(json);
	if (root?.schema === "mmo-client/1") {
		if (root.role !== "realm") {
			return "mmo-client floor report role must be realm";
		}

		const scheduleLag = jsonMap(root.scheduleLag);
		const realm = jsonMap(root.realm);
		const config = jsonMap(root.config);

		const sessionsRequested = jsonFieldNumber(root, "sessionsRequested");
		const sessionsOk = jsonFieldNumber(root, "sessionsOk");
		const sessionsErr = jsonFieldNumber(root, "sessionsErr");
		const datagramsSent = jsonFieldNumber(realm, "sent");
		const datagramsErr = jsonFieldNumber(realm, "sendErr");
		const driveWindowSec = jsonFieldNumber(config, "steadySec");
		const scheduleLagVersion = jsonFieldNumber(scheduleLag, "version");
		const scheduleLagSamples = jsonFieldNumber(scheduleLag, "count");
		const rxSnapshot = jsonFieldNumber(realm, "rxSnapshot");
		const rxAck = jsonFieldNumber(realm, "rxAck");
		const rxRaid = jsonFieldNumber(realm, "rxRaid");
		const rxOther = jsonFieldNumber(realm, "rxOther");
		const rxUnstamped = jsonFieldNumber(realm, "rxUnstamped");

		if (
			sessionsRequested === null ||
			sessionsOk === null ||
			sessionsErr === null ||
			datagramsSent === null ||
			datagramsErr === null ||
			driveWindowSec === null ||
			scheduleLagVersion === null ||
			scheduleLagSamples === null ||
			rxSnapshot === null ||
			rxAck === null ||
			rxRaid === null ||
			rxOther === null ||
			rxUnstamped === null
		) {
			return "mmo-client json did not match schema mmo-client/1 floor shape";
		}
		try {
			LatencyHistogram.fromJson(scheduleLag as LatencyHistogramJson);
		} catch (err) {
			return `mmo-client scheduleLag did not match LatencyHistogramJson: ${String(err)}`;
		}

		return {
			latencyJson: root,
			schema: "mmo-client/1",
			startedAt: null,
			preRegistration: null,
			historicalOnly: true,
			sessionsOk,
			sessionsErr,
			datagramsSent,
			datagramsErr,
			datagramsReceived: rxSnapshot + rxAck + rxRaid + rxOther + rxUnstamped,
			driveWindowSec,
			sessionsDriving: sessionsRequested === 0 ? 0 : sessionsOk,
			connectConcurrency: null,
			connectRatePerSec: null,
			connectStarts: null,
			fixedSourcePortBase: null,
			bindDefault: null,
			endpointSourceAddresses: null,
		};
	}
	if (root?.schema !== "mmo-client/2") {
		return "mmo-client json did not match schema mmo-client/1 or mmo-client/2 floor shape";
	}
	if (root.role !== "realm") {
		return "mmo-client floor report role must be realm";
	}
	const startedAt =
		typeof root.startedAt === "string" && root.startedAt.length > 0
			? root.startedAt
			: null;
	const preRegistration = jsonMap(root.preRegistration);
	const windows = jsonMap(root.windows);
	const steady = jsonMap(windows?.steady);
	const steadyDrain = jsonMap(windows?.steadyDrain);
	const scheduleLag = jsonMap(steady?.scheduleLag);
	const config = jsonMap(root.config);
	const client = jsonMap(root.client);
	const connectStartsObject = jsonMap(root.connectStarts);

	const sessionsRequested = jsonFieldNumber(root, "sessionsRequested");
	const sessionsOk = jsonFieldNumber(root, "sessionsOk");
	const sessionsErr = jsonFieldNumber(root, "sessionsErr");
	const datagramsSent = jsonFieldNumber(steady, "sent");
	const datagramsErr = jsonFieldNumber(steady, "sendErr");
	const driveWindowSec = jsonFieldNumber(config, "steadySec");
	const scheduleLagDue = jsonFieldNumber(steady, "scheduleTicksDue");
	const scheduleLagFired = jsonFieldNumber(steady, "scheduleTicksFired");
	const scheduleLagSkipped = jsonFieldNumber(steady, "scheduleTicksSkipped");
	const scheduleLagUnpresented = jsonFieldNumber(
		steady,
		"scheduleTicksUnpresented",
	);
	const scheduleLagReconciled = steady?.scheduleTicksReconciled;
	const scheduleLagSamples = jsonFieldNumber(scheduleLag, "count");
	const rxSnapshot = jsonFieldNumber(steadyDrain, "rxSnapshot");
	const rxAck = jsonFieldNumber(steadyDrain, "rxAck");
	const rxRaid = jsonFieldNumber(steadyDrain, "rxRaid");
	const rxOther = jsonFieldNumber(steadyDrain, "rxOther");
	const rxUnstamped = jsonFieldNumber(steadyDrain, "rxUnstamped");
	const connectConcurrency = jsonFieldNumber(root, "connectConcurrency");
	const connectRatePerSec = jsonFieldNumber(root, "connectRatePerSec");
	const connectStartsOffered = jsonFieldNumber(connectStartsObject, "offered");
	const connectStartsAchieved = jsonFieldNumber(
		connectStartsObject,
		"achieved",
	);
	const connectStartsAchievedRate = jsonFieldNumber(
		connectStartsObject,
		"achievedRatePerSec",
	);
	const connectStarts =
		connectStartsOffered === null || connectStartsAchieved === null
			? null
			: {
					offered: connectStartsOffered,
					achieved: connectStartsAchieved,
					achievedRatePerSec: connectStartsAchievedRate,
				};
	const fixedSourcePortBase = jsonFieldNumber(config, "fixedSourcePortBase");
	const bindDefault =
		typeof config?.bindDefault === "boolean" ? config.bindDefault : null;
	const endpointSourceAddresses = jsonStringArray(
		client?.endpointSourceAddresses,
	);

	if (
		startedAt === null ||
		typeof preRegistration?.id !== "string" ||
		typeof preRegistration?.path !== "string" ||
		typeof preRegistration?.sha256 !== "string" ||
		sessionsRequested === null ||
		sessionsOk === null ||
		sessionsErr === null ||
		datagramsSent === null ||
		datagramsErr === null ||
		driveWindowSec === null ||
		scheduleLagDue === null ||
		scheduleLagFired === null ||
		scheduleLagSkipped === null ||
		scheduleLagUnpresented === null ||
		scheduleLagSamples === null ||
		rxSnapshot === null ||
		rxAck === null ||
		rxRaid === null ||
		rxOther === null ||
		rxUnstamped === null
	) {
		return "mmo-client json did not match schema mmo-client/2 floor shape";
	}
	if (preRegistration.id !== G6_CLOSEOUT_SPEC_ID) {
		return `mmo-client preregistration id must be ${G6_CLOSEOUT_SPEC_ID}`;
	}
	if (preRegistration.path !== G6_CLOSEOUT_SPEC_PATH) {
		return `mmo-client preregistration path must be ${G6_CLOSEOUT_SPEC_PATH}`;
	}
	if (!/^[0-9a-f]{64}$/i.test(preRegistration.sha256)) {
		return "mmo-client preregistration sha256 must be 64 hex chars";
	}
	if (
		expectedPreRegistrationSha256 &&
		preRegistration.sha256 !== expectedPreRegistrationSha256
	) {
		return `mmo-client preregistration sha256 ${preRegistration.sha256} did not match expected ${expectedPreRegistrationSha256}`;
	}
	if (scheduleLagReconciled !== true) {
		return "mmo-client steady window scheduleTicksReconciled must be true";
	}
	// Recomputed from the raw counters, never trusted from the boolean: every
	// due tick is fired, skipped, or measured as never-presented at the
	// window-close boundary.
	if (
		scheduleLagDue !==
		scheduleLagFired + scheduleLagSkipped + scheduleLagUnpresented
	) {
		return "mmo-client steady window schedule ledger did not reconcile from raw counters";
	}
	if (scheduleLagSamples !== scheduleLagFired) {
		return "mmo-client steady window scheduleLag count did not match scheduleTicksFired";
	}
	try {
		LatencyHistogram.fromJson(scheduleLag as LatencyHistogramJson);
	} catch (err) {
		return `mmo-client scheduleLag did not match LatencyHistogramJson: ${String(err)}`;
	}

	return {
		latencyJson: root,
		schema: "mmo-client/2",
		startedAt,
		preRegistration: {
			id: preRegistration.id,
			path: preRegistration.path,
			sha256: preRegistration.sha256,
		},
		historicalOnly: false,
		sessionsOk,
		sessionsErr,
		datagramsSent,
		datagramsErr,
		datagramsReceived: rxSnapshot + rxAck + rxRaid + rxOther + rxUnstamped,
		driveWindowSec,
		sessionsDriving: sessionsRequested === 0 ? 0 : sessionsOk,
		connectConcurrency,
		connectRatePerSec,
		connectStarts,
		fixedSourcePortBase,
		bindDefault,
		endpointSourceAddresses,
	};
}

/**
 * Parse one remote generator run.
 *
 * `expectedCandidate` is not optional in practice: without it the head/candidate
 * agreement cannot be checked from outside, and "the generator ran some tree"
 * is not a fact a gate can stamp.
 */
export function parseGeneratorReport(
	stdout: string,
	expectedCandidate?: string,
	expectedPreRegistrationSha256?: string,
): GeneratorReport {
	const problems: string[] = [];

	const provenance: GeneratorProvenance = {
		host: str(stdout, /^macgen: host=(\S+)/m),
		arch: str(stdout, /^macgen: host=\S+ arch=(\S+)/m),
		os: str(stdout, /^macgen: host=\S+ arch=\S+ os=(\S+)/m),
		candidate: str(stdout, /^macgen: clone=\S+ candidate=([0-9a-f]{40})/m),
		head: str(stdout, /^macgen: head=([0-9a-f]{40})/m),
		dirty: /^macgen: head=\S+ dirty=no\b/m.test(stdout)
			? false
			: /^macgen: head=\S+ dirty=yes\b/m.test(stdout)
				? true
				: null,
		binarySha256: str(stdout, /^macgen: binary=\S+ sha256=([0-9a-f]{64})/m),
		rustc: str(stdout, /^macgen: rustc=(\S+)/m),
		buildSeconds: num(
			stdout,
			/^macgen: head=\S+ dirty=\S+ build=\S+ buildSec=(\d+)/m,
		),
		watchdogFired: /^macgen: exit=watchdog\b/m.test(stdout),
		exitCode: num(stdout, /^macgen: exit=(\d+)\s*$/m),
	};

	if (provenance.host === null) {
		problems.push("no macgen provenance header — the entrypoint did not run");
	}
	if (provenance.head === null) {
		problems.push("generator reported no checked-out head");
	}
	if (provenance.binarySha256 === null) {
		problems.push("generator reported no binary hash");
	}
	if (provenance.dirty === true) {
		problems.push(
			"generator ran from a dirty clone — the binary matches no SHA",
		);
	}
	if (provenance.watchdogFired) {
		problems.push(
			"generator was killed by its watchdog — the run is incomplete",
		);
	}
	if (provenance.exitCode !== null && provenance.exitCode !== 0) {
		problems.push(`generator exited ${provenance.exitCode}`);
	}
	if (expectedCandidate !== undefined) {
		if (provenance.head !== null && provenance.head !== expectedCandidate) {
			problems.push(
				`generator ran ${provenance.head}, gate is stamped against ${expectedCandidate}`,
			);
		}
		if (
			provenance.candidate !== null &&
			provenance.candidate !== expectedCandidate
		) {
			problems.push(
				`generator was asked for ${provenance.candidate}, gate is stamped against ${expectedCandidate}`,
			);
		}
	}

	let latencyJson: unknown | null = null;
	let schema: string | null = null;
	let startedAt: string | null = null;
	let preRegistration: GeneratorReport["preRegistration"] = null;
	let historicalOnly = false;
	let sessionsOk = num(stdout, /^load-client: sessions ok=(\d+)/m);
	let sessionsErr = num(stdout, /^load-client: sessions ok=\d+ err=(\d+)/m);
	let datagramsSent = num(stdout, /^load-client: datagrams sent=(\d+)/m);
	let datagramsErr = num(stdout, /^load-client: datagrams sent=\d+ err=(\d+)/m);
	let datagramsReceived = num(
		stdout,
		/^load-client: datagrams received=(\d+)/m,
	);
	let driveWindowSec: number | null = null;
	let sessionsDriving: number | null = null;
	let connectConcurrency: number | null = null;
	let connectRatePerSec: number | null = null;
	let connectStarts: GeneratorReport["connectStarts"] = null;
	let fixedSourcePortBase: number | null = null;
	let bindDefault: boolean | null = null;
	let endpointSourceAddresses: string[] | null = null;

	const latencyLine = stdout.match(/^load-client: latency-json (\{.*\})\s*$/m);
	const mmoLine = stdout.match(/^mmo-client: json (\{.*\})\s*$/m);
	if (latencyLine?.[1] && mmoLine?.[1]) {
		problems.push(
			"generator transcript is ambiguous — both load-client latency-json and mmo-client json were present",
		);
		try {
			JSON.parse(latencyLine[1]);
		} catch (err) {
			problems.push(`latency-json did not parse: ${String(err)}`);
		}
		try {
			const parsed = parseMmoClientEnvelope(
				JSON.parse(mmoLine[1]),
				expectedPreRegistrationSha256,
			);
			if (typeof parsed === "string") problems.push(parsed);
		} catch (err) {
			problems.push(`mmo-client json did not parse: ${String(err)}`);
		}
	} else if (latencyLine?.[1]) {
		try {
			latencyJson = JSON.parse(latencyLine[1]);
		} catch (err) {
			problems.push(`latency-json did not parse: ${String(err)}`);
		}
	} else {
		if (mmoLine?.[1]) {
			try {
				const parsed = parseMmoClientEnvelope(
					JSON.parse(mmoLine[1]),
					expectedPreRegistrationSha256,
				);
				if (typeof parsed === "string") {
					problems.push(parsed);
				} else {
					latencyJson = parsed.latencyJson;
					schema = parsed.schema;
					startedAt = parsed.startedAt;
					preRegistration = parsed.preRegistration;
					historicalOnly = parsed.historicalOnly;
					sessionsOk = parsed.sessionsOk;
					sessionsErr = parsed.sessionsErr;
					datagramsSent = parsed.datagramsSent;
					datagramsErr = parsed.datagramsErr;
					datagramsReceived = parsed.datagramsReceived;
					driveWindowSec = parsed.driveWindowSec;
					sessionsDriving = parsed.sessionsDriving;
					connectConcurrency = parsed.connectConcurrency;
					connectRatePerSec = parsed.connectRatePerSec;
					connectStarts = parsed.connectStarts;
					fixedSourcePortBase = parsed.fixedSourcePortBase;
					bindDefault = parsed.bindDefault;
					endpointSourceAddresses = parsed.endpointSourceAddresses;
				}
			} catch (err) {
				problems.push(`mmo-client json did not parse: ${String(err)}`);
			}
		} else {
			problems.push("generator produced no latency-json — no floor and no RTT");
		}
	}

	const lj = latencyJson as {
		driveWindowSec?: number;
		sessionsDriving?: number;
	} | null;
	if (latencyJson !== null && driveWindowSec === null) {
		driveWindowSec = lj?.driveWindowSec ?? null;
	}
	if (latencyJson !== null && sessionsDriving === null) {
		sessionsDriving = lj?.sessionsDriving ?? null;
	}

	return {
		provenance,
		latencyJson,
		schema,
		startedAt,
		preRegistration,
		historicalOnly,
		sessionsOk,
		sessionsErr,
		datagramsSent,
		datagramsErr,
		datagramsReceived,
		driveWindowSec,
		sessionsDriving,
		connectConcurrency,
		connectRatePerSec,
		connectStarts,
		fixedSourcePortBase,
		bindDefault,
		endpointSourceAddresses,
		problems,
	};
}

/**
 * Is this report usable as the honesty floor for an off-box gate?
 *
 * Three conditions, and the third is the one that only exists off-box: the floor
 * must come from the *generator* host. A floor measured anywhere else describes
 * a machine that is not producing the load.
 */
export function floorReportIsUsable(
	report: GeneratorReport,
	expectedGeneratorHost: string,
	expectedPreRegistrationSha256?: string,
): { usable: boolean; reasons: string[] } {
	const reasons = [...report.problems];
	if (
		report.provenance.host !== null &&
		report.provenance.host !== expectedGeneratorHost
	) {
		reasons.push(
			`floor came from ${report.provenance.host}, generator is ${expectedGeneratorHost}`,
		);
	}
	if (report.latencyJson === null)
		reasons.push("no scheduleLag to read a floor from");
	if (report.historicalOnly) {
		reasons.push(
			"historical mmo-client/1 floor reports are readable but not successor-valid",
		);
	}
	if (expectedPreRegistrationSha256 !== undefined) {
		if (report.preRegistration === null) {
			reasons.push("no preregistration identity on floor report");
		} else if (
			report.preRegistration.sha256 !== expectedPreRegistrationSha256
		) {
			reasons.push(
				`floor preregistration sha256 ${report.preRegistration.sha256} did not match expected ${expectedPreRegistrationSha256}`,
			);
		}
	}
	const lagCount = scheduleLagCount(report.latencyJson);
	if (report.latencyJson !== null && lagCount !== null && lagCount <= 0) {
		reasons.push(
			"no scheduleLag samples were recorded — connected sessions did not offer load",
		);
	}
	if ((report.sessionsDriving ?? 0) === 0) {
		reasons.push(
			"no session offered load — a floor over zero sessions is not a floor",
		);
	}
	return { usable: reasons.length === 0, reasons };
}
