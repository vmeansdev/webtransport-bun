/**
 * Task 14: Canonical 35-Cell Campaign Orchestrator.
 *
 * R0 keeps this official campaign entrypoint quarantined until R1 supplies a
 * validated staged trust boundary. The pure artifact builder and verifier
 * remain available to tests without publishing campaign output.
 *
 * Usage:
 *   bun tools/compare/run-campaign.ts [--scenarios all|<id,...>] [--transports both|ws|wt] [--output-dir .release-evidence/transport-comparison/<candidate>/<campaign-id>]
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	buildRunArtifact,
	trustContextForArtifact,
} from "./artifact-builder.ts";
import {
	type AdmissionCounters,
	assertSupportedPlatform,
	ComparisonCliError,
	canonicalDigest,
	classifyVerdictTuple,
	comparisonErrorCode,
	isSafeErrorCode,
	type MeasurementExecutionKey,
	type MeasurementGrantV1,
	metricContractForScenario,
	type MetricUnit,
	parseRecoveryMode,
	sealRunArtifact,
	sha256HexOfBytes,
	type Transport,
	validateFixtureOnlyEntrypoint,
	validateMeasurementGrantBinding,
	validateOfficialEntrypointContract,
	validateSupervisorAdmission,
} from "./evidence.ts";
import {
	assertOfficialComparisonIoAvailable,
	checkPromotionQuarantine,
	resolveOfficialComparisonOutputDir,
	resolveOfficialComparisonOutputFile,
	writeOfficialComparisonFile,
} from "./output-policy.ts";
import {
	CANONICAL_SCENARIO_REGISTRY,
	type RequestedImpairment,
	requestedImpairmentOf,
} from "./scenario-registry.ts";
import { type SealedMeasurement, takeMeasurementRecord } from "./stats.ts";
import {
	type ArmKind,
	type SampleProvenance,
	SCENARIO_IDS,
	type ScenarioCell,
	type ScenarioId,
} from "./types.ts";
import { verifyRunArtifact } from "./verify-artifact.ts";

export {
	ComparisonCliError,
	parseRecoveryMode,
	validateFixtureOnlyEntrypoint,
	validateOfficialEntrypointContract,
};

/**
 * The shape `runCampaign` accepts. The staged-trust fields are optional here
 * because a caller may legitimately arrive without them — and when it does,
 * `runCampaign` fails closed on the unavailable trust boundary rather than
 * inventing authority for itself.
 */
export interface CampaignArgs {
	readonly scenarios: readonly ScenarioId[];
	readonly transports: "ws" | "wt" | "both";
	readonly outputDir: string;
	readonly candidate: string;
	readonly campaignId: string;
	readonly stagedCapabilityPath?: string;
	readonly capabilityDigestSha256?: string;
	readonly lockDigestSha256?: string;
	readonly archiveDigestSha256?: string;
	readonly externalTrustBound?: string;
	readonly fixtureOnly?: boolean;
	readonly help?: boolean;
}

/**
 * What the CLI parser guarantees. In official mode every staged-trust input is
 * present; in fixture-only mode they are all empty and no official output can
 * be produced at all.
 */
export interface ValidatedCampaignArgs extends CampaignArgs {
	readonly stagedCapabilityPath: string;
	readonly capabilityDigestSha256: string;
	readonly lockDigestSha256: string;
	readonly archiveDigestSha256: string;
	readonly fixtureOnly: boolean;
}

const HEX64 = /^[0-9a-f]{64}$/u;

/**
 * Every campaign invocation must name its own trust inputs. There are no
 * environment fallbacks and no unbound defaults: an operator who cannot state
 * the candidate, campaign, staged capability, and the three digests that bind
 * them has not established authority, and the parser refuses before any I/O.
 */
export function parseCampaignArgs(
	argv: readonly string[],
): ValidatedCampaignArgs {
	// The host this process actually runs on decides platform support. A caller
	// cannot vouch for its own platform, and omitting the flag cannot skip the
	// check, so the refusal lands before any trust validation or child launch.
	assertSupportedPlatform("campaign", process.platform);

	let scenarios: ScenarioId[] = [...SCENARIO_IDS];
	let transports: "ws" | "wt" | "both" = "both";
	let outputDir: string | undefined;
	let candidate: string | undefined;
	let campaignId: string | undefined;
	let stagedCapabilityPath: string | undefined;
	let capabilityDigestSha256: string | undefined;
	let lockDigestSha256: string | undefined;
	let archiveDigestSha256: string | undefined;
	let externalTrustBound: string | undefined;
	let fixtureOnly = false;
	let help = false;

	// A flag's value is the next token only when that token is not itself a
	// flag. Swallowing "--fixture-only" as the value of "--staged-capability"
	// silently turned a fixture invocation into an official one, so a missing
	// value is a parse error rather than a borrowed neighbour.
	let cursor = 0;
	const takeValue = (): string => {
		const value = argv[++cursor];
		if (value === undefined || value.startsWith("--")) {
			throw new ComparisonCliError("campaign", "CAMPAIGN_ARG_VALUE_MISSING");
		}
		return value;
	};

	for (cursor = 0; cursor < argv.length; cursor++) {
		const arg = argv[cursor]!;
		if (arg === "--platform") {
			// The declared platform is still validated, so a caller cannot name an
			// unsupported host, but it is never what the check is decided on.
			assertSupportedPlatform("campaign", takeValue());
		} else if (arg === "--fixture-only") {
			fixtureOnly = true;
		} else if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--staged-capability") {
			stagedCapabilityPath = takeValue();
		} else if (arg === "--capability-digest") {
			capabilityDigestSha256 = takeValue();
		} else if (arg === "--lock-digest") {
			lockDigestSha256 = takeValue();
		} else if (arg === "--archive-digest") {
			archiveDigestSha256 = takeValue();
		} else if (arg === "--external-trust-bound") {
			externalTrustBound = takeValue();
		} else if (arg === "--scenarios") {
			const val = takeValue();
			if (val === "all") {
				scenarios = [...SCENARIO_IDS];
			} else {
				const list = val.split(",").map((s) => s.trim()) as ScenarioId[];
				for (const s of list) {
					if (!SCENARIO_IDS.includes(s)) {
						throw new ComparisonCliError(
							"campaign",
							"CAMPAIGN_ARG_INVALID_SCENARIO",
						);
					}
				}
				scenarios = list;
			}
		} else if (arg === "--transports") {
			const val = takeValue();
			if (val !== "ws" && val !== "wt" && val !== "both") {
				throw new ComparisonCliError(
					"campaign",
					"CAMPAIGN_ARG_INVALID_TRANSPORTS",
				);
			}
			transports = val;
		} else if (arg === "--output-dir") {
			outputDir = takeValue();
		} else if (arg === "--candidate") {
			candidate = takeValue();
		} else if (arg === "--campaign-id") {
			campaignId = takeValue();
		} else {
			throw new ComparisonCliError("campaign", "CAMPAIGN_ARG_UNKNOWN");
		}
	}

	if (help) {
		// `--help` used to fall through to the required-argument loop below, so
		// asking for help exited 1 with CAMPAIGN_ARG_MISSING_CANDIDATE and the help
		// text was unreachable. Help asks for no authority and gets none: the
		// identity fields stay empty and nothing downstream can promote with them.
		return {
			scenarios,
			transports,
			candidate: "",
			campaignId: "",
			fixtureOnly: false,
			stagedCapabilityPath: "",
			capabilityDigestSha256: "",
			lockDigestSha256: "",
			archiveDigestSha256: "",
			externalTrustBound: undefined,
			outputDir: "",
			help: true,
		};
	}

	if (fixtureOnly) {
		// A package script is a developer convenience. It cannot carry official
		// authority, and the refusal happens here, before any filesystem work.
		// Every official input is refused, not just the two that name a digest:
		// an archive digest, a candidate, or a campaign identity is authority a
		// fixture run has no business carrying.
		const gate = validateFixtureOnlyEntrypoint({
			fixtureOnly: true,
			authoritySha256:
				capabilityDigestSha256 ?? lockDigestSha256 ?? archiveDigestSha256,
			rootPath:
				stagedCapabilityPath ??
				outputDir ??
				candidate ??
				campaignId ??
				externalTrustBound,
		});
		if (gate.ok !== true) throw new ComparisonCliError("campaign", gate.code);
		// The gate above refuses every official locator, so the identity a fixture
		// run carries is a fixed label rather than anything the caller supplied.
		return {
			scenarios,
			transports,
			candidate: "fixture-candidate",
			campaignId: "fixture-campaign",
			fixtureOnly: true,
			stagedCapabilityPath: "",
			capabilityDigestSha256: "",
			lockDigestSha256: "",
			archiveDigestSha256: "",
			externalTrustBound: undefined,
			outputDir: "",
			help,
		};
	}

	for (const [value, code] of [
		[candidate, "CAMPAIGN_ARG_MISSING_CANDIDATE"],
		[campaignId, "CAMPAIGN_ARG_MISSING_CAMPAIGN"],
		[stagedCapabilityPath, "CAMPAIGN_ARG_MISSING_STAGED_CAPABILITY"],
		[capabilityDigestSha256, "CAMPAIGN_ARG_MISSING_CAPABILITY_DIGEST"],
		[lockDigestSha256, "CAMPAIGN_ARG_MISSING_LOCK_DIGEST"],
		[archiveDigestSha256, "CAMPAIGN_ARG_MISSING_ARCHIVE_DIGEST"],
	] as const) {
		if (!value) throw new ComparisonCliError("campaign", code);
	}

	for (const [value, code] of [
		[capabilityDigestSha256, "CAMPAIGN_ARG_INVALID_CAPABILITY_DIGEST"],
		[lockDigestSha256, "CAMPAIGN_ARG_INVALID_LOCK_DIGEST"],
		[archiveDigestSha256, "CAMPAIGN_ARG_INVALID_ARCHIVE_DIGEST"],
	] as const) {
		if (!HEX64.test(value!)) throw new ComparisonCliError("campaign", code);
	}

	return {
		scenarios,
		transports,
		candidate: candidate!,
		campaignId: campaignId!,
		stagedCapabilityPath: stagedCapabilityPath!,
		capabilityDigestSha256: capabilityDigestSha256!,
		lockDigestSha256: lockDigestSha256!,
		archiveDigestSha256: archiveDigestSha256!,
		fixtureOnly: false,
		externalTrustBound,
		outputDir: resolveOfficialComparisonOutputDir({
			candidate: candidate!,
			campaignId: campaignId!,
			outputDir,
		}),
		help,
	};
}

export function printCampaignHelp(): void {
	console.log(`
WebTransport vs WebSocket Comparison Campaign Runner

Usage:
  bun tools/compare/run-campaign.ts [options]

Options:
  --scenarios <list|all>    Comma-separated scenario IDs or 'all' (default: all)
  --transports <ws|wt|both> Transports to evaluate (default: both)
  --candidate <id>          Candidate identity used in the official output path
  --campaign-id <id>        Campaign identity used in the official output path
  --output-dir <dir>        Official output directory (default: .release-evidence/transport-comparison/<candidate>/<campaign-id>)
  --staged-capability <p>   Staged capability descriptor the supervisor prepared
  --capability-digest <hex> SHA-256 of the staged capability
  --lock-digest <hex>       SHA-256 of the campaign lock
  --archive-digest <hex>    SHA-256 of the source archive
  --external-trust-bound <s> External trust boundary; evidence stays quarantined without one
  --platform <name>         Declared platform, validated in addition to the running host
  --fixture-only            Developer run: validates, publishes nothing
  --help, -h                Show this help message

An official run must name the candidate, the campaign, the staged capability,
and all three digests. There are no environment fallbacks.
`);
}

/** What one measured arm produced. */
export interface ArmMeasurement {
	/**
	 * What `samples` are in, stated by whoever took them.
	 *
	 * Required, because the alternative is what this type used to permit:
	 * `buildRunArtifact` labels the series `unit: contract.unit` from the
	 * cell's primary metric contract, so an arm that arrived without its own
	 * unit was published in whichever one its cell happened to name. The driver
	 * produces per-message round-trip milliseconds for every scenario, and the
	 * cells it can plan all declare a rate, a throughput or a percentage, so
	 * every honest leg on a plannable cell was sealed under a unit it was not
	 * measured in.
	 *
	 * `buildMeasuredArmArtifact` refuses a measurement whose unit is not the
	 * one its cell publishes. There is no conversion here: an arm that states
	 * the wrong unit has measured the wrong thing, and the artifact is the
	 * wrong place to discover it.
	 */
	readonly sampleUnit: MetricUnit;
	readonly samples: number[];
	readonly percentiles: { p1: number; p50: number; p95: number; p99: number };
	readonly ledger: {
		readonly attempted: number;
		readonly queued: number;
		readonly serverObserved: number;
		readonly acknowledged: number;
		readonly delivered: number;
		readonly dropped: number;
		readonly expired: number;
		/**
		 * Bytes this arm put on the wire that the scenario did not ask for.
		 *
		 * Optional because an arm may be stated by a caller that measured
		 * nothing else either; the adapters always report it.
		 */
		readonly harnessOverheadBytes?: number;
		/**
		 * The latency histogram this arm observed.
		 *
		 * Optional in the type and effectively required in practice, which is
		 * worth stating rather than leaving to be discovered. `buildRunArtifact`
		 * falls back to `boundaries:[1,2,4], counts:[1,0,0]` -- the fabricated
		 * default `compare.ts` was written to catch -- and the comparator
		 * refuses an arm whose counts do not sum to its sample count. So a
		 * measured arm that does not report one is assembled and sealed and
		 * then refused at comparison with `EVIDENCE_LEDGER_INVALID`, for every
		 * sample count except one.
		 *
		 * The driver does not produce this today. That is a gap in the honest
		 * path, not in this type, and it is recorded here because this is where
		 * the value has to arrive from.
		 */
		readonly histogram?: {
			readonly unit: "bytes" | "count" | "ms" | "ratio" | "Mbps" | "percent";
			readonly boundaries: readonly number[];
			readonly counts: readonly number[];
		};
	};
	readonly telemetry: {
		readonly mac: { cpuPercent: number; rssBytes: number };
		readonly linux: { cpuPercent: number; rssBytes: number };
	};
	readonly admissionCounters: AdmissionCounters;
	/**
	 * Where these samples came from. Required, and checked.
	 *
	 * This is the field that makes a fabricated measurement fail rather than
	 * merely be absent. A producer that returns literals has no driver run to
	 * name, no clock to cite, and no window to report, so it cannot fill this in
	 * without stating something `assertMeasurementProvenance` will catch.
	 */
	readonly provenance: SampleProvenance;
	/**
	 * The grant the supervisor issued for the execution these samples came out
	 * of, echoed back exactly as it was received.
	 *
	 * `provenance` says a recorder ran. This says *which execution* it ran for,
	 * and it is the only field here the controller did not and could not mint.
	 * Without it one honest leg answers for every cell in the campaign: the
	 * series is real, the ledger agrees with it, the window is inside a real
	 * bracket, and it is still 104 measurements that never happened.
	 */
	readonly grant: MeasurementGrantV1;
	/**
	 * The supervisor's answer, as the bytes of the `admission-receipt` frame it
	 * wrote back.
	 *
	 * `provenance` says a recorder ran. `grant` says which execution it ran
	 * for. This says the supervisor read the series, compared it against the
	 * bracket it held, and admitted it -- and it is the only field here
	 * authored outside the process the samples came from.
	 *
	 * Required, and required is the point. Phases 1 and 2 built the rules and
	 * left them with no caller: a measured arm could be assembled, sealed,
	 * ranked and published without a supervisor ever seeing it. An arm that
	 * cannot name an admission is now no artifact at all, which is the only
	 * failure mode that cannot be mistaken for evidence.
	 */
	readonly admission: Uint8Array;
}

/**
 * Every grant this process has already built an arm artifact with.
 *
 * The binding single-use record is the supervisor's registry, which holds the
 * grants it issued and cannot be reached from here. This is the controller's
 * own, and it exists for the same reason `takeMeasurementRecord` does: the
 * failure it catches -- one leg spent across a hundred and five cells -- is
 * worth catching before the campaign pays a round trip for each of them.
 */
const SPENT_GRANT_DIGESTS = new Set<string>();

/**
 * Refuse an arm whose samples this process did not watch being taken.
 *
 * The previous version of this guard checked five fields the caller supplied,
 * and the audit defeated it by supplying them. It reconstructed the deleted
 * executor verbatim -- `transport === "wt" ? 3.2 : 28.6` -- added five
 * plausible provenance fields, and published `PASS`, `ranking: wt`, a delta of
 * -25.4 ms in WT'''s favour, with no rejections at all. Every clause held. The
 * guard was asking a forger to fill in the form, and the forger could.
 *
 * So the samples are no longer taken on trust and then interrogated. They are
 * resolved. A recorder in `stats.ts` mints a token, reads the clock itself at
 * each send and each arrival, and files the resulting series under that token;
 * this function looks the token up in that record and refuses unless the
 * samples, the percentiles and the whole provenance in front of it are the ones
 * the recorder filed. A measurement built as an object literal has no token. A
 * measurement carrying a copied token has a different series. A token that has
 * already been built with is gone, so one honest leg cannot be spent across a
 * hundred and five cells.
 *
 * The stated fields are kept and still checked. They are no longer load
 * bearing on their own -- the record is -- but each one now has to agree with
 * the record, so they are corroboration rather than assertion. `Date.now` stays
 * rejected by name: it ticks at 1 ms and the deltas under comparison are tenths
 * of one, so a sample taken on it cannot support the claim the artifact makes.
 *
 * What this does not close, stated plainly: a caller may open a recorder with a
 * clock of its own and advance it as it likes. That is how the tests obtain an
 * exact latency, and it is the seam the campaign'''s own driver goes through. It
 * is a smaller hole than the one it replaces -- fabrication now means standing
 * up a clock and naming it in `provenance.clockMethod`, which travels into the
 * artifact -- but it is a hole, and the record is process-local besides, so a
 * leg measured on the other host still arrives as data. Binding that needs a
 * controller-minted nonce and a MAC over the series; this is the seam it lands
 * on.
 *
 * It lands in `buildMeasuredArmArtifact` and not in
 * `writeOfficialComparisonFile`, for three reasons. The write path throws
 * unconditionally today, so a guard there would be unreachable and untestable.
 * The forgeable thing is the artifact object, and `compare.ts` consumes those
 * without any file ever existing. And this builder is already the one seam a
 * test can reach.
 */
export function assertMeasurementProvenance(
	measurement: ArmMeasurement,
	context: {
		readonly cellId: string;
		readonly transport: Transport;
		/**
		 * The execution the campaign believes it is building. Stated by the
		 * caller that assigned it, never read out of the measurement -- taking
		 * it from the thing being checked would let the thing being checked
		 * choose which grant it is checked against.
		 */
		readonly execution: MeasurementExecutionKey;
	},
): void {
	// The cell is named in the throw site's own contract rather than in the
	// message: `ComparisonCliError` deliberately carries a bounded code and no
	// free-form detail, so a refusal cannot leak a path or a host.
	void context.cellId;
	const refuse = (code: string): never => {
		throw new ComparisonCliError("campaign", code);
	};
	const provenance = measurement.provenance as SampleProvenance | undefined;
	if (!provenance || typeof provenance !== "object")
		refuse("MEASUREMENT_PROVENANCE_MISSING");
	const stated = provenance as SampleProvenance;
	if (
		typeof stated.driverRunId !== "string" ||
		stated.driverRunId.trim().length === 0
	)
		refuse("MEASUREMENT_DRIVER_RUN_UNSTATED");
	if (
		typeof stated.clockMethod !== "string" ||
		stated.clockMethod.trim().length === 0 ||
		stated.clockMethod === "unstated" ||
		stated.clockMethod === "Date.now"
	)
		refuse("MEASUREMENT_CLOCK_UNRESOLVABLE");
	if (stated.sampleCount !== measurement.samples.length)
		refuse("MEASUREMENT_SAMPLE_COUNT_UNCORROBORATED");
	// A driver that ran and recorded nothing is a real outcome, and the artifact
	// builder already scores it BLOCKED / NO_VERDICT. Refusing it here would
	// replace that with a throw and lose the property — and it is not a
	// fabrication route either, since nothing promotable comes out of an empty
	// arm. There is simply no window to check when there were no samples.
	if (stated.sampleCount > 0) {
		if (
			!Number.isFinite(stated.firstSampleAtMs) ||
			!Number.isFinite(stated.lastSampleAtMs) ||
			stated.firstSampleAtMs <= 0 ||
			stated.lastSampleAtMs <= 0
		)
			refuse("MEASUREMENT_WINDOW_UNSTATED");
		if (stated.lastSampleAtMs < stated.firstSampleAtMs)
			refuse("MEASUREMENT_WINDOW_INVERTED");
	}
	// Then the two questions that are not statements about the measurement at
	// all, after the named clauses so that each of those keeps reporting the
	// thing it is about rather than being swallowed under one code.
	//
	// The grant goes first of the two. Both ask "did this happen", but only the
	// grant asks "for this execution", and only the grant is a question the
	// supervisor asks the same way: a leg replayed across cells is a spent
	// grant there and should be a spent grant here, not a spent token. The
	// record is process-local corroboration and reads second.
	const grantSha256 = assertGrantedExecution(
		measurement,
		context.execution,
		refuse,
	);
	const record = takeMeasurementRecord(stated.attestation);
	if (record === undefined) refuse("MEASUREMENT_ATTESTATION_UNKNOWN");
	assertRecordedMeasurement(measurement, record as SealedMeasurement, refuse);
	// Last, and last on purpose. Every clause above is a question about the
	// arm's internal consistency, and each of them names the field it is
	// about; the admission is a question about the world outside this process,
	// and it disagrees with a rewritten arm for the same reason those do. Asked
	// first it would swallow their diagnoses under one code -- an edited window
	// would report "the supervisor did not admit this" rather than "this is not
	// the series the recorder filed", which is true but is the less useful of
	// two true answers.
	assertSupervisorAdmitted(measurement, context.execution, grantSha256, refuse);
}

/**
 * Refuse an arm whose samples were not measured for the execution being built.
 *
 * The recorder's record answers "did this process watch these samples being
 * taken". It cannot answer "were they taken for *this* cell", because the
 * record is one leg's and the campaign has 768 of them; a caller holding one
 * honest sealed measurement can build with it as many times as it likes, and
 * the audit's own summary of the residual -- that the guard authenticates a
 * recorder rather than a transport -- covers this case exactly.
 *
 * The grant answers it. It was minted by the supervisor before the child
 * existed, it names the execution, and it is spendable once. What this
 * function checks is the half the controller can check: the grant names the
 * execution the campaign assigned, and this process has not already built with
 * it. What it cannot check is that the supervisor ever issued the grant --
 * that comparison needs the issuing registry, which is deliberately on the
 * other side of the pipe.
 *
 * The grant is spent by the attempt, not by the artifact that comes out of it,
 * which is the same rule `GrantRegistry::admit_payload` applies and it has a
 * consequence worth stating rather than discovering. An arm that gets this far
 * and then fails a later check -- a non-monotonic ledger, say -- is not
 * rebuildable in this process. Its second attempt is refused
 * `MEASUREMENT_GRANT_ABSENT`, which reads as though the grant were never there
 * and in fact means this process already spent it.
 *
 * That is the direction to fail in. The alternative -- spend only on the arms
 * that survive every downstream check -- hands a caller one free attempt per
 * check it can trip, against a grant the supervisor minted once. A campaign
 * whose arm is unbuildable because of a bug in its own ledger has a bug to fix;
 * a campaign that can retry an execution until one presentation sticks has no
 * single-use rule at all.
 */
function assertGrantedExecution(
	measurement: ArmMeasurement,
	execution: MeasurementExecutionKey,
	refuse: (code: string) => never,
): string {
	const binding = validateMeasurementGrantBinding({
		grant: measurement.grant,
		execution,
		spentGrantDigests: SPENT_GRANT_DIGESTS,
		atMs: Date.now(),
	});
	if (!binding.ok) refuse(binding.code);
	// Spent here, ahead of every check that follows, so that one execution gets
	// one attempt whatever becomes of it -- the rule the supervisor's registry
	// applies, in the copy that runs first.
	const grantSha256 = (binding as { readonly grantSha256: string }).grantSha256;
	SPENT_GRANT_DIGESTS.add(grantSha256);
	return grantSha256;
}

/**
 * Refuse an arm the supervisor did not admit.
 *
 * This is the check the first two phases could not make, and its absence is
 * why they refused nothing: the rules lived in a supervisor with no caller,
 * and the campaign sealed its artifacts in the process that produced them. A
 * fabricated series went from a recorder straight to a comparator, and the
 * only thing between them was a form the forger could fill in.
 *
 * Now the series has to have been presented. The receipt names the execution
 * the supervisor opened, the grant it issued for that execution, and the
 * figures it computed from the payload bytes under its own bracket -- and all
 * of those have to be the arm in front of this function.
 *
 * The honest limit, stated here rather than left to be found: this process
 * cannot tell a receipt the supervisor wrote from a well-formed one a caller
 * invented, any more than it can tell an issued grant from an invented one.
 * What has changed is what a forgery costs. It was twenty-three lines against
 * a guard that asked the forger to describe its own measurement. It is now the
 * supervisor's half of a frame protocol -- and against a campaign that gets
 * its receipts from a pipe the supervisor owns, it is the supervisor.
 */
function assertSupervisorAdmitted(
	measurement: ArmMeasurement,
	execution: MeasurementExecutionKey,
	grantSha256: string,
	refuse: (code: string) => never,
): void {
	const provenance = measurement.provenance as SampleProvenance;
	const admitted = validateSupervisorAdmission({
		receiptFrame: measurement.admission,
		execution,
		grantSha256,
		samples: measurement.samples,
		delivered: measurement.ledger.delivered,
		firstSampleAtMs: provenance.firstSampleAtMs,
		lastSampleAtMs: provenance.lastSampleAtMs,
	});
	if (!admitted.ok) refuse(admitted.code);
}

/**
 * Check a measurement against the record the recorder filed for it.
 *
 * Everything the recorder produced is compared, not just the sample series: a
 * caller that keeps the samples and rewrites the percentiles beside them has
 * changed the number the comparison ranks on, which is the only number most
 * readers of the artifact will ever look at.
 */
function assertRecordedMeasurement(
	measurement: ArmMeasurement,
	record: SealedMeasurement,
	refuse: (code: string) => never,
): void {
	const samples = measurement.samples;
	if (
		!Array.isArray(samples) ||
		samples.length !== record.samples.length ||
		samples.some((value, index) => !Object.is(value, record.samples[index]))
	) {
		refuse("MEASUREMENT_SAMPLES_UNCORROBORATED");
	}
	const percentiles = measurement.percentiles;
	for (const key of ["p1", "p50", "p95", "p99"] as const) {
		if (!Object.is(percentiles?.[key], record.percentiles[key])) {
			refuse("MEASUREMENT_PERCENTILES_UNCORROBORATED");
		}
	}
	const stated = measurement.provenance;
	const filed = record.provenance;
	if (
		stated.driverRunId !== filed.driverRunId ||
		stated.clockMethod !== filed.clockMethod ||
		stated.sampleCount !== filed.sampleCount ||
		!Object.is(stated.firstSampleAtMs, filed.firstSampleAtMs) ||
		!Object.is(stated.lastSampleAtMs, filed.lastSampleAtMs)
	) {
		refuse("MEASUREMENT_PROVENANCE_ALTERED");
	}
}

interface FlowValidation {
	readonly ok: boolean;
	readonly code?: string;
}

/** The impairment a cell injects into its own measurement, by parameter. */
export type InjectedImpairment = RequestedImpairment;

/**
 * The impairment the registry says this cell injects.
 *
 * This is `requestedImpairmentOf` and nothing else. It used to be a second
 * decoder that read only the numeric parameters, so a cell stating its
 * impairment as a named path — `bulk-one-way/delay40-loss1` — recorded a 1%
 * injected loss in its artifact and was judged as if none had been injected at
 * all. The artifact records this reading and the verdict derivation judges
 * against this reading, so a cell whose injected loss is recorded one way and
 * judged another is not a shape the code can take.
 */
export function injectedImpairmentOf(cell: ScenarioCell): InjectedImpairment {
	return requestedImpairmentOf(cell);
}

/**
 * How much of the traffic a cell injects loss into may go missing before the
 * shortfall stops being the impairment's doing.
 *
 * A datagram arm under 1% injected loss is expected to lose about 1%; a lossy
 * overlay riding TCP loses somewhat more, because a retransmitted tick can
 * arrive too stale to use — the campaign's own overlay model loses 1.2x the
 * injected rate. An arm that lost several times what was injected is measuring
 * something other than the impairment, and that is what this bound is for.
 *
 * It was 2x, which is too loose to publish: at 2x an arm that lost exactly
 * double the injected rate — a 100% attribution error, indistinguishable from a
 * broken datagram path — was stamped PASS and promotable. 1.5x sits above every
 * arm the campaign actually produces (the worst live margin is the overlay at
 * 1%, which uses 22 of its 27-message budget) and strictly below a doubling, so
 * "this arm lost twice what was injected" can no longer pass as attribution.
 */
const INJECTED_LOSS_ATTRIBUTION_FACTOR = 1.5;

/**
 * The largest injected loss rate this rule will attribute a shortfall to.
 *
 * The registry ships 1%, 2.5% and 5%, and `scenario-registry.ts` clamps
 * overrides to 0-100 — which is not a bound at all here, because a cell
 * claiming 100% injected loss buys a budget of the entire ledger and forgives a
 * total blackout. Twice the worst rate the registry ships is the regime this
 * factor was calibrated against; a cell asking for more is not something the
 * rule can attribute, and it says so rather than forgiving everything.
 */
const MAX_ATTRIBUTABLE_LOSS_PERCENT = 10;

/**
 * The smallest ledger a shortfall can be attributed within.
 *
 * The budget is a fraction of what was attempted, so on a handful of messages
 * it degenerates: 1% injected loss over 10 attempts budgets a tenth of a
 * message, and any rounding at all turns that into "one lost message out of
 * ten is the impairment's doing" — a 10% loss rate excused by a 1% impairment.
 * Below this many attempts the rule has nothing to say, and a shortfall there
 * is reported as unattributable rather than as either a pass or a fault of the
 * arm.
 */
const MIN_ATTRIBUTABLE_ATTEMPTED = 100;

/**
 * The verdict tuple a measured arm is entitled to claim.
 *
 * `buildRunArtifact` defaults an unstated tuple to PASS/PASS, which the matrix
 * then reads as promotable — so a caller that states nothing stamps every
 * artifact promotable before a single byte has been verified. The campaign
 * states its tuple instead of inheriting that.
 *
 * `ScenarioCell` still carries no acceptance target (`types.ts`), so this
 * cannot yet ask whether an arm hit the number it was supposed to hit. What it
 * can ask is whether the arm measured anything at all and whether what it lost
 * is what the cell set out to make it lose:
 *
 *   - an arm that produced no samples was blocked and has no verdict to give;
 *   - loss the cell itself injected is the measurement working, not failing —
 *     `game-tick-loss` exists to make datagrams drop, and scoring a 99%
 *     delivery under 1% injected loss as a MISS would quarantine the very
 *     evidence the scenario was built to produce;
 *   - loss beyond what the impairment explains, and any loss at all on a cell
 *     that injects none, is a measured MISS that keeps its numbers;
 *   - a shortfall the rule cannot attribute either way — too few attempts, or
 *     an injected rate outside the regime the factor was calibrated for — is
 *     BLOCKED/NO_VERDICT. Calling it a PASS would forgive an arbitrary loss
 *     rate and calling it a MISS would blame the arm for the instrument.
 *
 * The precise rule, given `missing = max(attempted - delivered, dropped +
 * expired)` and an injected rate `L`:
 *
 *   - `missing === 0`                        -> PASS
 *   - `L` absent, zero, or not a positive
 *     finite number                          -> MISS
 *   - `L > MAX_ATTRIBUTABLE_LOSS_PERCENT`    -> BLOCKED/NO_VERDICT
 *   - `attempted < MIN_ATTRIBUTABLE_ATTEMPTED` -> BLOCKED/NO_VERDICT
 *   - otherwise PASS iff
 *     `missing <= floor(attempted * L/100 * INJECTED_LOSS_ATTRIBUTION_FACTOR)`
 *
 * The budget floors rather than rounds up, and that choice costs something
 * worth naming rather than hiding. `missing` is an integer and the budget is
 * not, so flooring charges the arm for the quantisation: at `L = 1` the budget
 * only reaches 2 at `attempted = 134`, while the campaign's own 1.2x overlay
 * model has already lost a second message by `attempted = 126`. A ledger in
 * `[126, 133]` that loses exactly what that model predicts is scored MISS here
 * and would be scored PASS under `ceil`. That band is accepted, not
 * overlooked — live lossy cells attempt 600 or 1800, where the budget is nine
 * messages against a predicted eight, so nothing the campaign runs lands in it.
 *
 * It is accepted because `ceil` buys its way out of the band with a free
 * message, and that free message is worth more to a forged ledger than the band
 * costs an honest one. The minimum-attempts bound caps the amnesty's size — one
 * message in a hundred or more, never the tenth of a ledger that motivated the
 * bound — but not its ratio, because `lossPercent` is caller-supplied and only
 * bounded above. Any `L < 66.7/attempted` buys a raw budget below 1, so under
 * `ceil` a cell claiming 0.001% injected loss over 1000 attempts would have its
 * budget of 0.015 rounded up to a whole message, forgiving a 0.1% shortfall
 * with an impairment a hundred times too small to explain it.
 * Flooring refuses that, and refuses in the direction a promotability gate
 * should fail: an unreachable false MISS is loud, a reachable false PASS is
 * silent. `r1-flow-hardening.test.ts` pins both halves of this.
 *
 * CAVEAT for whoever reads a green sweep as evidence: across the live registry
 * every one of the 105 rows scores PASS/PASS today, and only the 24 lossy
 * `game-tick-loss` arms earn it against a real shortfall — the other 81 pass
 * because the synthetic measurement model sets `delivered === attempted`. This
 * rule therefore discriminates on hypothetical ledgers, not on live ones, until
 * the model is replaced by real adapter-driven execution.
 *
 * When the registry grows real acceptance targets, this is the one place that
 * has to learn about them: give `ScenarioCell` its target, pass it in beside
 * the impairment, and decide PASS/MISS against it here. No caller and no
 * downstream step derives a verdict of its own, so nothing else has to change.
 */
export function deriveMeasuredVerdictTuple(
	measurement: {
		readonly samples: readonly number[];
		readonly ledger: {
			readonly attempted: number;
			readonly delivered: number;
			readonly dropped: number;
			readonly expired: number;
		};
	},
	injected: { readonly lossPercent?: number } = {},
): {
	readonly evidenceStatus: "PASS" | "BLOCKED";
	readonly scenarioVerdict: "PASS" | "MISS" | "NO_VERDICT";
} {
	if (measurement.samples.length === 0) {
		return { evidenceStatus: "BLOCKED", scenarioVerdict: "NO_VERDICT" };
	}
	const { attempted, delivered, dropped, expired } = measurement.ledger;
	// Both readings of "how much went missing" count, so an arm that reports a
	// full delivery count alongside a non-zero drop counter is still judged on
	// the drop it admitted to.
	const missing = Math.max(attempted - delivered, dropped + expired);
	if (missing <= 0) {
		return { evidenceStatus: "PASS", scenarioVerdict: "PASS" };
	}
	const lossPercent = injected.lossPercent;
	const injectedPercent =
		typeof lossPercent === "number" &&
		Number.isFinite(lossPercent) &&
		lossPercent > 0
			? lossPercent
			: 0;
	// A cell that injects nothing explains nothing: every missing message is the
	// arm's, whatever the ledger's size.
	if (injectedPercent === 0) {
		return { evidenceStatus: "PASS", scenarioVerdict: "MISS" };
	}
	if (
		injectedPercent > MAX_ATTRIBUTABLE_LOSS_PERCENT ||
		attempted < MIN_ATTRIBUTABLE_ATTEMPTED
	) {
		return { evidenceStatus: "BLOCKED", scenarioVerdict: "NO_VERDICT" };
	}
	const attributable = Math.floor(
		attempted * (injectedPercent / 100) * INJECTED_LOSS_ATTRIBUTION_FACTOR,
	);
	return {
		evidenceStatus: "PASS",
		scenarioVerdict: missing <= attributable ? "PASS" : "MISS",
	};
}

/**
 * The registry's own cell for a caller-supplied one, or a refusal.
 *
 * A cell object is a claim, not evidence. The only thing about it that carries
 * any authority is its `cellId`, because that is what names a row in the frozen
 * registry — every other field is whatever the caller typed.
 */
function canonicalCellOf(cell: ScenarioCell | undefined): ScenarioCell {
	const cellId = cell?.cellId;
	const canonical =
		typeof cellId === "string"
			? CANONICAL_SCENARIO_REGISTRY.cells.find(
					(candidate) => candidate.cellId === cellId,
				)
			: undefined;
	if (
		canonical === undefined ||
		canonicalDigest(cell) !== canonicalDigest(canonical)
	) {
		throw new ComparisonCliError("campaign", "CAMPAIGN_CELL_NOT_CANONICAL");
	}
	return canonical;
}

/**
 * Refuse an arm whose samples are not in the unit its cell publishes.
 *
 * The failure this catches leaves no trace anywhere downstream: the artifact
 * is well-formed, the ledger agrees with the series, the histogram counts sum,
 * and `verify-artifact.ts` only confines each sample to
 * `[contract.minimum, contract.maximum]` -- which is `[0, ∞)` on every contract
 * but one. A round-trip time of 0.42 ms published as 0.42 delivered messages
 * per second passes all of it, and a reader has no way to tell.
 */
function assertMeasurementUnitPublishable(
	measurement: ArmMeasurement,
	scenarioId: string,
): void {
	const contract = metricContractForScenario(scenarioId);
	if (!contract) {
		throw new ComparisonCliError("campaign", "METRIC_CONTRACT_UNKNOWN");
	}
	if (measurement.sampleUnit !== contract.unit) {
		throw new ComparisonCliError("campaign", "CAMPAIGN_METRIC_UNIT_MISMATCH");
	}
}

/**
 * The measured artifact for one arm of one cell.
 *
 * This exists so the verdict tuple and the recorded impairment are derived in
 * one place that a test can call. `runCampaign` cannot be reached in-process —
 * it fails closed on the quarantined trust boundary before its loop runs — so
 * an artifact assembled inline there is wiring no test can observe, and the S6
 * defect (an unstated tuple silently defaulting to promotable PASS/PASS) could
 * be reintroduced by deleting one spread from a loop body nothing exercises.
 *
 * Being reachable from outside `runCampaign` is the point, so the cell it is
 * handed is not taken on trust. `buildRunArtifact` looks the cell up again by
 * `cellId` and records the canonical one, so a caller passing a cell object
 * that merely carries a canonical `cellId` used to have the verdict derived
 * against its own forged parameters while the artifact recorded the honest
 * ones: a spread copy of a zero-loss cell with `lossPercent: 100` turned a
 * total blackout into a promotable PASS stamped with a clean `fq` impairment.
 * The cell is resolved from the registry here and the supplied object must be
 * canonically identical to it.
 */
export function buildMeasuredArmArtifact(input: {
	readonly cell: ScenarioCell;
	readonly comparisonId: string;
	readonly runId: string;
	/**
	 * Which execution of the campaign this arm is, assigned by the campaign.
	 *
	 * A run id is not enough on its own: the overlay arm shares a cell with the
	 * arm beside it, and two transports share a cell id. This is the number
	 * that makes the execution unique, and it is the number the supervisor
	 * mints the grant against.
	 */
	readonly executionIndex: number;
	readonly transport: Transport;
	readonly armKind: ArmKind;
	/**
	 * The arm's numbers, stated by whoever measured them.
	 *
	 * This used to be optional, and omitting it fell through to `measureCellArm`
	 * — a branch on `transport === "wt"` returning author-chosen literals, which
	 * meant every published delta was written rather than observed. That function
	 * is gone. `measureCellArm` stays a name-listed forbidden official-I/O surface
	 * (`check-official-io.ts`, mirrored in the frozen allowlist inventory and
	 * mapped to `OUTPUT_SYNTHETIC_EXECUTOR_FORBIDDEN` by `supervisor-client.ts`)
	 * so the name can never be reintroduced quietly; there is now no function
	 * behind the ban.
	 *
	 * Required is the whole point: with no default, the failure mode of a caller
	 * that has nothing to state is *no artifact*, never a plausible one.
	 */
	readonly measurement: ArmMeasurement;
}) {
	const cell = canonicalCellOf(input?.cell);
	const measurement = input.measurement;
	const execution: MeasurementExecutionKey = {
		campaignId: input.comparisonId,
		runId: input.runId,
		executionIndex: input.executionIndex,
		transport: input.transport,
	};
	assertMeasurementProvenance(measurement, {
		cellId: cell.cellId,
		transport: input.transport,
		execution,
	});
	// After the grant, because whether these samples were taken for this
	// execution is the prior question: an arm that cannot name its measurement
	// is refused for that, not for how it is labelled. `buildRunArtifact`
	// applies the label a few frames below this one and has no way to ask what
	// the series is in, so this is the last point at which both facts are in
	// hand.
	assertMeasurementUnitPublishable(measurement, cell.scenarioId);
	// The judged impairment is the recorded impairment: `buildRunArtifact`
	// decodes the canonical cell with this same function, so there is one reading
	// and no way to pass it a different one.
	const impairment = injectedImpairmentOf(cell);
	return buildRunArtifact({
		comparisonId: input.comparisonId,
		runId: input.runId,
		cellId: cell.cellId,
		transport: input.transport,
		armKind: input.armKind,
		...deriveMeasuredVerdictTuple(measurement, impairment),
		seed: 42,
		repetitionIndex: 1,
		totalRepetitions: cell.runPolicy.measuredRepetitions,
		samples: measurement.samples,
		percentiles: measurement.percentiles,
		ledger: measurement.ledger,
		admissionCounters: measurement.admissionCounters,
		// The guard above resolved this against the recorder's record; carrying
		// it into the artifact is what makes the resolution visible to a reader
		// instead of being a check that leaves no trace in what it approved.
		provenance: measurement.provenance,
		// The builder refuses a measured arm that presents no grant. It is the
		// last of the three places that ask -- the supervisor refuses the frame,
		// this campaign refuses the measurement, and the builder refuses to
		// assemble one anyway -- and it is the one a test can reach without a
		// campaign around it.
		grant: measurement.grant,
		telemetry: measurement.telemetry,
	});
}

/**
 * One campaign authority record this build will act on.
 *
 * `status` is what the anchor may be used for, and it is stated rather than
 * inferred from position: exactly one anchor mints new campaigns, and a
 * `retired` anchor still validates campaigns already minted against it but can
 * never mint another.
 */
export interface CampaignAuthorityAnchor {
	readonly sha256: string;
	readonly status: "minting" | "retired";
}

/**
 * Every campaign authority record this build will act on.
 *
 * INVARIANT: a digest the caller supplied is not evidence. An authority record
 * that carries its own digest proves only that whoever forged it can also run
 * SHA-256, so the caller may name an anchor but may never introduce one. Do not
 * "generalize" this to a per-campaign digest parameter — that is the H3
 * tautology this set exists to kill.
 *
 * INVARIANT: rotation is a reviewed commit to this array, and only this array,
 * and the two kinds of rotation are not the same edit:
 *
 *   - a SCHEDULED rollover adds the new anchor as `minting` and demotes the
 *     outgoing one to `retired` in the same commit. Both stay live, which is
 *     why this is a set and not a scalar, and the retired entry is removed in
 *     a later commit once no campaign still names it;
 *   - a COMPROMISE-driven rotation DELETES the compromised entry in the same
 *     commit that adds its replacement. There is no window in which a
 *     compromised anchor is retired-but-trusted: a retired anchor is one this
 *     build still vouches for, and a compromised one is not.
 *
 * The frozen R1 fixture publishes the minting entry, and
 * `r1-flow-hardening.test.ts` asserts the two have not drifted apart, that
 * every entry is a real SHA-256, that exactly one entry mints, and that the set
 * cannot be extended at runtime.
 */
export const R1_CAMPAIGN_AUTHORITY_ANCHOR_SET: readonly CampaignAuthorityAnchor[] =
	Object.freeze([
		Object.freeze({
			sha256:
				"9018671efcc08bb4d27043d389933470dcf4e819774fbbd94fd71fe51a6f36cc",
			status: "minting",
		} as const),
	]);

/** Every anchored digest, whatever it may be used for. */
export const R1_CAMPAIGN_AUTHORITY_ANCHORS: readonly string[] = Object.freeze(
	R1_CAMPAIGN_AUTHORITY_ANCHOR_SET.map((anchor) => anchor.sha256),
);

/**
 * The anchor a fresh campaign is minted against.
 *
 * Selected by declared status, never by position. Picking "the last entry"
 * made the documented rotation path unexecutable — appending a second anchor
 * silently moved minting authority to whichever entry happened to be typed
 * last, and prepending moved it to the retired one.
 */
export function selectMintingAnchor(
	anchors: readonly CampaignAuthorityAnchor[],
): string {
	const minting = anchors.filter((anchor) => anchor.status === "minting");
	if (minting.length !== 1) {
		throw new ComparisonCliError("campaign", "TRUST_AUTHORITY_MINT_AMBIGUOUS");
	}
	return minting[0]!.sha256;
}

/**
 * The authority anchor a fresh campaign is minted against. Reading an existing
 * campaign uses whichever anchor that campaign names, not this one.
 */
export const R1_CAMPAIGN_AUTHORITY_SHA256 = selectMintingAnchor(
	R1_CAMPAIGN_AUTHORITY_ANCHOR_SET,
);

/** True only for a digest this build has committed to as an authority anchor. */
export function isPinnedCampaignAuthority(digest: unknown): digest is string {
	return (
		typeof digest === "string" && R1_CAMPAIGN_AUTHORITY_ANCHORS.includes(digest)
	);
}

/** True only for an object that says `ok: true` — not for `"yes"`, `1`, or `{}`. */
function seamAccepted(value: unknown): value is FlowValidation {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { readonly ok?: unknown }).ok === true
	);
}

/**
 * The code a refusing seam gets to report.
 *
 * A seam's `code` is an untrusted string: the seams read descriptors and the
 * failures they see quote the paths they were reading. Only a screaming-snake
 * constant is adopted; anything else falls back to this step's own code rather
 * than becoming the diagnostic the supervisor records.
 */
/** The two fields that together make one verdict claim. */
const VERDICT_TUPLE_FIELDS = ["evidenceStatus", "scenarioVerdict"] as const;

/**
 * One half of the verdict tuple as the promote step declared it.
 *
 * Absent means absent. A field that is present but not a string is a claim the
 * promote step made and failed to make legibly, and treating it as absence let
 * a later step decide the verdict in its place, so it refuses.
 */
function promotedTupleField(
	promoted: unknown,
	key: (typeof VERDICT_TUPLE_FIELDS)[number],
): string | undefined {
	const value = (promoted as Record<string, unknown>)[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new ComparisonCliError("campaign", "VERDICT_TUPLE_MALFORMED");
	}
	return value;
}

function seamCode(value: unknown, fallback: string): string {
	const code = (value as { readonly code?: unknown })?.code;
	return isSafeErrorCode(code) ? code : fallback;
}

/**
 * Runs one injected seam and normalizes whatever escapes it.
 *
 * A seam that throws instead of returning `{ ok: false }` used to propagate as
 * a raw `Error`, and the CLI printed its message verbatim — descriptor paths
 * and capability filenames landed in stderr and CI logs. Only the typed code
 * survives this boundary.
 */
async function runSeam<T>(
	fallbackCode: string,
	call: () => T | Promise<T>,
): Promise<T> {
	try {
		return await call();
	} catch (error: unknown) {
		if (error instanceof ComparisonCliError) throw error;
		throw new ComparisonCliError("campaign", fallbackCode);
	}
}

export interface OfficialEntrypointFlowInput {
	readonly fixtureOnly?: boolean;
	readonly authority: {
		readonly bytes: Uint8Array;
		readonly digest: string;
	};
	readonly load: {
		readonly readBootstrap?: (name: string) => Promise<Uint8Array>;
		readonly readAuthority?: () => Promise<Uint8Array>;
		readonly readLock?: () => Promise<Uint8Array>;
		readonly readManifest?: () => Promise<Uint8Array>;
	};
	readonly verify: {
		readonly lock: (bytes: Uint8Array) => FlowValidation;
		readonly manifest: (bytes: Uint8Array) => FlowValidation;
	};
	readonly promotion: {
		readonly promote: (verified: unknown) => FlowValidation & {
			readonly promoted?: boolean;
		};
		readonly renderReport: (promoted: unknown) => FlowValidation;
	};
	/**
	 * Accepted and never called. The flow validates what the supervisor's four
	 * child roots already produced, so a role launcher reaching it at all would
	 * mean the pipeline had grown a second way to start work; callers pass a
	 * throwing seam to assert that it does not.
	 */
	readonly spawnRole?: (role: string) => never;
}

/**
 * The official promotion pipeline, from the campaign authority record through
 * to the rendered report.
 *
 * Every read and validation arrives as an injected seam because the supervisor
 * owns the descriptors and the Rust-side validators; this function owns only
 * the order and what it will believe, and both are the security property.
 *
 * The authority record is proved against an anchor this build committed to —
 * never against a digest the caller also supplied, which proves nothing. The
 * campaign lock is verified before the manifest is even read, and the manifest
 * is verified before anything is promoted. A seam counts as passing only when
 * it says `ok === true`, a seam that throws is normalized to a typed code, and
 * a failure at any step aborts with nothing downstream run.
 *
 * The returned envelope is assembled field by field. No seam's return value is
 * spread into it, and the verdict tuple is read from the promote step alone:
 * the last and least trusted step in the pipeline supplies no part of the
 * verdict and cannot stamp promotability onto the result on its way out.
 *
 * A caller that declares `fixtureOnly` gets a pipeline that can validate but
 * never promote, because a fixture run carries no authority to promote with.
 *
 * The flow launches no roles and opens no sockets: the supervisor already ran
 * the four child roots, and what remains is validating what they produced.
 */
export async function runOfficialEntrypointFlow(
	input: OfficialEntrypointFlowInput,
): Promise<Record<string, unknown>> {
	// A malformed flag is not an official run. `fixtureOnly: "no"` used to be
	// neither true nor rejected, which meant it silently bought the full
	// official pipeline.
	if (
		input?.fixtureOnly !== undefined &&
		typeof input.fixtureOnly !== "boolean"
	) {
		throw new ComparisonCliError("campaign", "TRUST_FIXTURE_FLAG_INVALID");
	}
	const fixtureOnly = input?.fixtureOnly === true;

	// The seam table is read outside `runSeam`, so a caller that omits it — or
	// hands over a string — used to escape as a raw TypeError with whatever the
	// runtime chose to say about the property it could not read. Only the typed
	// code survives this boundary, including for the input itself.
	const load = input?.load;
	if (typeof load !== "object" || load === null) {
		throw new ComparisonCliError("campaign", "TRUST_FLOW_SEAMS_INVALID");
	}

	const readNamed = async (
		name: string,
		specific: (() => Promise<Uint8Array>) | undefined,
	): Promise<Uint8Array> => {
		if (load.readBootstrap !== undefined) {
			return await runSeam("TRUST_AUTHORITY_READ_FAILED", () =>
				load.readBootstrap!(name),
			);
		}
		if (specific === undefined) {
			throw new ComparisonCliError(
				"campaign",
				"OUTPUT_TRUST_BOUNDARY_UNAVAILABLE",
			);
		}
		return await runSeam("TRUST_AUTHORITY_READ_FAILED", specific);
	};

	// The caller may only name an authority this build already anchors. Both the
	// bytes it declared and the bytes actually read have to hash to the anchor it
	// named, so a forged record carrying its own honest digest is refused rather
	// than promoted.
	const authority = input?.authority as
		| { readonly bytes?: unknown; readonly digest?: unknown }
		| undefined;
	const anchor = authority?.digest;
	if (!isPinnedCampaignAuthority(anchor)) {
		throw new ComparisonCliError("campaign", "TRUST_AUTHORITY_UNPINNED");
	}
	if (
		!(authority?.bytes instanceof Uint8Array) ||
		sha256HexOfBytes(authority.bytes) !== anchor
	) {
		throw new ComparisonCliError("campaign", "TRUST_AUTHORITY_BYTES_MISMATCH");
	}

	const authorityBytes = await readNamed("authority", load.readAuthority);
	if (sha256HexOfBytes(authorityBytes) !== anchor) {
		throw new ComparisonCliError("campaign", "TRUST_AUTHORITY_DIGEST_MISMATCH");
	}

	const lockBytes = await readNamed("campaign-lock", load.readLock);
	const verifiedLock = await runSeam("CAMPAIGN_LOCK_INVALID", () =>
		input.verify.lock(lockBytes),
	);
	if (!seamAccepted(verifiedLock)) {
		throw new ComparisonCliError(
			"campaign",
			seamCode(verifiedLock, "CAMPAIGN_LOCK_INVALID"),
		);
	}

	const manifestBytes = await readNamed("manifest", load.readManifest);
	const verifiedManifest = await runSeam("CAMPAIGN_MANIFEST_INVALID", () =>
		input.verify.manifest(manifestBytes),
	);
	if (!seamAccepted(verifiedManifest)) {
		throw new ComparisonCliError(
			"campaign",
			seamCode(verifiedManifest, "CAMPAIGN_MANIFEST_INVALID"),
		);
	}

	const promoted = await runSeam("PROMOTION_REJECTED", () =>
		input.promotion.promote({
			authorityBytes,
			lock: verifiedLock,
			manifest: verifiedManifest,
		}),
	);
	if (!seamAccepted(promoted)) {
		throw new ComparisonCliError(
			"campaign",
			seamCode(promoted, "PROMOTION_REJECTED"),
		);
	}

	const report = await runSeam("REPORT_REJECTED", () =>
		input.promotion.renderReport(promoted),
	);
	if (!seamAccepted(report)) {
		throw new ComparisonCliError(
			"campaign",
			seamCode(report, "REPORT_REJECTED"),
		);
	}

	// The verdict tuple belongs to the promote step and to no other. The report
	// renders what was promoted, so a report that names either tuple field is
	// disputing the promotion rather than describing it, and a disputed verdict
	// is refused instead of merged: a `??` chain across the two steps let the
	// report supply whichever half promotion had left undefined.
	for (const key of VERDICT_TUPLE_FIELDS) {
		if ((report as unknown as Record<string, unknown>)[key] !== undefined) {
			throw new ComparisonCliError("campaign", "VERDICT_TUPLE_DISPUTED");
		}
	}
	// A present-but-non-string field is a malformed claim, never an absent one.
	// Dropping it silently handed the decision back to whatever came next.
	const evidenceStatus = promotedTupleField(promoted, "evidenceStatus");
	const scenarioVerdict = promotedTupleField(promoted, "scenarioVerdict");
	let promotable = false;
	if (evidenceStatus !== undefined || scenarioVerdict !== undefined) {
		const classification = classifyVerdictTuple({
			evidenceStatus,
			scenarioVerdict,
		});
		if (classification.ok !== true) {
			throw new ComparisonCliError("campaign", classification.code);
		}
		promotable = classification.promotable;
	}

	// Promotability is decided at the promote step; the report renders what was
	// promoted and cannot upgrade a non-promotable campaign on its way out. Every
	// field below is computed here or taken from a named step — never spread.
	const wasPromoted =
		(promoted as { readonly promoted?: unknown }).promoted === true;

	// A fixture run is a developer convenience and carries no authority, so a
	// promote seam that claims one under `fixtureOnly` is refused outright rather
	// than quietly demoted — a caller that both declared a fixture run and
	// promoted it has contradicted itself.
	if (fixtureOnly && wasPromoted) {
		throw new ComparisonCliError(
			"campaign",
			"TRUST_FIXTURE_PROMOTION_FORBIDDEN",
		);
	}

	return {
		ok: true,
		fixtureOnly,
		promoted: wasPromoted,
		promotable: !fixtureOnly && promotable && wasPromoted,
		evidenceStatus,
		scenarioVerdict,
		authoritySha256: anchor,
		manifestSha256: sha256HexOfBytes(manifestBytes),
	};
}

/** Which arm a campaign is asking to have measured. */
export interface ArmMeasurementRequest {
	readonly cell: ScenarioCell;
	readonly transport: Transport;
	readonly armKind: ArmKind;
	/**
	 * The execution to measure, as the campaign assigned it.
	 *
	 * The producer needs this to ask the supervisor for the right grant. It is
	 * an input to the measurement, not an output of it: a producer that returns
	 * a grant for some other execution has measured some other execution.
	 */
	readonly execution: MeasurementExecutionKey;
}

/**
 * How a campaign obtains numbers.
 *
 * There is deliberately no default. The campaign used to fall through to
 * `measureCellArm`, which branched on `transport === "wt"` and returned
 * author-chosen literals, so every arm it "measured" was written rather than
 * observed. Deleting that left this seam empty on purpose: a campaign that
 * cannot name a measurement source produces no artifact at all, which is the
 * only failure mode that cannot be mistaken for evidence.
 *
 * The producer is a driver that executed the arm over a real transport. It is
 * not imported here: the driver runs in the client and server role processes on
 * the two hosts, and its output crosses into the controller as data. Keeping it
 * out of this module's import graph is also what keeps the adapters out of the
 * official-root reachability set.
 */
export interface CampaignExecution {
	measureArm(request: ArmMeasurementRequest): ArmMeasurement;
}

/**
 * The measurement source a bare CLI invocation has: none.
 *
 * A campaign run from this file's own entrypoint has no driver behind it and no
 * cable to run one over, so it refuses instead of inventing numbers. This is the
 * honest post-deletion state of the tool on a single host.
 */
export function unavailableArmMeasurement(): never {
	throw new ComparisonCliError(
		"campaign",
		"CAMPAIGN_ARM_MEASUREMENT_UNAVAILABLE",
	);
}

/**
 * Execute the comparison campaign.
 */
export async function runCampaign(
	args: CampaignArgs,
	/**
	 * Defaulted, and to a producer that only ever throws.
	 *
	 * Required would have been the stronger signature, but `runCampaign` is
	 * called with one argument from a frozen red test, and a frozen test that
	 * contradicts a fix is reported rather than edited. The default costs
	 * nothing here: a campaign that names no execution refuses at the first arm
	 * instead of measuring one, which is the same failure mode a required
	 * parameter would have produced, just later and at runtime.
	 */
	execution: CampaignExecution = { measureArm: unavailableArmMeasurement },
): Promise<void> {
	// The gate belongs on the entry point, not only on the argument parser: an
	// in-process caller that assembles `CampaignArgs` itself never goes through
	// the parser and would otherwise reach official I/O on an unreviewed host.
	assertSupportedPlatform("campaign", process.platform);
	assertOfficialComparisonIoAvailable();
	const campaignId = args.campaignId;
	const outputDir = resolveOfficialComparisonOutputDir({
		candidate: args.candidate,
		campaignId,
		outputDir: args.outputDir,
	});

	if (!existsSync(outputDir)) {
		mkdirSync(outputDir, { recursive: true });
	}

	const selectedCells = CANONICAL_SCENARIO_REGISTRY.cells.filter((cell) =>
		args.scenarios.includes(cell.scenarioId),
	);

	console.log(
		`===============================================================`,
	);
	console.log(`WEBTRANSPORT vs WEBSOCKET CANONICAL COMPARISON CAMPAIGN`);
	console.log(`Campaign ID : ${campaignId}`);
	console.log(
		`Topology    : Mac (10.99.0.1/en8) ↔ Linux (10.99.0.2/eno1) direct`,
	);
	console.log(`Cells       : ${selectedCells.length} canonical workload cells`);
	console.log(`Transports  : ${args.transports}`);
	console.log(`Output Dir  : ${outputDir}`);
	console.log(
		`===============================================================`,
	);

	const generatedArtifacts: string[] = [];
	let totalRuns = 0;
	let passRuns = 0;
	// The execution ordinal the supervisor mints grants against. It counts
	// every arm the campaign asks to have measured, overlay arms included,
	// because an overlay is a separate execution of the same cell and a grant
	// that could not tell them apart would let one stand in for the other.
	let executionIndex = 0;

	for (const [cellIdx, cell] of selectedCells.entries()) {
		console.log(
			`\n[cell ${cellIdx + 1}/${selectedCells.length}] ${cell.cellId} (${cell.scenarioId})`,
		);

		// Determine transports to evaluate
		const transportsToRun: Transport[] =
			args.transports === "both" ? ["ws", "wt"] : [args.transports];

		for (const transport of transportsToRun) {
			const runId = `run-${cell.cellId.replace(/[/:]/g, "-")}`;
			process.stdout.write(
				`  -> [${transport.toUpperCase()}] running ${runId}... `,
			);

			executionIndex += 1;
			const armExecution: MeasurementExecutionKey = {
				campaignId,
				runId,
				executionIndex,
				transport,
			};
			const artifact = buildMeasuredArmArtifact({
				cell,
				comparisonId: campaignId,
				runId,
				executionIndex,
				transport,
				armKind: "primary",
				measurement: execution.measureArm({
					cell,
					transport,
					armKind: "primary",
					execution: armExecution,
				}),
			});

			const sealed = sealRunArtifact(artifact);
			const trustCtx = trustContextForArtifact(artifact);
			const verification = verifyRunArtifact(sealed, trustCtx);

			totalRuns++;
			const quarantine = checkPromotionQuarantine({
				artifact,
				externalTrustBound: args.externalTrustBound,
				expectedComparisonId: campaignId,
			});
			if (verification.evidenceStatus === "PASS" && quarantine.promotable) {
				passRuns++;
				const filename = `${cell.cellId.replace(/[/:]/g, "_")}-${transport}.json`;
				const filepath = resolveOfficialComparisonOutputFile({
					candidate: args.candidate,
					campaignId,
					outputDir,
					outputFile: join(outputDir, filename),
				});
				writeOfficialComparisonFile(filepath, sealed);
				generatedArtifacts.push(filename);
				console.log(`PASS (sealed ${sealed.byteLength} bytes -> ${filename})`);
			} else if (verification.evidenceStatus !== "PASS") {
				console.log(
					`FAIL: ${verification.rejections.map((r) => r.code).join(", ")}`,
				);
			} else {
				console.log(
					`QUARANTINED: ${quarantine.reasons.map((r) => r.code).join(", ")}`,
				);
			}

			// If game-tick-loss and transport is WS, also generate labeled ws-overlay
			if (cell.scenarioId === "game-tick-loss" && transport === "ws") {
				const overlayRunId = `run-${cell.cellId.replace(/[/:]/g, "-")}-ws-overlay`;
				process.stdout.write(`  -> [WS-OVERLAY] running ${overlayRunId}... `);

				executionIndex += 1;
				const overlayExecution: MeasurementExecutionKey = {
					campaignId,
					runId: overlayRunId,
					executionIndex,
					transport: "ws",
				};
				const overlayArtifact = buildMeasuredArmArtifact({
					cell,
					comparisonId: campaignId,
					runId: overlayRunId,
					executionIndex,
					transport: "ws",
					armKind: "overlay",
					measurement: execution.measureArm({
						cell,
						transport: "ws",
						armKind: "overlay",
						execution: overlayExecution,
					}),
				});

				const sealedOverlay = sealRunArtifact(overlayArtifact);
				const overlayTrustCtx = trustContextForArtifact(overlayArtifact);
				const overlayVerif = verifyRunArtifact(sealedOverlay, overlayTrustCtx);

				totalRuns++;
				const overlayQuarantine = checkPromotionQuarantine({
					artifact: overlayArtifact,
					externalTrustBound: args.externalTrustBound,
					expectedComparisonId: campaignId,
				});
				if (
					overlayVerif.evidenceStatus === "PASS" &&
					overlayQuarantine.promotable
				) {
					passRuns++;
					const filename = `${cell.cellId.replace(/[/:]/g, "_")}-ws-overlay.json`;
					const filepath = resolveOfficialComparisonOutputFile({
						candidate: args.candidate,
						campaignId,
						outputDir,
						outputFile: join(outputDir, filename),
					});
					writeOfficialComparisonFile(filepath, sealedOverlay);
					generatedArtifacts.push(filename);
					console.log(
						`PASS (sealed ${sealedOverlay.byteLength} bytes -> ${filename})`,
					);
				} else if (overlayVerif.evidenceStatus !== "PASS") {
					console.log(
						`FAIL: ${overlayVerif.rejections.map((r) => r.code).join(", ")}`,
					);
				} else {
					console.log(
						`QUARANTINED: ${overlayQuarantine.reasons.map((r) => r.code).join(", ")}`,
					);
				}
			}
		}
	}

	// Write campaign manifest
	const manifest = {
		campaignId,
		generatedAt: new Date().toISOString(),
		totalCells: selectedCells.length,
		totalRuns,
		passRuns,
		artifacts: generatedArtifacts,
	};
	const manifestPath = resolveOfficialComparisonOutputFile({
		candidate: args.candidate,
		campaignId,
		outputDir,
		outputFile: join(outputDir, "manifest.json"),
	});
	writeOfficialComparisonFile(manifestPath, JSON.stringify(manifest, null, 2));

	console.log(
		`\n===============================================================`,
	);
	console.log(
		`CAMPAIGN COMPLETE: ${passRuns}/${totalRuns} runs verified PASS.`,
	);
	console.log(`Manifest written to ${join(outputDir, "manifest.json")}`);
	console.log(
		`===============================================================\n`,
	);
}

// Entrypoint when invoked directly via CLI
if (import.meta.main) {
	try {
		const args = parseCampaignArgs(process.argv.slice(2));
		if (args.help) {
			printCampaignHelp();
			process.exit(0);
		}
		if (args.fixtureOnly) {
			// The package script is a developer convenience. It publishes nothing.
			console.log(
				"[campaign] fixture-only: no official evidence is written. Run the supervisor for an official campaign.",
			);
			process.exit(0);
		}
		await runCampaign(args, { measureArm: unavailableArmMeasurement });
	} catch (err: unknown) {
		console.error(`[campaign] Error: ${comparisonErrorCode(err)}`);
		process.exit(1);
	}
}
