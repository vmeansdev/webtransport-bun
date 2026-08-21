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
 * this does: the `scheduleLag` blob comes back untouched, ready for the existing
 * `LatencyHistogram.fromJson`.
 */

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
	/** `latency-json` verbatim, for the gate's own histogram decoder. */
	latencyJson: unknown | null;
	sessionsOk: number | null;
	sessionsErr: number | null;
	datagramsSent: number | null;
	datagramsErr: number | null;
	datagramsReceived: number | null;
	/** Window the generator actually offered load over, from `latency-json`. */
	driveWindowSec: number | null;
	sessionsDriving: number | null;
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
	const latencyLine = stdout.match(/^load-client: latency-json (\{.*\})\s*$/m);
	if (latencyLine?.[1]) {
		try {
			latencyJson = JSON.parse(latencyLine[1]);
		} catch (err) {
			problems.push(`latency-json did not parse: ${String(err)}`);
		}
	} else {
		problems.push("generator produced no latency-json — no floor and no RTT");
	}

	const lj = latencyJson as {
		driveWindowSec?: number;
		sessionsDriving?: number;
	} | null;

	return {
		provenance,
		latencyJson,
		sessionsOk: num(stdout, /^load-client: sessions ok=(\d+)/m),
		sessionsErr: num(stdout, /^load-client: sessions ok=\d+ err=(\d+)/m),
		datagramsSent: num(stdout, /^load-client: datagrams sent=(\d+)/m),
		datagramsErr: num(stdout, /^load-client: datagrams sent=\d+ err=(\d+)/m),
		datagramsReceived: num(stdout, /^load-client: datagrams received=(\d+)/m),
		driveWindowSec: lj?.driveWindowSec ?? null,
		sessionsDriving: lj?.sessionsDriving ?? null,
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
	if ((report.sessionsDriving ?? 0) === 0) {
		reasons.push(
			"no session offered load — a floor over zero sessions is not a floor",
		);
	}
	return { usable: reasons.length === 0, reasons };
}
