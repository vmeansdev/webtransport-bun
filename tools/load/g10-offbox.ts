/**
 * How G10's conductor reaches the Mac that holds the subscriber fleet.
 *
 * The interface is ticket 29's — `tools/offbox/mac-generator-entry.sh`, on
 * `prep/mac-generator-01` — and it is not a shape a caller may improvise,
 * because the script *refuses* rather than warns. Every refusal it makes is
 * mirrored here as a check the conductor performs before it spawns anything, so
 * a mistake surfaces as a sentence about the candidate SHA rather than as exit
 * status 3 six frames down inside an ssh channel.
 *
 * The script's refusals, in its own order:
 *
 * | refusal | exit | mirrored by |
 * |---|---|---|
 * | unknown argument | 3 | `offboxInvocation` emits only flags the script parses |
 * | `--candidate` missing | 3 | `assertCandidate` |
 * | `--candidate` not lowercase hex | 3 | `assertCandidate` |
 * | `--candidate` not 40 characters | 3 | `assertCandidate` |
 * | no clone, dirty clone, unreachable candidate, failed build | 3 | remote-only |
 * | watchdog fired | 4 | `offboxDeadlineSeconds` sizes the deadline |
 *
 * **One refusal is not yet satisfiable, and this module states it rather than
 * papering over it.** The entry script hard-codes `load-client` as the binary it
 * builds and runs. G10's far end is `broadcast-client`, so the invocation below
 * carries `--bin broadcast-client`, which the script as it stands on
 * `prep/mac-generator-01` rejects as an unknown argument. Ticket 29 owes that
 * flag before this gate can dispatch off-box; the registration's §11b carries
 * the row. Emitting the flag is deliberate: an invocation that silently omitted
 * it would build and run the *wrong binary* on the Mac and produce a report the
 * conductor cannot parse, which is a far worse failure than a loud exit 3.
 */

/** Everything the Rust subscriber role needs, in the order it parses them. */
export type SubscriberArgs = {
	url: string;
	sessions: number;
	probeCohort: number;
	probeHz: number;
	payloadBytes: number;
	rate: number;
	seconds: number;
};

export function subscriberArgs(args: SubscriberArgs): string[] {
	return [
		"--url",
		args.url,
		"--sessions",
		String(args.sessions),
		"--probe-cohort",
		String(args.probeCohort),
		"--probe-hz",
		String(args.probeHz),
		"--payload-bytes",
		String(args.payloadBytes),
		"--rate",
		String(args.rate),
		"--seconds",
		String(args.seconds),
	];
}

/**
 * The script's own rule, restated: a full 40-character lowercase object name,
 * never a ref and never an abbreviation. The effort's candidate rule is that
 * SHAs come from `git rev-parse`, and accepting a branch name here would let the
 * generator drift from the tree the gate is stamped against.
 */
export function assertCandidate(candidate: string): string {
	if (candidate === "") {
		throw new Error(
			"g10-offbox: G10_CANDIDATE is required for an off-box run — " +
				"mac-generator-entry.sh refuses without --candidate (exit 3)",
		);
	}
	if (!/^[0-9a-f]{40}$/.test(candidate)) {
		throw new Error(
			`g10-offbox: candidate '${candidate}' is not a full 40-character ` +
				"lowercase sha; mac-generator-entry.sh refuses it (exit 3)",
		);
	}
	return candidate;
}

/**
 * The watchdog deadline, in seconds. It has to cover the establish ramp, the
 * steady window and the client's own drain grace, with margin — a watchdog that
 * fires mid-window destroys the rung and surfaces as exit 4, which the rerun
 * policy reads as an infra fault rather than as a result.
 */
export function offboxDeadlineSeconds(
	windowSeconds: number,
	establishTimeoutSeconds: number,
	drainGraceSeconds = 10,
): number {
	return Math.ceil(
		(windowSeconds + establishTimeoutSeconds + drainGraceSeconds) * 1.5,
	);
}

export type OffboxInvocation = { cmd: string; args: string[] };

/**
 * The ssh invocation, or the local binary when `ssh` is empty — which §11a
 * records as a wiring check that can never be a G10 result.
 */
export function offboxInvocation(options: {
	ssh: string;
	candidate: string;
	deadlineSeconds: number;
	localBin: string;
	subscriber: SubscriberArgs;
}): OffboxInvocation {
	const args = subscriberArgs(options.subscriber);
	if (options.ssh === "") return { cmd: options.localBin, args };
	return {
		cmd: "ssh",
		args: [
			"-o",
			"BatchMode=yes",
			options.ssh,
			"tools/offbox/mac-generator-entry.sh",
			"--bin",
			"broadcast-client",
			"--candidate",
			assertCandidate(options.candidate),
			"--deadline",
			String(options.deadlineSeconds),
			"--",
			...args,
		],
	};
}

/**
 * The provenance lines the entry script prints on stdout. The conductor folds
 * them into its artifact so a run says which tree the generator came from —
 * the whole reason ticket 29's script exists, since the Mac builds its own
 * binary and "which tree" stops being obvious the moment it does.
 */
export function parseMacgenLine(line: string): Record<string, string> | null {
	const match = line.match(/^macgen: (.*)$/);
	if (!match?.[1]) return null;
	const fields: Record<string, string> = {};
	for (const token of match[1].split(/\s+/)) {
		const eq = token.indexOf("=");
		if (eq > 0) fields[token.slice(0, eq)] = token.slice(eq + 1);
	}
	return Object.keys(fields).length > 0 ? fields : null;
}
