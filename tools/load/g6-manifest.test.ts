import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createG6EvidenceDirectory,
	G6_BUNDLE_METADATA,
	G6_BUNDLE_SUMS,
	type G6BundleFileInput,
	type G6ManifestWriteOptions,
	verifyG6Manifest,
	writeG6Manifest,
} from "./g6-manifest.ts";

const roots: string[] = [];
const CANDIDATE = "1".repeat(40);
const OTHER_CANDIDATE = "2".repeat(40);
const TREE = "3".repeat(40);
const PREREGISTRATION_ID = "g6-mmo-closeout/1";
const PREREGISTRATION_PATH =
	"docs/research/preregistrations/gate-g6-mmo-closeout.md";
const REGISTRATION_ID = "g6-mmo-04-closeout/1";
const REGISTRATION_PATH =
	"bare-metal-campaign/registrations/g6-mmo-04-closeout.md";

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "g6-manifest-test-"));
	roots.push(root);
	return root;
}

function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function writePayload(
	bundleDir: string,
	files: G6BundleFileInput[],
	path: string,
	role: G6BundleFileInput["role"],
	contents: string,
	extra: Partial<G6BundleFileInput> = {},
): void {
	const absolute = join(bundleDir, path);
	const parent = absolute.slice(0, absolute.lastIndexOf("/"));
	mkdirSync(parent, { recursive: true });
	writeFileSync(absolute, contents);
	files.push({ path, role, ...extra });
}

type Fixture = {
	bundleDir: string;
	options: G6ManifestWriteOptions;
	files: G6BundleFileInput[];
	preRegistration: {
		id: typeof PREREGISTRATION_ID;
		path: typeof PREREGISTRATION_PATH;
		sha256: string;
	};
	registration: {
		id: typeof REGISTRATION_ID;
		path: typeof REGISTRATION_PATH;
		sha256: string;
	};
};

function identityCopies(candidateSha = CANDIDATE): {
	preregistrationText: string;
	registrationText: string;
	preRegistration: Fixture["preRegistration"];
	registration: Fixture["registration"];
} {
	const preregistrationText = [
		"# G6 closeout preregistration",
		`Identity: ${PREREGISTRATION_ID}`,
		`Authority path: ${PREREGISTRATION_PATH}`,
		"",
	].join("\n");
	const preRegistration = {
		id: PREREGISTRATION_ID,
		path: PREREGISTRATION_PATH,
		sha256: sha256(preregistrationText),
	} as const;
	const registrationText = [
		"# G6 MMO-04 successor registration",
		`Registration id: ${REGISTRATION_ID}`,
		`Registration path: ${REGISTRATION_PATH}`,
		`Candidate SHA: ${candidateSha}`,
		`Tree SHA: ${TREE}`,
		`Tracked preregistration id/path: ${preRegistration.id}, ${preRegistration.path}`,
		`Tracked preregistration SHA-256: ${preRegistration.sha256}`,
		"Runner host: runner-a",
		"Generator host: mac-generator",
		"Host identity: runner=runner-a;generator=mac-generator",
		"",
	].join("\n");
	return {
		preregistrationText,
		registrationText,
		preRegistration,
		registration: {
			id: REGISTRATION_ID,
			path: REGISTRATION_PATH,
			sha256: sha256(registrationText),
		},
	};
}

function requiredIdentityFiles(
	bundleDir: string,
	files: G6BundleFileInput[],
	candidateSha = CANDIDATE,
) {
	const copies = identityCopies(candidateSha);
	writePayload(
		bundleDir,
		files,
		"preregistration.md",
		"preregistration-copy",
		copies.preregistrationText,
	);
	writePayload(
		bundleDir,
		files,
		"registration.md",
		"registration-copy",
		copies.registrationText,
	);
	writePayload(
		bundleDir,
		files,
		"host-identity.json",
		"host-identity",
		json({
			schema: "g6-host-identity/1",
			runnerHost: "runner-a",
			generatorHost: "mac-generator",
			identity: "runner=runner-a;generator=mac-generator",
		}),
	);
	writePayload(
		bundleDir,
		files,
		"source-identity.json",
		"source-identity",
		json({
			schema: "g6-source-identity/1",
			candidateSha,
			treeSha: TREE,
			dirty: false,
			externalInputs: {},
		}),
	);
	return copies;
}

function makeFullFixture(
	status: G6ManifestWriteOptions["status"] = "COMPLETE",
): Fixture {
	const bundleDir = join(makeRoot(), "bundle");
	mkdirSync(bundleDir);
	const files: G6BundleFileInput[] = [];
	const copies = requiredIdentityFiles(bundleDir, files);
	const preRegistration = copies.preRegistration;
	writePayload(
		bundleDir,
		files,
		"bench-g6.json",
		"g6-json",
		json({
			schema: "bench-g6/2",
			preRegistration,
			source: { candidateSha: CANDIDATE },
			host: { identity: "runner-a" },
			complete: status === "COMPLETE",
		}),
	);
	writePayload(
		bundleDir,
		files,
		"bench-g6.csv",
		"g6-csv",
		"arm,sessions\nsteady,5000\n",
	);
	for (const role of ["realm", "subscriber", "publisher"] as const) {
		writePayload(
			bundleDir,
			files,
			`raw/${role}.json`,
			`${role}-report`,
			json({ schema: "mmo-client/2", preRegistration, role }),
		);
		writePayload(
			bundleDir,
			files,
			`raw/${role}.log`,
			`${role}-log`,
			`${role}: exit=0\n`,
		);
	}
	for (const [path, role] of [
		["inputs/preflight-down.json", "preflight-down"],
		["inputs/preflight-up.json", "preflight-up"],
		["inputs/sink.json", "sink"],
	] as const) {
		writePayload(bundleDir, files, path, role, json({ schema: `${role}/1` }));
	}
	writePayload(
		bundleDir,
		files,
		"inputs/floor.log",
		"floor",
		`macgen: host=mac-generator\nmmo-client: json ${JSON.stringify({
			schema: "mmo-client/2",
			preRegistration,
			role: "realm",
		})}\n`,
	);
	const externalInputPaths = [
		"inputs/preflight-down.json",
		"inputs/preflight-up.json",
		"inputs/floor.log",
		"inputs/sink.json",
	];
	writeFileSync(
		join(bundleDir, "source-identity.json"),
		json({
			schema: "g6-source-identity/1",
			candidateSha: CANDIDATE,
			treeSha: TREE,
			dirty: false,
			externalInputs: Object.fromEntries(
				externalInputPaths.map((path) => [
					path,
					sha256(readFileSync(join(bundleDir, path))),
				]),
			),
		}),
	);
	writePayload(
		bundleDir,
		files,
		"classified.json",
		"classified",
		json({
			schema: "g6-classified/2",
			preRegistration,
			inputSha256: {
				artifactJson: sha256(readFileSync(join(bundleDir, "bench-g6.json"))),
				artifactCsv: sha256(readFileSync(join(bundleDir, "bench-g6.csv"))),
				preflightDown: sha256(
					readFileSync(join(bundleDir, "inputs/preflight-down.json")),
				),
				preflightUp: sha256(
					readFileSync(join(bundleDir, "inputs/preflight-up.json")),
				),
				floor: sha256(readFileSync(join(bundleDir, "inputs/floor.log"))),
				sink: sha256(readFileSync(join(bundleDir, "inputs/sink.json"))),
			},
			source: {
				candidateSha: CANDIDATE,
				graderSha: CANDIDATE,
				generatorHost: "mac-generator",
			},
			final: { valid: status === "COMPLETE", gate: "MISS" },
		}),
	);
	writePayload(
		bundleDir,
		files,
		"profiles.json",
		"profiles",
		json({ available: false, files: [] }),
	);
	writePayload(
		bundleDir,
		files,
		"comparison.md",
		"comparison",
		"# G6 comparison\n",
	);
	return {
		bundleDir,
		files,
		preRegistration,
		registration: copies.registration,
		options: {
			bundleDir,
			kind: "full-g6",
			status,
			candidateSha: CANDIDATE,
			preRegistration,
			registration: copies.registration,
			files,
		},
	};
}

function makeAttributionFixture(): Fixture {
	const bundleDir = join(makeRoot(), "bundle");
	mkdirSync(bundleDir);
	const files: G6BundleFileInput[] = [];
	const copies = requiredIdentityFiles(bundleDir, files);
	const preRegistration = copies.preRegistration;
	writePayload(
		bundleDir,
		files,
		"aggregate.json",
		"attribution-aggregate",
		json({
			schema: "g6-attribution/1",
			candidateSha: CANDIDATE,
			preRegistration,
			identity: { valid: true, reasons: [] },
			outcome: {
				valid: true,
				cpuAttributionAllowed: false,
				reasons: ["issued parity diverged"],
			},
			legs: Array.from(
				{ length: 9 },
				(_, leg) => `legs/${String(leg).padStart(2, "0")}.json`,
			),
		}),
	);
	writePayload(
		bundleDir,
		files,
		"comparison.md",
		"comparison",
		"# Attribution comparison\n",
	);
	writePayload(
		bundleDir,
		files,
		"profiles.json",
		"profiles",
		json({ available: false, files: [] }),
	);
	for (let leg = 0; leg < 9; leg += 1) {
		const legName = String(leg).padStart(2, "0");
		writePayload(
			bundleDir,
			files,
			`legs/${legName}.json`,
			"attribution-leg",
			json({
				schema: "g6-attribution-leg/1",
				candidateSha: CANDIDATE,
				preRegistration,
				identityLeg: { candidateSha: CANDIDATE },
				hostIdentity: "runner=runner-a;generator=mac-generator",
				rawProcessReports: {
					client: `raw/${legName}-client.json`,
					server: `raw/${legName}-server.json`,
				},
			}),
			{ leg },
		);
		for (const process of ["client", "server"] as const) {
			writePayload(
				bundleDir,
				files,
				`raw/${legName}-${process}.json`,
				process === "client"
					? "attribution-raw-client"
					: "attribution-raw-server",
				json({
					schema: `g6-attribution-${process}/1`,
					preRegistration,
					candidateSha: CANDIDATE,
					hostIdentity: "runner=runner-a;generator=mac-generator",
				}),
				{ leg },
			);
		}
	}
	return {
		bundleDir,
		files,
		preRegistration,
		registration: copies.registration,
		options: {
			bundleDir,
			kind: "attribution",
			status: "COMPLETE",
			candidateSha: CANDIDATE,
			preRegistration,
			registration: copies.registration,
			files,
		},
	};
}

function expectations(fixture: Fixture) {
	return {
		candidateSha: CANDIDATE,
		preRegistrationSha256: fixture.preRegistration.sha256,
		registrationSha256: fixture.registration.sha256,
	};
}

function removeRole(fixture: Fixture, role: G6BundleFileInput["role"]): void {
	const index = fixture.files.findIndex((file) => file.role === role);
	if (index < 0) throw new Error(`fixture missing role ${role}`);
	const [entry] = fixture.files.splice(index, 1);
	if (!entry) throw new Error(`fixture failed to remove role ${role}`);
	rmSync(join(fixture.bundleDir, entry.path));
}

describe("G6 evidence manifest", () => {
	test("creates evidence directories once and refuses overwrite", () => {
		const directory = join(makeRoot(), "evidence");
		createG6EvidenceDirectory(directory);
		expect(() => createG6EvidenceDirectory(directory)).toThrow(
			/already exists/i,
		);
	});

	test("writes and verifies complete full-G6 bundles deterministically", () => {
		const first = makeFullFixture();
		const second = makeFullFixture();
		const firstMetadata = writeG6Manifest(first.options);
		const secondMetadata = writeG6Manifest(second.options);

		expect(verifyG6Manifest(first.bundleDir, expectations(first))).toEqual({
			kind: "full-g6",
			status: "COMPLETE",
			stampable: true,
			fileCount: firstMetadata.files.length,
		});
		expect(verifyG6Manifest(second.bundleDir, expectations(second))).toEqual({
			kind: "full-g6",
			status: "COMPLETE",
			stampable: true,
			fileCount: secondMetadata.files.length,
		});
		expect(
			readFileSync(join(first.bundleDir, G6_BUNDLE_METADATA), "utf8"),
		).toBe(readFileSync(join(second.bundleDir, G6_BUNDLE_METADATA), "utf8"));
		expect(readFileSync(join(first.bundleDir, G6_BUNDLE_SUMS), "utf8")).toBe(
			readFileSync(join(second.bundleDir, G6_BUNDLE_SUMS), "utf8"),
		);
	});

	test("requires CSV and every raw role report in a complete full-G6 bundle", () => {
		const missingCsv = makeFullFixture();
		removeRole(missingCsv, "g6-csv");
		expect(() => writeG6Manifest(missingCsv.options)).toThrow(/g6-csv/);

		const missingRole = makeFullFixture();
		removeRole(missingRole, "subscriber-report");
		expect(() => writeG6Manifest(missingRole.options)).toThrow(
			/subscriber-report/,
		);
	});

	test("requires every profile declared by profiles.json", () => {
		const fixture = makeFullFixture();
		writeFileSync(
			join(fixture.bundleDir, "profiles.json"),
			json({ available: true, files: ["profiles/server.cpuprofile"] }),
		);
		expect(() => writeG6Manifest(fixture.options)).toThrow(
			/profiles\/server\.cpuprofile/,
		);
	});

	test("verifies complete attribution bundles with exactly nine raw process pairs", () => {
		const fixture = makeAttributionFixture();
		const metadata = writeG6Manifest(fixture.options);
		expect(verifyG6Manifest(fixture.bundleDir, expectations(fixture))).toEqual({
			kind: "attribution",
			status: "COMPLETE",
			stampable: true,
			fileCount: metadata.files.length,
		});

		const incomplete = makeAttributionFixture();
		const index = incomplete.files.findIndex(
			(file) => file.role === "attribution-raw-server" && file.leg === 8,
		);
		if (index < 0) throw new Error("fixture missing raw server leg 8");
		const [entry] = incomplete.files.splice(index, 1);
		if (!entry) throw new Error("fixture failed to remove raw server leg 8");
		rmSync(join(incomplete.bundleDir, entry.path));
		expect(() => writeG6Manifest(incomplete.options)).toThrow(
			/attribution-raw-server.*leg 8/i,
		);
	});

	test("binds registered runner and generator hosts across complete evidence", () => {
		const full = makeFullFixture();
		const classifiedPath = join(full.bundleDir, "classified.json");
		const classified = JSON.parse(readFileSync(classifiedPath, "utf8")) as {
			source: { generatorHost: string };
		};
		classified.source.generatorHost = "other-generator";
		writeFileSync(classifiedPath, json(classified));
		expect(() => writeG6Manifest(full.options)).toThrow(
			/classified generator host mismatch/i,
		);

		const attribution = makeAttributionFixture();
		const legPath = join(attribution.bundleDir, "legs/00.json");
		const leg = JSON.parse(readFileSync(legPath, "utf8")) as {
			hostIdentity: string;
		};
		leg.hostIdentity = "runner=runner-a;generator=other-generator";
		writeFileSync(legPath, json(leg));
		expect(() => writeG6Manifest(attribution.options)).toThrow(
			/leg 0 host identity mismatch/i,
		);

		const registration = makeFullFixture();
		const registrationPath = join(registration.bundleDir, "registration.md");
		const withoutHostPair = readFileSync(registrationPath, "utf8").replace(
			"Host identity: runner=runner-a;generator=mac-generator\n",
			"",
		);
		writeFileSync(registrationPath, withoutHostPair);
		registration.options.registration = {
			...registration.options.registration,
			sha256: sha256(withoutHostPair),
		};
		expect(() => writeG6Manifest(registration.options)).toThrow(
			/registration copy does not bind host value runner=runner-a;generator=mac-generator/i,
		);
	});

	test("binds the tracked evaluator and every classified grading input", () => {
		const wrongGrader = makeFullFixture();
		const wrongGraderPath = join(wrongGrader.bundleDir, "classified.json");
		const wrongGraderJson = JSON.parse(
			readFileSync(wrongGraderPath, "utf8"),
		) as { source: { graderSha: string } };
		wrongGraderJson.source.graderSha = OTHER_CANDIDATE;
		writeFileSync(wrongGraderPath, json(wrongGraderJson));
		expect(() => writeG6Manifest(wrongGrader.options)).toThrow(
			/classified grader SHA does not match candidate/i,
		);

		const wrongInput = makeFullFixture();
		const wrongInputPath = join(wrongInput.bundleDir, "classified.json");
		const wrongInputJson = JSON.parse(readFileSync(wrongInputPath, "utf8")) as {
			inputSha256: { preflightDown: string };
		};
		wrongInputJson.inputSha256.preflightDown = "f".repeat(64);
		writeFileSync(wrongInputPath, json(wrongInputJson));
		expect(() => writeG6Manifest(wrongInput.options)).toThrow(
			/classified input hash mismatch for preflightDown/i,
		);
	});

	test("binds the clean source tree to the source-bound registration", () => {
		const fixture = makeFullFixture();
		const sourcePath = join(fixture.bundleDir, "source-identity.json");
		writeFileSync(
			sourcePath,
			json({
				schema: "g6-source-identity/1",
				candidateSha: CANDIDATE,
				treeSha: "4".repeat(40),
				dirty: false,
			}),
		);
		expect(() => writeG6Manifest(fixture.options)).toThrow(
			/source tree is not bound by registration/i,
		);

		const dirty = makeFullFixture();
		writeFileSync(
			join(dirty.bundleDir, "source-identity.json"),
			json({
				schema: "g6-source-identity/1",
				candidateSha: CANDIDATE,
				treeSha: TREE,
				dirty: true,
			}),
		);
		expect(() => writeG6Manifest(dirty.options)).toThrow(
			/source identity must bind a clean tree/i,
		);
	});

	test("allows integrity-verifiable partial refusals but never marks them stampable", () => {
		for (const status of ["INVALID", "ABORTED"] as const) {
			const fixture = makeFullFixture(status);
			writePayload(
				fixture.bundleDir,
				fixture.files,
				"refusal.json",
				"partial-json",
				json({
					schema: "g6-refusal/1",
					kind: "full-g6",
					status,
					candidateSha: CANDIDATE,
					preRegistration: fixture.preRegistration,
					reason: "measurement did not complete",
				}),
			);
			for (const entry of [...fixture.files]) {
				if (
					![
						"preregistration-copy",
						"registration-copy",
						"host-identity",
						"source-identity",
						"preflight-down",
						"preflight-up",
						"floor",
						"sink",
						"profiles",
						"comparison",
						"partial-json",
					].includes(entry.role)
				) {
					fixture.files.splice(fixture.files.indexOf(entry), 1);
					rmSync(join(fixture.bundleDir, entry.path));
				}
			}
			const metadata = writeG6Manifest(fixture.options);
			expect(metadata.stampable).toBe(false);
			expect(
				verifyG6Manifest(fixture.bundleDir, expectations(fixture)),
			).toEqual({
				kind: "full-g6",
				status,
				stampable: false,
				fileCount: metadata.files.length,
			});
		}
		for (const status of ["INVALID", "ABORTED"] as const) {
			const fixture = makeAttributionFixture();
			fixture.options.status = status;
			writePayload(
				fixture.bundleDir,
				fixture.files,
				"refusal.json",
				"partial-json",
				json({
					schema: "g6-refusal/1",
					kind: "attribution",
					status,
					candidateSha: CANDIDATE,
					preRegistration: fixture.preRegistration,
					reason: "matrix did not complete",
				}),
			);
			for (const entry of [...fixture.files]) {
				if (
					![
						"preregistration-copy",
						"registration-copy",
						"host-identity",
						"source-identity",
						"profiles",
						"comparison",
						"partial-json",
					].includes(entry.role)
				) {
					fixture.files.splice(fixture.files.indexOf(entry), 1);
					rmSync(join(fixture.bundleDir, entry.path));
				}
			}
			const metadata = writeG6Manifest(fixture.options);
			expect(
				verifyG6Manifest(fixture.bundleDir, expectations(fixture)),
			).toEqual({
				kind: "attribution",
				status,
				stampable: false,
				fileCount: metadata.files.length,
			});
		}
	});

	test("rejects partial bundles without one bound machine-readable refusal", () => {
		for (const kind of ["full-g6", "attribution"] as const) {
			const fixture =
				kind === "full-g6"
					? makeFullFixture("ABORTED")
					: makeAttributionFixture();
			fixture.options.status = "ABORTED";
			for (const entry of [...fixture.files]) {
				if (
					![
						"preregistration-copy",
						"registration-copy",
						"host-identity",
						"source-identity",
						...(kind === "full-g6"
							? ["preflight-down", "preflight-up", "floor", "sink"]
							: []),
						"profiles",
						"comparison",
					].includes(entry.role)
				) {
					fixture.files.splice(fixture.files.indexOf(entry), 1);
					rmSync(join(fixture.bundleDir, entry.path));
				}
			}
			expect(() => writeG6Manifest(fixture.options)).toThrow(/partial-json/i);
		}

		const mismatched = makeFullFixture("INVALID");
		writePayload(
			mismatched.bundleDir,
			mismatched.files,
			"refusal.json",
			"partial-json",
			json({
				schema: "g6-refusal/1",
				kind: "full-g6",
				status: "ABORTED",
				candidateSha: CANDIDATE,
				preRegistration: mismatched.preRegistration,
				reason: "wrong status",
			}),
		);
		expect(() => writeG6Manifest(mismatched.options)).toThrow(
			/refusal status mismatch/i,
		);

		const contradictory = makeFullFixture();
		writePayload(
			contradictory.bundleDir,
			contradictory.files,
			"refusal.json",
			"partial-json",
			json({
				schema: "g6-refusal/1",
				kind: "full-g6",
				status: "ABORTED",
				candidateSha: CANDIDATE,
				preRegistration: contradictory.preRegistration,
				reason: "contradictory complete bundle",
			}),
		);
		expect(() => writeG6Manifest(contradictory.options)).toThrow(
			/complete bundle cannot retain a refusal/i,
		);
	});

	test("rejects mutated payloads and external candidate expectations", () => {
		const fixture = makeFullFixture();
		writeG6Manifest(fixture.options);
		writeFileSync(join(fixture.bundleDir, "bench-g6.csv"), "changed\n");
		expect(() =>
			verifyG6Manifest(fixture.bundleDir, expectations(fixture)),
		).toThrow(/hash mismatch.*bench-g6\.csv/i);

		const candidateFixture = makeFullFixture();
		writeG6Manifest(candidateFixture.options);
		expect(() =>
			verifyG6Manifest(candidateFixture.bundleDir, {
				...expectations(candidateFixture),
				candidateSha: OTHER_CANDIDATE,
			}),
		).toThrow(/candidate mismatch/i);
	});

	test("rejects unlisted extras, symlinks, and mechanism tickets", () => {
		const extra = makeFullFixture();
		writeFileSync(join(extra.bundleDir, "unlisted.txt"), "surprise\n");
		expect(() => writeG6Manifest(extra.options)).toThrow(/unlisted\.txt/);

		const symlink = makeFullFixture();
		symlinkSync("bench-g6.csv", join(symlink.bundleDir, "alias.csv"));
		symlink.files.push({ path: "alias.csv", role: "g6-csv" });
		expect(() => writeG6Manifest(symlink.options)).toThrow(/symlink/i);

		const ticket = makeFullFixture();
		writePayload(
			ticket.bundleDir,
			ticket.files,
			"mechanism.md",
			"mechanism-ticket",
			"mutable narrative\n",
		);
		expect(() => writeG6Manifest(ticket.options)).toThrow(/mechanism ticket/i);
	});

	test("rejects unsafe and duplicate portable names", () => {
		for (const unsafePath of [
			"../escape.json",
			"/absolute.json",
			"nested\\windows.json",
		]) {
			const fixture = makeFullFixture();
			fixture.files.push({ path: unsafePath, role: "profile" });
			expect(() => writeG6Manifest(fixture.options)).toThrow(/portable path/i);
		}

		const duplicate = makeFullFixture();
		const first = duplicate.files[0];
		if (!first) throw new Error("fixture has no files");
		duplicate.files.push({ ...first });
		expect(() => writeG6Manifest(duplicate.options)).toThrow(/duplicate/i);

		const unknown = makeFullFixture();
		writePayload(
			unknown.bundleDir,
			unknown.files,
			"unknown.txt",
			"unknown-role" as G6BundleFileInput["role"],
			"unknown\n",
		);
		expect(() => writeG6Manifest(unknown.options)).toThrow(
			/unknown evidence role/i,
		);
	});

	test("requires truthful preregistration and registration copies", () => {
		const prereg = makeFullFixture();
		writeFileSync(join(prereg.bundleDir, "preregistration.md"), "wrong\n");
		expect(() => writeG6Manifest(prereg.options)).toThrow(
			/preregistration.*hash mismatch/i,
		);

		const registration = makeFullFixture();
		const wrong = identityCopies(OTHER_CANDIDATE);
		writeFileSync(
			join(registration.bundleDir, "registration.md"),
			wrong.registrationText,
		);
		registration.options.registration = wrong.registration;
		expect(() => writeG6Manifest(registration.options)).toThrow(
			/registration.*candidate/i,
		);
	});

	test("enforces metadata self-membership without a recursive self hash", () => {
		const fixture = makeFullFixture();
		writeG6Manifest(fixture.options);
		const metadataPath = join(fixture.bundleDir, G6_BUNDLE_METADATA);
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
			files: Array<{ path: string }>;
		};
		metadata.files = metadata.files.filter(
			(entry) => entry.path !== G6_BUNDLE_METADATA,
		);
		writeFileSync(metadataPath, json(metadata));
		const metadataHash = sha256(readFileSync(metadataPath, "utf8"));
		const sumsPath = join(fixture.bundleDir, G6_BUNDLE_SUMS);
		const sums = readFileSync(sumsPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) =>
				line.endsWith(`  ${G6_BUNDLE_METADATA}`)
					? `${metadataHash}  ${G6_BUNDLE_METADATA}`
					: line,
			)
			.join("\n");
		writeFileSync(sumsPath, `${sums}\n`);
		expect(() =>
			verifyG6Manifest(fixture.bundleDir, expectations(fixture)),
		).toThrow(/metadata.*list itself/i);
	});

	test("never overwrites an existing manifest or checksum file", () => {
		const fixture = makeFullFixture();
		writeG6Manifest(fixture.options);
		expect(() => writeG6Manifest(fixture.options)).toThrow(/already exists/i);
	});
});
