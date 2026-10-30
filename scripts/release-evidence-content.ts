/**
 * Evidence content is allowlisted, not just scanned.
 *
 * Every proof kind in docs/release-claims.json lists the files its bundle may
 * contain (`proof.files`: a member-name glob and a content schema name). A
 * bundle member that matches no declared file is refused; a JSON member must
 * satisfy its schema exactly -- known keys only, recursively, with typed
 * values -- and a declared log/text member must match its line grammar.
 *
 * Strings are typed too. Free text is capped in length, restricted to
 * printable ASCII, and must not contain an opaque run: 24 or more characters
 * of base64/hex alphabet with the character-class churn of encoded data,
 * where chunks split by a single punctuation or whitespace character count as
 * one run (permissive decoders ignore such separators). Hashes and digests
 * are accepted only in fields declared as digests, with their exact lengths.
 *
 * The decode-and-rescan privacy scanner still runs over everything as defence
 * in depth; this module is what makes the set of publishable content finite.
 */

// ---------------------------------------------------------------------------
// Opaque runs

const ALPHABET = /[A-Za-z0-9+/=_-]/;
/** Shortest opaque run that is refused outside declared digest fields. */
export const OPAQUE_RUN_LENGTH = 24;

function charClass(char: string): number {
	if (char >= "a" && char <= "z") return 0;
	if (char >= "A" && char <= "Z") return 1;
	if (char >= "0" && char <= "9") return 2;
	return 3;
}

/** Character-class churn of encoded data: base64 and hex flip between
 * lower/upper/digit/symbol on a large share of positions; words, identifiers
 * and camelCase do not. */
function looksEncoded(joined: string): boolean {
	// Measured over letters and digits only: separators inside identifiers
	// (`x86_64-unknown-linux`) are not churn.
	const alnum = joined.replace(/[^A-Za-z0-9]/g, "");
	if (alnum.length < OPAQUE_RUN_LENGTH - 4) return false;
	let transitions = 0;
	for (let i = 1; i < alnum.length; i += 1)
		if (charClass(alnum[i] as string) !== charClass(alnum[i - 1] as string))
			transitions += 1;
	const churn = transitions / (alnum.length - 1);
	if (churn >= 0.25) return true;
	// Long hex (digests, ids) with both digits and letters.
	return (
		/^[0-9a-fA-F]+$/.test(alnum) &&
		/[0-9]/.test(alnum) &&
		/[a-fA-F]/.test(alnum)
	);
}

/**
 * Why `text` contains an opaque run, or `undefined`. Chunks of the base64/hex
 * alphabet separated by exactly one other character are joined first, so
 * `TE9L!QUxJ!U0Vf`, `TE9L.QUxJ`, `TE9L,QUxJ` and `TE9L QUxJ` are all one run.
 */
export function opaqueRunReason(text: string): string | undefined {
	let joined = "";
	let gap = 0;
	const flush = (): string | undefined => {
		const found =
			joined.length >= OPAQUE_RUN_LENGTH && looksEncoded(joined)
				? `opaque run of ${joined.length} encoded-looking characters`
				: undefined;
		joined = "";
		return found;
	};
	for (const char of text) {
		if (ALPHABET.test(char)) {
			joined += char;
			gap = 0;
			continue;
		}
		gap += 1;
		if (gap > 1) {
			const found = flush();
			if (found) return found;
		}
	}
	return flush();
}

// ---------------------------------------------------------------------------
// Schemas

export type StringKind =
	| { kind: "text"; max: number }
	| { kind: "ident"; max: number }
	| { kind: "path"; max: number }
	| { kind: "symbol"; max: number }
	| { kind: "hex"; length: number }
	| { kind: "hexRange"; min: number; max: number }
	| { kind: "base64"; bytes: number }
	| { kind: "pattern"; pattern: RegExp; label: string }
	| { kind: "literal"; values: readonly string[] }
	| { kind: "log"; maxBytes: number };

export type Schema =
	| { t: "object"; props: Record<string, Schema>; optional?: readonly string[] }
	| {
			t: "map";
			keys: RegExp | readonly string[];
			value: Schema;
			maxKeys: number;
	  }
	| { t: "array"; items: Schema; max: number }
	| { t: "string"; s: StringKind }
	| { t: "number" }
	| { t: "integer" }
	| { t: "boolean" }
	| { t: "null" }
	| { t: "oneOf"; of: readonly Schema[] };

const obj = (
	props: Record<string, Schema>,
	optional: readonly string[] = [],
): Schema => ({
	t: "object",
	props,
	optional,
});
const arr = (items: Schema, max = 10_000): Schema => ({
	t: "array",
	items,
	max,
});
const str = (s: StringKind): Schema => ({ t: "string", s });
const text = (max = 200) => str({ kind: "text", max });
const ident = (max = 128) => str({ kind: "ident", max });
const path = (max = 512) => str({ kind: "path", max });
const lit = (...values: string[]) => str({ kind: "literal", values });
const num: Schema = { t: "number" };
const int: Schema = { t: "integer" };
const bool: Schema = { t: "boolean" };
const nul: Schema = { t: "null" };
const oneOf = (...of: Schema[]): Schema => ({ t: "oneOf", of });
const nullable = (schema: Schema) => oneOf(schema, nul);
const sha40 = str({ kind: "hex", length: 40 });
const sha256 = str({ kind: "hex", length: 64 });
const iso = str({
	kind: "pattern",
	pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
	label: "ISO-8601 UTC timestamp",
});
const log = (maxBytes = 1024 * 1024) => str({ kind: "log", maxBytes });

/** No control characters; non-ASCII text (`…`, `—`) is fine. Logs may also
 * carry tabs and line breaks. */
function hasControl(value: string, allowLineBreaks: boolean): boolean {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (allowLineBreaks && (code === 9 || code === 10 || code === 13)) continue;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}
const PRINTABLE = { test: (value: string) => !hasControl(value, false) };
const PRINTABLE_LINES = { test: (value: string) => !hasControl(value, true) };
const IDENT = /^[A-Za-z0-9 ._:@()+,=\-<>[\]#*?/]*$/;
const PATH = /^[A-Za-z0-9 ._/<>@+\-[\]~]*$/;
const SYMBOL = /^[A-Za-z0-9_$.:<>, &*()[\]{}'-]*$/;

function stringProblem(value: string, s: StringKind): string | undefined {
	switch (s.kind) {
		case "text":
			if (value.length > s.max) return `longer than ${s.max}`;
			if (!PRINTABLE.test(value)) return "non-printable characters";
			return opaqueRunReason(value);
		case "ident":
			if (value.length > s.max) return `longer than ${s.max}`;
			if (!IDENT.test(value)) return "characters outside the identifier set";
			return opaqueRunReason(value);
		case "path": {
			if (value.length > s.max) return `longer than ${s.max}`;
			if (!PATH.test(value)) return "characters outside the path set";
			// libFuzzer names corpus files by their sha1; that segment is exempt.
			const segments = value
				.split("/")
				.filter((seg) => !/^[0-9a-f]{40}$/.test(seg));
			return opaqueRunReason(segments.join("  "));
		}
		case "symbol":
			// Compiler-mangled names; charset-restricted and still decode-rescanned.
			if (value.length > s.max) return `longer than ${s.max}`;
			return SYMBOL.test(value)
				? undefined
				: "characters outside the symbol set";
		case "hex":
			return new RegExp(`^[0-9a-f]{${s.length}}$`).test(value)
				? undefined
				: `not ${s.length} lowercase hex characters`;
		case "hexRange":
			return new RegExp(`^[0-9a-f]{${s.min},${s.max}}$`).test(value)
				? undefined
				: `not ${s.min}..${s.max} lowercase hex characters`;
		case "base64": {
			const length = Math.ceil(s.bytes / 3) * 4;
			const pad = (3 - (s.bytes % 3)) % 3;
			return new RegExp(`^[A-Za-z0-9+/]{${length - pad}}={${pad}}$`).test(value)
				? undefined
				: `not base64 of ${s.bytes} bytes`;
		}
		case "pattern":
			return s.pattern.test(value) ? undefined : `not a ${s.label}`;
		case "literal":
			return s.values.includes(value) ? undefined : "not an allowed value";
		case "log": {
			if (value.length > s.maxBytes) return `longer than ${s.maxBytes}`;
			if (!PRINTABLE_LINES.test(value)) return "non-printable characters";
			const lines = value.split(/\r?\n/);
			for (const [index, line] of lines.entries()) {
				const reason = opaqueRunReason(line);
				if (reason) return `line ${index + 1}: ${reason}`;
			}
			return undefined;
		}
	}
}

/** Problems of `value` against `schema`, as JSON pointers + reasons. Values
 * are never echoed. */
export function schemaProblems(
	value: unknown,
	schema: Schema,
	pointer = "",
): string[] {
	const at = pointer || "/";
	switch (schema.t) {
		case "object": {
			if (typeof value !== "object" || value === null || Array.isArray(value))
				return [`${at}: must be an object`];
			const problems: string[] = [];
			const record = value as Record<string, unknown>;
			for (const key of Object.keys(record))
				if (!(key in schema.props))
					problems.push(`${at}: unknown field (refused)`);
			for (const [key, child] of Object.entries(schema.props)) {
				if (!(key in record)) {
					if (!schema.optional?.includes(key))
						problems.push(`${at}: missing field ${key}`);
					continue;
				}
				problems.push(
					...schemaProblems(record[key], child, `${pointer}/${key}`),
				);
			}
			return problems;
		}
		case "map": {
			if (typeof value !== "object" || value === null || Array.isArray(value))
				return [`${at}: must be an object`];
			const entries = Object.entries(value as Record<string, unknown>);
			if (entries.length > schema.maxKeys) return [`${at}: too many entries`];
			const problems: string[] = [];
			for (const [key, child] of entries) {
				const allowed = Array.isArray(schema.keys)
					? (schema.keys as readonly string[]).includes(key)
					: (schema.keys as RegExp).test(key);
				if (!allowed) {
					problems.push(`${at}: field name not allowed (refused)`);
					continue;
				}
				problems.push(
					...schemaProblems(child, schema.value, `${pointer}/${key}`),
				);
			}
			return problems;
		}
		case "array": {
			if (!Array.isArray(value)) return [`${at}: must be an array`];
			if (value.length > schema.max)
				return [`${at}: more than ${schema.max} items`];
			return value.flatMap((item, index) =>
				schemaProblems(item, schema.items, `${pointer}/${index}`),
			);
		}
		case "string": {
			if (typeof value !== "string") return [`${at}: must be a string`];
			const problem = stringProblem(value, schema.s);
			return problem ? [`${at}: ${problem}`] : [];
		}
		case "number":
			return typeof value === "number" && Number.isFinite(value)
				? []
				: [`${at}: must be a number`];
		case "integer":
			return Number.isSafeInteger(value) ? [] : [`${at}: must be an integer`];
		case "boolean":
			return typeof value === "boolean" ? [] : [`${at}: must be a boolean`];
		case "null":
			return value === null ? [] : [`${at}: must be null`];
		case "oneOf": {
			const attempts = schema.of.map((option) =>
				schemaProblems(value, option, pointer),
			);
			if (attempts.some((problems) => problems.length === 0)) return [];
			return attempts.reduce((best, current) =>
				current.length < best.length ? current : best,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Content schemas by name (referenced from docs/release-claims.json)

const platform = obj({ os: ident(32), arch: ident(32), runtime: ident(32) });

const commandRecord = obj({
	schemaVersion: int,
	kind: lit("command"),
	name: ident(80),
	commit: sha40,
	platform,
	toolchain: obj({ name: ident(32), version: ident(64) }),
	command: arr(text(400), 64),
	exitCode: int,
	startedAt: iso,
	finishedAt: iso,
	artifactSha256: sha256,
});

const commandSummary = obj({
	schemaVersion: int,
	kind: lit("summary"),
	commit: sha40,
	generatedAt: iso,
	recordCount: int,
	records: arr(
		obj({
			name: ident(80),
			path: str({
				kind: "pattern",
				pattern: /^(?:commands\/)?[A-Za-z0-9._-]+\.json$/,
				label: "record path",
			}),
			artifactSha256: sha256,
		}),
		1000,
	),
});

/** Documented interop server knobs (see tools/interop/verify-evidence.ts). */
const INTEROP_ENV_KEYS = [
	"WT_IDLE_TIMEOUT_MS",
	"WT_QPACK_MAX_TABLE_CAPACITY",
	"WEBTRANSPORT_INTEROP_HOST",
	"WEBTRANSPORT_INTEROP_QUIC_PORT",
	"WEBTRANSPORT_INTEROP_HEALTH_PORT",
	"WEBTRANSPORT_DATAGRAM_BATCH",
] as const;

const playwrightLocation = obj({ file: path(), line: int, column: int });
const playwrightAnnotation = obj(
	{ type: ident(64), description: text(400), location: playwrightLocation },
	["description", "location"],
);
const playwrightError = obj(
	{
		message: log(64 * 1024),
		stack: log(64 * 1024),
		location: playwrightLocation,
		snippet: log(16 * 1024),
		value: text(400),
	},
	["message", "stack", "location", "snippet", "value"],
);
const playwrightResult = obj(
	{
		workerIndex: int,
		parallelIndex: int,
		status: lit("passed", "failed", "timedOut", "skipped", "interrupted"),
		duration: num,
		error: playwrightError,
		errors: arr(playwrightError, 100),
		stdout: arr(obj({ text: log(256 * 1024) }), 10_000),
		stderr: arr(obj({ text: log(256 * 1024) }), 10_000),
		retry: int,
		startTime: iso,
		annotations: arr(playwrightAnnotation, 100),
		// Attachments (traces, screenshots, bodies) are not publishable.
		attachments: arr(nul, 0),
		errorLocation: playwrightLocation,
	},
	["error", "errorLocation"],
);
const playwrightTest = obj({
	timeout: int,
	annotations: arr(playwrightAnnotation, 100),
	expectedStatus: lit("passed", "failed", "timedOut", "skipped", "interrupted"),
	projectId: ident(64),
	projectName: ident(64),
	results: arr(playwrightResult, 100),
	status: lit("expected", "unexpected", "flaky", "skipped"),
});
const playwrightSpec = obj({
	title: text(300),
	ok: bool,
	tags: arr(ident(64), 50),
	tests: arr(playwrightTest, 100),
	id: str({
		kind: "pattern",
		pattern: /^[0-9a-f]{20}-[0-9a-f]{20}$/,
		label: "Playwright test id",
	}),
	file: path(),
	line: int,
	column: int,
});
// Suites nest; a fixed depth keeps the schema finite.
let playwrightSuite: Schema = obj(
	{
		title: text(300),
		file: path(),
		line: int,
		column: int,
		specs: arr(playwrightSpec, 1000),
	},
	["line", "column"],
);
for (let depth = 0; depth < 6; depth += 1)
	playwrightSuite = obj(
		{
			title: text(300),
			file: path(),
			line: int,
			column: int,
			specs: arr(playwrightSpec, 1000),
			suites: arr(playwrightSuite, 200),
		},
		["line", "column", "suites"],
	);
const playwrightReport = obj({
	config: obj(
		{
			configFile: path(),
			rootDir: path(),
			forbidOnly: bool,
			fullyParallel: bool,
			globalSetup: nullable(path()),
			globalTeardown: nullable(path()),
			globalTimeout: int,
			grep: oneOf(obj({}), arr(obj({}), 10)),
			grepInvert: nullable(oneOf(obj({}), arr(obj({}), 10))),
			maxFailures: int,
			metadata: obj({ actualWorkers: int }, ["actualWorkers"]),
			preserveOutput: ident(32),
			projects: arr(
				obj(
					{
						outputDir: path(),
						repeatEach: int,
						retries: int,
						metadata: obj({ actualWorkers: int }, ["actualWorkers"]),
						id: ident(64),
						name: ident(64),
						testDir: path(),
						testIgnore: arr(path(200), 20),
						testMatch: arr(text(200), 20),
						timeout: int,
					},
					[],
				),
				20,
			),
			quiet: bool,
			reporter: arr(
				arr(oneOf(path(), nul, obj({ outputFile: path() }, ["outputFile"])), 2),
				10,
			),
			reportSlowTests: nullable(obj({ max: int, threshold: int })),
			runAgents: ident(32),
			shard: nullable(obj({ current: int, total: int })),
			tags: arr(ident(64), 50),
			updateSnapshots: ident(32),
			updateSourceMethod: ident(32),
			version: ident(32),
			workers: int,
			webServer: nullable(
				obj(
					{
						command: text(400),
						cwd: path(),
						url: str({
							kind: "pattern",
							pattern: /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/?$/,
							label: "loopback URL",
						}),
						port: int,
						env: {
							t: "map",
							keys: INTEROP_ENV_KEYS,
							value: ident(64),
							maxKeys: INTEROP_ENV_KEYS.length,
						},
						reuseExistingServer: bool,
						timeout: int,
						stdout: ident(16),
						stderr: ident(16),
						name: ident(64),
					},
					[
						"command",
						"cwd",
						"url",
						"port",
						"env",
						"reuseExistingServer",
						"timeout",
						"stdout",
						"stderr",
						"name",
					],
				),
			),
		},
		[
			"globalSetup",
			"globalTeardown",
			"grepInvert",
			"metadata",
			"runAgents",
			"tags",
			"updateSourceMethod",
			"webServer",
			"shard",
			"reportSlowTests",
		],
	),
	suites: arr(playwrightSuite, 1000),
	errors: arr(playwrightError, 100),
	stats: obj({
		startTime: iso,
		duration: num,
		expected: int,
		skipped: int,
		unexpected: int,
		flaky: int,
	}),
});

const fuzzCommandResult = obj(
	{
		command: arr(text(400), 64),
		exitCode: int,
		stdout: log(),
		stderr: log(),
		stdoutBytes: int,
		stderrBytes: int,
		durationMs: num,
		timeoutMs: int,
		timedOut: bool,
		timeoutSignal: nullable(ident(16)),
		drainTimeoutMs: int,
		drainDurationMs: num,
		drainTimedOut: bool,
	},
	[
		"stdout",
		"stderr",
		"stdoutBytes",
		"stderrBytes",
		"durationMs",
		"timeoutMs",
		"timeoutSignal",
		"drainTimeoutMs",
		"drainDurationMs",
		"drainTimedOut",
	],
);
const fuzzReleaseSmoke = obj(
	{
		createdAt: iso,
		fixedDurationSecs: num,
		toolchain: obj({
			rust: ident(32),
			cargo: text(200),
			cargoFuzz: text(200),
			llvmSymbolizer: path(),
		}),
		corpora: arr(
			obj({
				target: ident(64),
				files: arr(obj({ path: path(), bytes: int }), 100_000),
			}),
			100,
		),
		commandResults: arr(fuzzCommandResult, 100),
		crashRoot: path(),
		failures: arr(text(2000), 100),
	},
	["toolchain", "corpora", "commandResults", "crashRoot"],
);

const numberTuple = arr(oneOf(num, bool), 16);
const coverageSummaryPart = obj(
	{ count: int, covered: int, notcovered: int, percent: num },
	["notcovered", "covered", "percent"],
);
const coverageSummary = obj(
	{
		lines: coverageSummaryPart,
		functions: coverageSummaryPart,
		instantiations: coverageSummaryPart,
		regions: coverageSummaryPart,
		branches: coverageSummaryPart,
		mcdc: coverageSummaryPart,
	},
	["instantiations", "branches", "mcdc", "regions"],
);
const llvmCovExport = obj({
	data: arr(
		obj(
			{
				files: arr(
					obj(
						{
							filename: path(1024),
							segments: arr(numberTuple, 10_000_000),
							branches: arr(numberTuple, 10_000_000),
							mcdc_records: arr(
								arr(oneOf(num, bool, arr(oneOf(num, bool), 64)), 64),
								1_000_000,
							),
							expansions: arr(
								obj(
									{
										filenames: arr(path(1024), 100),
										source_region: numberTuple,
										target_regions: arr(numberTuple, 1_000_000),
										branches: arr(numberTuple, 1_000_000),
										mcdc_records: arr(
											arr(oneOf(num, bool, arr(oneOf(num, bool), 64)), 64),
											1_000_000,
										),
									},
									["branches", "mcdc_records"],
								),
								1_000_000,
							),
							summary: coverageSummary,
						},
						["segments", "branches", "mcdc_records", "expansions"],
					),
					100_000,
				),
				functions: arr(
					obj(
						{
							name: str({ kind: "symbol", max: 4096 }),
							count: int,
							regions: arr(numberTuple, 1_000_000),
							branches: arr(numberTuple, 1_000_000),
							mcdc_records: arr(
								arr(oneOf(num, bool, arr(oneOf(num, bool), 64)), 64),
								1_000_000,
							),
							filenames: arr(path(1024), 100),
						},
						["branches", "mcdc_records"],
					),
					10_000_000,
				),
				totals: coverageSummary,
			},
			["functions"],
		),
		16,
	),
	type: lit("llvm.coverage.json.export"),
	version: ident(16),
});

const distributedScale = obj(
	{
		createdAt: iso,
		bunVersion: ident(32),
		rustcVersion: nullable(text(200)),
		source: obj({
			sha: nullable(sha40),
			branch: nullable(ident(200)),
			commandLine: text(1000),
		}),
		loadClientEnv: obj({
			probeTimeoutMs: nullable(ident(16)),
			clientBinOverridden: bool,
		}),
		promotable: bool,
		acknowledgedReviewRequired: bool,
		// The campaign's own telemetry: numbers, flags and short identifiers
		// under camelCase names, typed by the telemetry schema below.
		transportPolicy: {
			t: "map",
			keys: /^[a-z][A-Za-z0-9]{0,63}$/,
			value: oneOf(num, bool, nul, ident(128)),
			maxKeys: 200,
		},
		authoritativeRssBaseline: oneOf(ident(64), num, nul),
		rssBaselinePolicy: oneOf(ident(200), nul, {
			t: "map",
			keys: /^[a-z][A-Za-z0-9]{0,63}$/,
			value: oneOf(num, bool, nul, ident(200)),
			maxKeys: 100,
		}),
		processIsolatedRss: oneOf(nul, telemetry(4)),
		config: telemetry(4),
		summary: telemetry(5),
	},
	[
		"rustcVersion",
		"authoritativeRssBaseline",
		"rssBaselinePolicy",
		"processIsolatedRss",
	],
);

/** Nested numeric telemetry: camelCase keys, numbers/flags/short identifiers,
 * bounded depth. Used only for the distributed-scale campaign record (not a
 * GA-blocking claim), whose summary is too large to enumerate field by field. */
function telemetry(depth: number): Schema {
	const leaf = oneOf(num, bool, nul, ident(256));
	if (depth === 0) return leaf;
	const inner = telemetry(depth - 1);
	return oneOf(leaf, arr(inner, 100_000), {
		t: "map",
		keys: /^(?:[a-z][A-Za-z0-9]{0,63}|\d{1,6}|[a-z][a-z0-9-]{0,63})$/,
		value: inner,
		maxKeys: 1000,
	});
}

const npmPublishIdentity = obj({
	schemaVersion: int,
	repository: str({
		kind: "pattern",
		pattern: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
		label: "repository",
	}),
	workflowPath: lit(".github/workflows/release.yml"),
	releaseRunId: int,
	releaseRunAttempt: int,
	candidateCommit: sha40,
	tag: str({
		kind: "pattern",
		pattern: /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/,
		label: "release tag",
	}),
	packageVersion: str({
		kind: "pattern",
		pattern: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/,
		label: "version",
	}),
	tarball: str({
		kind: "pattern",
		pattern: /^[A-Za-z0-9._-]+\.tgz$/,
		label: "tarball name",
	}),
	tarballSha256: sha256,
});

const toolIdentity = obj({ path: path(), version: text(200) });
const soakAggregate = obj({
	mode: lit("aggregate"),
	status: lit("pass"),
	segmentCount: int,
	expectedSegmentCount: int,
	candidateCommit: sha40,
	seed: ident(128),
	continuityTokenDigest: sha256,
	source: obj({ head: sha40, dirty: bool }),
	workflowSource: obj({ ref: nullable(ident(200)), sha: nullable(sha40) }),
	runnerType: ident(32),
	runnerMode: ident(32),
	runnerProfile: ident(64),
	rates: obj({ sessions: num, datagramsPerSec: num, streamsPerSec: num }),
	thresholds: obj({
		maxSessionErrors: num,
		maxDatagramErrors: num,
		maxStreamErrors: num,
		rssTrendMaxRel: num,
		rssTrendMinAbsMb: num,
		rssCeilMb: num,
		maxGapMs: num,
	}),
	debugKnobs: nullable(
		obj({ heapDebug: bool, heapDebugIntervalMs: num, committedAbortMb: num }),
	),
	h7Delivery: {
		t: "map",
		keys: [
			"datagramBatchRequested",
			"datagramBatchResolved",
			"payloadDeliveryRequested",
			"payloadDeliveryResolved",
			"diagnosticsEnabled",
		],
		value: oneOf(num, bool, nul, ident(64)),
		maxKeys: 5,
	},
	datagramsSent: num,
	datagramsReceived: num,
	deliveryRatio: num,
	toolchain: obj({
		bun: ident(64),
		rustc: text(200),
		cc: toolIdentity,
		cxx: toolIdentity,
	}),
	segments: arr(
		obj({
			index: int,
			file: str({
				kind: "pattern",
				pattern: /^soak-segment-\d{2}-of-\d{2}\.json$/,
				label: "segment file",
			}),
			finalStateHash: sha256,
			startedAtMs: num,
			endedAtMs: num,
			status: lit("pass", "fail"),
		}),
		1000,
	),
	totalDurationSeconds: num,
	aggregateHash: sha256,
});

const iwaEvidence = obj(
	{
		schemaVersion: int,
		status: lit("passed"),
		startedAt: iso,
		finishedAt: iso,
		executionIdentity: lit("browser-iwa-direct-sockets"),
		origin: str({
			kind: "pattern",
			pattern: /^isolated-app:\/\/[a-z2-7]{56}\/?$/,
			label: "IWA origin",
		}),
		protocol: lit("isolated-app:"),
		crossOriginIsolated: bool,
		directSockets: bool,
		functional: obj({
			datagram: ident(64),
			bidi: ident(64),
			uni: ident(64),
			resetCode: int,
			stopSendingCode: int,
			peerClose: obj({ code: int, reason: text(200) }, ["reason"]),
		}),
		reconnects: arr(obj({ attempt: int, payload: ident(64) }), 16),
		certificateRotation: obj({
			oldPinRejected: bool,
			oldHash: str({ kind: "base64", bytes: 32 }),
			newHash: str({ kind: "base64", bytes: 32 }),
			payload: ident(64),
		}),
		browser: text(400),
		sourceCommit: sha40,
		signedBundlePath: path(),
		signedBundleSha256: sha256,
		unsignedBundlePath: path(),
		unsignedBundleSha256: sha256,
		browserVersion: ident(64),
		browserChannel: ident(64),
		browserExecutable: nullable(path()),
		localNetworkPermission: ident(64),
		playwrightVersion: ident(32),
	},
	[
		"startedAt",
		"finishedAt",
		"origin",
		"browser",
		"signedBundlePath",
		"unsignedBundlePath",
		"browserExecutable",
		"browserChannel",
		"localNetworkPermission",
		"playwrightVersion",
		"signedBundleSha256",
		"unsignedBundleSha256",
		"browserVersion",
	],
);

const reviewRecord = obj(
	{
		schemaVersion: int,
		kind: lit("review"),
		commit: sha40,
		reviewer: text(120),
		scope: text(400),
		reviewedAt: iso,
		verdict: lit("pass", "fail"),
		findings: obj({ P0: int, P1: int, P2: int, P3: int, P4: int }),
		notes: text(2000),
	},
	["reviewedAt", "notes"],
);

const noChangeConfirmation = obj(
	{
		schemaVersion: int,
		kind: lit("no-change-confirmation"),
		commit: sha40,
		frozenAt: iso,
		confirmedAt: iso,
		verdict: lit("pass", "fail"),
		changedFilesSinceFreeze: arr(path(), 10_000),
		notes: text(2000),
	},
	["confirmedAt", "notes"],
);

/** tools/interop/tests/fault-matrix.spec.ts output (UdpFaultProfile /
 * FaultStats from tools/interop/udp-fault-proxy.ts). */
const faultProfile = obj(
	{
		name: ident(64),
		seed: int,
		lossRate: num,
		duplicateRate: num,
		reorderRate: num,
		delayMs: num,
		jitterMs: num,
		reorderExtraMs: num,
		burstLoss: obj({ startPacket: int, packetCount: int }),
		blackHole: obj({ startMs: num, durationMs: num }),
	},
	[
		"lossRate",
		"duplicateRate",
		"reorderRate",
		"delayMs",
		"jitterMs",
		"reorderExtraMs",
		"burstLoss",
		"blackHole",
	],
);
const faultMatrixEvidence = obj(
	{
		schemaVersion: int,
		status: lit("running", "passed", "failed"),
		sourceCommit: oneOf(sha40, lit("local-unbound")),
		startedAt: iso,
		finishedAt: iso,
		scenarios: arr(
			obj({
				profile: faultProfile,
				stats: obj({
					seen: int,
					forwarded: int,
					dropped: int,
					duplicated: int,
					delayed: int,
					reordered: int,
					blackHoled: int,
					burstDropped: int,
				}),
				payload: ident(128),
				durationMs: num,
			}),
			100,
		),
		error: log(64 * 1024),
	},
	["finishedAt", "error"],
);

export const JSON_SCHEMAS: Record<string, Schema> = {
	"fault-matrix-evidence": faultMatrixEvidence,
	"command-record": commandRecord,
	"command-summary": commandSummary,
	"playwright-report": playwrightReport,
	"fuzz-release-smoke": fuzzReleaseSmoke,
	"llvm-cov-export": llvmCovExport,
	"distributed-scale-artifact": distributedScale,
	"npm-publish-identity": npmPublishIdentity,
	"soak-aggregate": soakAggregate,
	"iwa-evidence": iwaEvidence,
	"review-record": reviewRecord,
	"no-change-confirmation": noChangeConfirmation,
};

/** Line grammars for declared text members. */
export const TEXT_SCHEMAS: Record<string, { line: RegExp; maxBytes: number }> =
	{
		// Bun's LCOV output.
		lcov: {
			line: /^(?:TN:[A-Za-z0-9_ .-]*|SF:[A-Za-z0-9 ._/<>@+\-[\]~]+|FN:\d+(?:,\d+)?,[A-Za-z0-9_$.<>@ #-]*|FNDA:\d+,[A-Za-z0-9_$.<>@ #-]*|FNF:\d+|FNH:\d+|DA:\d+,\d+(?:,[A-Za-z0-9+/=]*)?|LF:\d+|LH:\d+|BRDA:\d+,\d+,\d+,(?:\d+|-)|BRF:\d+|BRH:\d+|end_of_record|)$/,
			maxBytes: 64 * 1024 * 1024,
		},
	};

export const CONTENT_SCHEMA_NAMES = new Set([
	...Object.keys(JSON_SCHEMAS),
	...Object.keys(TEXT_SCHEMAS),
]);

export type DeclaredFile = { match: string; schema: string };

/** Glob (`*` within a segment, `**` across segments) matched against the
 * member name, anchored at a path-segment boundary at the start. */
export function globToRegExp(glob: string): RegExp {
	let pattern = "";
	for (let i = 0; i < glob.length; i += 1) {
		const char = glob[i] as string;
		if (char === "*" && glob[i + 1] === "*") {
			pattern += ".*";
			i += 1;
		} else if (char === "*") pattern += "[^/]*";
		else pattern += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`(?:^|/)${pattern}$`);
}

export type ContentMember = { name: string; data: Uint8Array };

/** Allowlist check of a bundle's members against the files its proof kind
 * declares. Every member must match exactly one declared file and satisfy
 * its schema. */
export function contentProblems(
	members: ContentMember[],
	declared: readonly DeclaredFile[],
): string[] {
	const problems: string[] = [];
	const rules = declared.map((file) => ({
		...file,
		regexp: globToRegExp(file.match),
	}));
	for (const member of members) {
		const matching = rules.filter((rule) => rule.regexp.test(member.name));
		if (matching.length !== 1) {
			problems.push(
				`${member.name}: ${matching.length === 0 ? "not a file this proof kind may contain (refused)" : "matches more than one declared file"}`,
			);
			continue;
		}
		const rule = matching[0] as (typeof rules)[number];
		let decoded: string;
		try {
			decoded = new TextDecoder("utf-8", { fatal: true }).decode(member.data);
		} catch {
			problems.push(`${member.name}: not UTF-8 text`);
			continue;
		}
		const textSchema = TEXT_SCHEMAS[rule.schema];
		if (textSchema) {
			if (decoded.length > textSchema.maxBytes)
				problems.push(`${member.name}: too large`);
			for (const [index, line] of decoded.split(/\r?\n/).entries()) {
				if (!textSchema.line.test(line)) {
					problems.push(
						`${member.name}:${index + 1}: line outside the ${rule.schema} grammar`,
					);
					break;
				}
			}
			continue;
		}
		const schema = JSON_SCHEMAS[rule.schema];
		if (!schema) {
			problems.push(`${member.name}: unknown content schema ${rule.schema}`);
			continue;
		}
		let document: unknown;
		try {
			document = JSON.parse(decoded);
		} catch {
			problems.push(`${member.name}: invalid JSON`);
			continue;
		}
		for (const problem of schemaProblems(document, schema).slice(0, 20))
			problems.push(
				`${member.name}${problem.startsWith("/") ? "" : " "}${problem}`,
			);
	}
	return problems;
}
