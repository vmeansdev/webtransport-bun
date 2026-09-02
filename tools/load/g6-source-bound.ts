/**
 * The consolidated source-bound dispatch input.
 *
 * GitHub refuses to parse a workflow with more than 25 `workflow_dispatch`
 * inputs, and the G6 successor needs twelve source-bound values (registration
 * identity, both host identities, and the four same-day quartet artifacts).
 * Carrying them as one JSON input keeps the workflow dispatchable; this
 * validator is the single point where that blob becomes shell state, so the
 * fail-closed rules live in tracked, tested code rather than in YAML.
 *
 * Reads `G6_SOURCE_BOUND` (the JSON) and `G6_MODE`, and prints one
 * `G6_<NAME>=<value>` line per field on stdout — nothing else. The workflow
 * writes that output to a temp file and later `cat`s it into `GITHUB_ENV`; it
 * never `eval`s it. Every value is held to a strict allowlist charset with no
 * shell metacharacters, so a line can carry no code even if a downstream
 * consumer were to mishandle it. Any defect refuses with exit 2 before a
 * single line is printed.
 *
 * Mode rules: `g6-mmo` requires the full twelve; `g6-attribution` and `ack-reflector-gate` require
 * the registration and host fields and refuses quartet fields outright — an
 * attribution dispatch carrying preflight paths is a mislabeled full run.
 */

const SHA256_RE = /^[0-9a-f]{64}$/;
// Allowlists, not denylists: only these characters may appear, so no shell
// metacharacter (; | & $ ` ( ) < > quotes, backslash, space) can ride through.
const HOST_RE = /^[A-Za-z0-9._-]+$/;
const PATH_RE = /^\/[A-Za-z0-9._/-]+$/;

type FieldRule = {
	key: string;
	env: string;
	kind: "path" | "sha256" | "host";
};

const REGISTRATION_FIELDS: FieldRule[] = [
	{ key: "registrationPath", env: "G6_REGISTRATION_PATH", kind: "path" },
	{ key: "registrationSha256", env: "G6_REGISTRATION_SHA256", kind: "sha256" },
	{ key: "expectedRunnerHost", env: "G6_EXPECTED_RUNNER_HOST", kind: "host" },
	{
		key: "expectedGeneratorHost",
		env: "G6_EXPECTED_GENERATOR_HOST",
		kind: "host",
	},
];

const QUARTET_FIELDS: FieldRule[] = [
	{ key: "preflightDownPath", env: "G6_PREFLIGHT_DOWN_PATH", kind: "path" },
	{
		key: "preflightDownSha256",
		env: "G6_PREFLIGHT_DOWN_SHA256",
		kind: "sha256",
	},
	{ key: "preflightUpPath", env: "G6_PREFLIGHT_UP_PATH", kind: "path" },
	{ key: "preflightUpSha256", env: "G6_PREFLIGHT_UP_SHA256", kind: "sha256" },
	{ key: "floorPath", env: "G6_FLOOR_PATH", kind: "path" },
	{ key: "floorSha256", env: "G6_FLOOR_SHA256", kind: "sha256" },
	{ key: "sinkPath", env: "G6_SINK_PATH", kind: "path" },
	{ key: "sinkSha256", env: "G6_SINK_SHA256", kind: "sha256" },
];

export function parseSourceBound(
	raw: string,
	mode: string,
): { lines: string[] } {
	if (
		mode !== "g6-mmo" &&
		mode !== "g6-attribution" &&
		mode !== "ack-reflector-gate"
	) {
		throw new Error(`source-bound: unsupported mode '${mode}'`);
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("source-bound: input is not valid JSON");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("source-bound: input must be a JSON object");
	}
	const object = value as Record<string, unknown>;
	const rules =
		mode === "g6-mmo"
			? [...REGISTRATION_FIELDS, ...QUARTET_FIELDS]
			: REGISTRATION_FIELDS;
	const allowed = new Set(rules.map((rule) => rule.key));
	for (const key of Object.keys(object)) {
		if (!allowed.has(key)) {
			throw new Error(`source-bound: unexpected field '${key}' for ${mode}`);
		}
	}
	const lines: string[] = [];
	for (const rule of rules) {
		const field = object[rule.key];
		if (typeof field !== "string" || field === "") {
			throw new Error(`source-bound: '${rule.key}' is required`);
		}
		if (rule.kind === "sha256" && !SHA256_RE.test(field)) {
			throw new Error(
				`source-bound: '${rule.key}' must be lowercase 64-hex, got '${field}'`,
			);
		}
		if (rule.kind === "host" && !HOST_RE.test(field)) {
			throw new Error(
				`source-bound: '${rule.key}' must match ${HOST_RE} (no shell metacharacters), got '${field}'`,
			);
		}
		if (rule.kind === "path" && !PATH_RE.test(field)) {
			throw new Error(
				`source-bound: '${rule.key}' must be an absolute path matching ${PATH_RE} (no shell metacharacters), got '${field}'`,
			);
		}
		lines.push(`${rule.env}=${field}`);
	}
	return { lines };
}

if (import.meta.main) {
	try {
		const { lines } = parseSourceBound(
			process.env.G6_SOURCE_BOUND ?? "",
			process.env.G6_MODE ?? "",
		);
		process.stdout.write(`${lines.join("\n")}\n`);
	} catch (error) {
		console.error(String(error instanceof Error ? error.message : error));
		process.exit(2);
	}
}
