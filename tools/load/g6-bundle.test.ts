import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAttributionFailureArtifacts } from "./g6-attribution-server.ts";
import {
	finalizeG6EvidenceBundle,
	type G6BundleAuthorityOptions,
	prepareG6EvidenceBundle,
} from "./g6-bundle.ts";
import { verifyG6Manifest } from "./g6-manifest.ts";

const roots: string[] = [];
const CANDIDATE = "1".repeat(40);
const TREE = "2".repeat(40);
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

function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function fixture(): {
	root: string;
	bundleDir: string;
	authority: G6BundleAuthorityOptions;
} {
	const root = mkdtempSync(join(tmpdir(), "g6-bundle-test-"));
	roots.push(root);
	const preregistrationPath = join(root, "tracked-preregistration.md");
	const preregistrationText = [
		"# G6 closeout preregistration",
		`Identity: ${PREREGISTRATION_ID}`,
		`Authority path: ${PREREGISTRATION_PATH}`,
		"",
	].join("\n");
	writeFileSync(preregistrationPath, preregistrationText);
	const preregistrationSha256 = sha256(preregistrationText);
	const registrationPath = join(root, "registration.md");
	const registrationText = [
		"# G6 MMO-04 successor registration",
		`Registration id: ${REGISTRATION_ID}`,
		`Registration path: ${REGISTRATION_PATH}`,
		`Candidate SHA: ${CANDIDATE}`,
		`Tree SHA: ${TREE}`,
		`Tracked preregistration id/path: ${PREREGISTRATION_ID}, ${PREREGISTRATION_PATH}`,
		`Tracked preregistration SHA-256: ${preregistrationSha256}`,
		"Runner host: runner-a",
		"Generator host: mac-generator",
		"Host identity: runner=runner-a;generator=mac-generator",
		"",
	].join("\n");
	writeFileSync(registrationPath, registrationText);
	return {
		root,
		bundleDir: join(root, "bundle"),
		authority: {
			candidateSha: CANDIDATE,
			treeSha: TREE,
			preRegistrationPath: preregistrationPath,
			preRegistrationSha256: preregistrationSha256,
			registrationPath,
			registrationSha256: sha256(registrationText),
			runnerHost: "runner-a",
			generatorHost: "mac-generator",
		},
	};
}

function writeAttributionOutputs(
	bundleDir: string,
	authority: G6BundleAuthorityOptions,
	valid: boolean,
): void {
	const preRegistration = {
		id: PREREGISTRATION_ID,
		path: PREREGISTRATION_PATH,
		sha256: authority.preRegistrationSha256,
	};
	mkdirSync(join(bundleDir, "legs"), { recursive: true });
	mkdirSync(join(bundleDir, "raw"), { recursive: true });
	const legs: string[] = [];
	for (let leg = 0; leg < 9; leg += 1) {
		const lane = ["full-js", "minimal-js-addon", "direct-rust"][leg % 3];
		if (!lane) throw new Error(`test lane is missing for leg ${leg}`);
		const prefix = `${String(leg).padStart(2, "0")}-${lane}`;
		const legPath = `legs/${prefix}.json`;
		const clientPath = `raw/${prefix}-client.json`;
		const serverPath = `raw/${prefix}-server.json`;
		legs.push(legPath);
		writeFileSync(
			join(bundleDir, legPath),
			json({
				schema: "g6-attribution-leg/1",
				preRegistration,
				candidateSha: CANDIDATE,
				identityLeg: { candidateSha: CANDIDATE },
				hostIdentity: "runner=runner-a;generator=mac-generator",
				rawProcessReports: { client: clientPath, server: serverPath },
			}),
		);
		for (const [path, process] of [
			[clientPath, "client"],
			[serverPath, "server"],
		] as const) {
			writeFileSync(
				join(bundleDir, path),
				json({
					schema: "g6-attribution-process/1",
					process,
					preRegistration,
					candidateSha: CANDIDATE,
					hostIdentity: "runner=runner-a;generator=mac-generator",
				}),
			);
		}
	}
	writeFileSync(
		join(bundleDir, "aggregate.json"),
		json({
			schema: "g6-attribution/1",
			preRegistration,
			candidateSha: CANDIDATE,
			legs,
			identity: { valid, reasons: valid ? [] : ["identity drift"] },
			outcome: { valid: true, reasons: [] },
		}),
	);
	writeFileSync(join(bundleDir, "comparison.md"), "# Comparison\n");
	writeFileSync(
		join(bundleDir, "profiles.json"),
		json({ available: false, files: [] }),
	);
}

function fullExternalInputs(
	root: string,
	authority: G6BundleAuthorityOptions,
): NonNullable<
	Parameters<typeof prepareG6EvidenceBundle>[0]["externalInputs"]
> {
	return Object.fromEntries(
		["preflightDown", "preflightUp", "floor", "sink"].map((name) => {
			const path = join(root, `${name}.json`);
			const contents =
				name === "floor"
					? `macgen: host=mac-generator\nmmo-client: json ${JSON.stringify({
							schema: "mmo-client/2",
							role: "realm",
							preRegistration: {
								id: PREREGISTRATION_ID,
								path: PREREGISTRATION_PATH,
								sha256: authority.preRegistrationSha256,
							},
						})}\n`
					: json({ schema: `${name}/1` });
			writeFileSync(path, contents);
			return [name, { path, sha256: sha256(contents) }];
		}),
	) as NonNullable<
		Parameters<typeof prepareG6EvidenceBundle>[0]["externalInputs"]
	>;
}

function writeCompleteFullOutputs(
	bundleDir: string,
	authority: G6BundleAuthorityOptions,
): void {
	const preRegistration = {
		id: PREREGISTRATION_ID,
		path: PREREGISTRATION_PATH,
		sha256: authority.preRegistrationSha256,
	};
	writeFileSync(
		join(bundleDir, "bench-g6.json"),
		json({
			schema: "bench-g6/2",
			preRegistration,
			source: { candidateSha: CANDIDATE },
			host: { identity: "runner-a" },
			complete: true,
		}),
	);
	writeFileSync(join(bundleDir, "bench-g6.csv"), "arm,sessions\nsteady,5000\n");
	mkdirSync(join(bundleDir, "raw"));
	for (const role of ["realm", "subscriber", "publisher"] as const) {
		writeFileSync(
			join(bundleDir, "raw", `${role}-report.json`),
			json({ schema: "g6-client-role-evidence/1", role, preRegistration }),
		);
		writeFileSync(join(bundleDir, "raw", `${role}.log`), `${role}: exit=0\n`);
	}
	writeFileSync(
		join(bundleDir, "classified.json"),
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
			final: { valid: true, gate: "MISS" },
		}),
	);
}

describe("G6 bundle producer", () => {
	test("workflow keeps every benchmark mode disjoint and finalizes, verifies, uploads, then enforces successor bundles", () => {
		const workflow = readFileSync(
			join(import.meta.dir, "../../.github/workflows/bench-bandwidth.yml"),
			"utf8",
		);
		expect(workflow).toContain(
			"bandwidth (rate ladder, default) | session-scale (session-count ladder) | g6-mmo (MMO realm gate) | g6-attribution (same-workload attribution)",
		);
		expect(workflow).not.toContain("mode != 'session-scale'");
		for (const mode of [
			"bandwidth",
			"session-scale",
			"g6-mmo",
			"g6-attribution",
		]) {
			expect(workflow).toContain(`github.event.inputs.mode == '${mode}'`);
		}
		expect(workflow).toContain(
			"bandwidth|session-scale|g6-mmo|g6-attribution) ;;",
		);
		expect(workflow).toContain("timeout-minutes: 180");
		const prepare = workflow.indexOf(
			"- name: Prepare successor evidence bundle",
		);
		const g6Mmo = workflow.indexOf("- name: Run G6 MMO realm gate");
		const attribution = workflow.indexOf("- name: Run G6 attribution matrix");
		const evaluate = workflow.indexOf("- name: Evaluate G6 MMO realm gate");
		const finalize = workflow.indexOf(
			"- name: Finalize successor evidence bundle",
		);
		const verify = workflow.indexOf("- name: Verify successor evidence bundle");
		const g6Upload = workflow.indexOf(
			"- name: Upload successor evidence bundle",
		);
		const enforce = workflow.indexOf(
			"- name: Enforce successor evidence bundle",
		);
		const legacyUpload = workflow.indexOf(
			"- name: Upload legacy benchmark artifacts",
		);
		expect(prepare).toBeGreaterThan(0);
		expect(g6Mmo).toBeGreaterThan(prepare);
		expect(attribution).toBeGreaterThan(prepare);
		expect(evaluate).toBeGreaterThan(g6Mmo);
		expect(finalize).toBeGreaterThan(evaluate);
		expect(finalize).toBeGreaterThan(attribution);
		expect(verify).toBeGreaterThan(finalize);
		expect(g6Upload).toBeGreaterThan(verify);
		expect(enforce).toBeGreaterThan(g6Upload);
		expect(legacyUpload).toBeGreaterThan(0);
		expect(g6Upload).toBeGreaterThan(legacyUpload);
		expect(workflow).toContain(
			"if: ${{ always() && github.event.inputs.probe_only != 'true' && (github.event.inputs.mode == 'bandwidth' || github.event.inputs.mode == 'session-scale') }}",
		);
		expect(workflow).toContain(
			"if: ${{ always() && github.event.inputs.probe_only != 'true' && (github.event.inputs.mode == 'g6-mmo' || github.event.inputs.mode == 'g6-attribution') }}",
		);
		expect(workflow).toContain("retention-days: 90");
		expect(workflow).toContain("include-hidden-files: true");
		expect(workflow).toContain("path: ${{ env.G6_BUNDLE_DIR }}");
		expect(workflow).toContain("if-no-files-found: error");
		expect(workflow).not.toContain(
			"steps.verify_g6_bundle.outcome == 'success'",
		);
		expect(workflow).toContain("G6_ATTR_OUT_DIR: ${{ env.G6_BUNDLE_DIR }}");
		expect(workflow).toContain(
			"G6_ATTR_OFFBOX_SSH: ${{ github.event.inputs.g6_offbox_ssh }}",
		);
		expect(workflow).toContain(
			"G6_ATTR_SERVER_ADDRESS: ${{ github.event.inputs.g6_server_address }}",
		);
		expect(workflow).toContain(
			"G6_ATTR_EXPECTED_GENERATOR_HOST: ${{ github.event.inputs.g6_expected_generator_host }}",
		);
		expect(workflow).toContain('G6_OUT="$G6_BUNDLE_DIR/bench-g6.json"');
		expect(workflow).toContain("bun tools/load/g6-attribution-server.ts");
		expect(workflow).toContain("bun tools/load/bench-g6.ts");
		expect(workflow).toContain("bun tools/load/g6-evaluate.ts");
		expect(workflow).toContain("bun tools/load/g6-bundle.ts");
		expect(workflow).toContain("finalize");
		expect(workflow).toContain("bun tools/load/g6-manifest.ts verify");
		expect(workflow).toContain("G6_FINALIZE_EXIT=");
		expect(workflow).toContain("G6_VERIFY_EXIT=");
		expect(workflow).toContain("G6_UPLOAD_FAILED=");
		expect(workflow).toContain("G6_BUNDLE_STATUS=");
		expect(workflow).toContain("G6_EVALUATOR_EXIT=");
		expect(workflow).toContain("G6_RUN_EXIT=");
		expect(workflow).toContain("steps.finalize_g6_bundle.outcome");
		expect(workflow).toContain("steps.verify_g6_bundle.outcome");
		expect(workflow).toContain("steps.upload_g6_bundle.outcome");
		expect(workflow).toContain("COMPLETE");
		expect(workflow).not.toContain("bench-g6-*");
		expect(workflow).not.toContain("key.pem");
		expect(workflow).not.toContain(".tmp-g6-tls");
	});

	test("prepares a new authority-bound directory and finalizes a complete attribution bundle", () => {
		const { bundleDir, authority } = fixture();
		prepareG6EvidenceBundle({
			bundleDir,
			kind: "attribution",
			authority,
		});
		writeAttributionOutputs(bundleDir, authority, true);

		const result = finalizeG6EvidenceBundle({
			bundleDir,
			kind: "attribution",
			authority,
		});

		expect(result.status).toBe("COMPLETE");
		expect(
			verifyG6Manifest(bundleDir, {
				candidateSha: CANDIDATE,
				preRegistrationSha256: authority.preRegistrationSha256,
				registrationSha256: authority.registrationSha256,
			}),
		).toMatchObject({
			kind: "attribution",
			status: "COMPLETE",
			stampable: true,
		});
		expect(existsSync(join(bundleDir, "refusal.json"))).toBe(false);
	});

	test("turns a completed but invalid attribution matrix into a verifiable refusal", () => {
		const { bundleDir, authority } = fixture();
		prepareG6EvidenceBundle({ bundleDir, kind: "attribution", authority });
		writeAttributionOutputs(bundleDir, authority, false);

		const result = finalizeG6EvidenceBundle({
			bundleDir,
			kind: "attribution",
			authority,
		});

		expect(result.status).toBe("INVALID");
		expect(
			JSON.parse(readFileSync(join(bundleDir, "refusal.json"), "utf8")),
		).toMatchObject({
			schema: "g6-refusal/1",
			kind: "attribution",
			status: "INVALID",
			candidateSha: CANDIDATE,
		});
		expect(
			verifyG6Manifest(bundleDir, {
				candidateSha: CANDIDATE,
				preRegistrationSha256: authority.preRegistrationSha256,
				registrationSha256: authority.registrationSha256,
			}).stampable,
		).toBe(false);
	});

	test("retains an infrastructure-aborted attribution leg as a verifiable refusal", () => {
		const { bundleDir, authority } = fixture();
		prepareG6EvidenceBundle({ bundleDir, kind: "attribution", authority });
		mkdirSync(join(bundleDir, "legs"));
		mkdirSync(join(bundleDir, "raw"));
		const failureEvidence = {
			terminalStatus: "ABORTED" as const,
			stage: "client-transport",
			message: "ssh transport failed",
			exitCode: 255,
			stdoutLines: ["macgen: host=mac-generator"],
			stderrLines: ["connection closed"],
			outputTruncated: false,
		};
		const failure = buildAttributionFailureArtifacts({
			lane: "full-js",
			orderIndex: 0,
			preRegistrationSha256: authority.preRegistrationSha256,
			candidateSha: authority.candidateSha,
			hostIdentity: "runner=runner-a;generator=mac-generator",
			clientBinarySha256: null,
			serverBinarySha256: null,
			failure: failureEvidence,
		});
		writeFileSync(join(bundleDir, failure.legPath), json(failure.leg));
		writeFileSync(join(bundleDir, failure.clientPath), json(failure.client));
		writeFileSync(join(bundleDir, failure.serverPath), json(failure.server));
		writeFileSync(
			join(bundleDir, "aggregate.json"),
			json({
				schema: "g6-attribution/1",
				preRegistration: failure.leg.preRegistration,
				candidateSha: authority.candidateSha,
				legs: [failure.legPath],
				identity: { valid: false, reasons: [failureEvidence.message] },
				outcome: { valid: false, reasons: [failureEvidence.message] },
				terminalStatus: "ABORTED",
				failure: failureEvidence,
			}),
		);

		const result = finalizeG6EvidenceBundle({
			bundleDir,
			kind: "attribution",
			authority,
		});

		expect(result.status).toBe("ABORTED");
		expect(
			verifyG6Manifest(bundleDir, {
				candidateSha: CANDIDATE,
				preRegistrationSha256: authority.preRegistrationSha256,
				registrationSha256: authority.registrationSha256,
			}),
		).toMatchObject({
			kind: "attribution",
			status: "ABORTED",
			stampable: false,
		});
	});

	test("finalizes a complete full-G6 bundle with retained raw role sidecars", () => {
		const { root, bundleDir, authority } = fixture();
		prepareG6EvidenceBundle({
			bundleDir,
			kind: "full-g6",
			authority,
			externalInputs: fullExternalInputs(root, authority),
		});
		writeCompleteFullOutputs(bundleDir, authority);

		const result = finalizeG6EvidenceBundle({
			bundleDir,
			kind: "full-g6",
			authority,
		});

		expect(result.status).toBe("COMPLETE");
		expect(
			verifyG6Manifest(bundleDir, {
				candidateSha: CANDIDATE,
				preRegistrationSha256: authority.preRegistrationSha256,
				registrationSha256: authority.registrationSha256,
			}),
		).toMatchObject({ kind: "full-g6", status: "COMPLETE", stampable: true });
	});

	test("rejects copied grading-input drift before a full-G6 bundle can finalize", () => {
		const { root, bundleDir, authority } = fixture();
		prepareG6EvidenceBundle({
			bundleDir,
			kind: "full-g6",
			authority,
			externalInputs: fullExternalInputs(root, authority),
		});
		writeFileSync(
			join(bundleDir, "inputs/preflight-down.json"),
			json({ schema: "preflightDown/1", drifted: true }),
		);
		writeCompleteFullOutputs(bundleDir, authority);

		expect(() =>
			finalizeG6EvidenceBundle({
				bundleDir,
				kind: "full-g6",
				authority,
			}),
		).toThrow(/external input hash mismatch.*preflight-down/i);
	});

	test("retains partial full-G6 inputs in an ABORTED self-verifying bundle", () => {
		const { root, bundleDir, authority } = fixture();
		prepareG6EvidenceBundle({
			bundleDir,
			kind: "full-g6",
			authority,
			externalInputs: fullExternalInputs(root, authority),
		});
		writeFileSync(
			join(bundleDir, "bench-g6.json"),
			json({
				schema: "bench-g6/2",
				preRegistration: {
					id: PREREGISTRATION_ID,
					path: PREREGISTRATION_PATH,
					sha256: authority.preRegistrationSha256,
				},
				source: { candidateSha: CANDIDATE },
				complete: false,
				aborted: "client exited 17",
			}),
		);

		const result = finalizeG6EvidenceBundle({
			bundleDir,
			kind: "full-g6",
			authority,
		});

		expect(result.status).toBe("ABORTED");
		expect(existsSync(join(bundleDir, "inputs/preflight-down.json"))).toBe(
			true,
		);
		expect(existsSync(join(bundleDir, "inputs/floor.log"))).toBe(true);
		expect(
			verifyG6Manifest(bundleDir, {
				candidateSha: CANDIDATE,
				preRegistrationSha256: authority.preRegistrationSha256,
				registrationSha256: authority.registrationSha256,
			}),
		).toMatchObject({ kind: "full-g6", status: "ABORTED", stampable: false });
	});

	test("rejects authority hash drift before creating or overwriting evidence", () => {
		const first = fixture();
		expect(() =>
			prepareG6EvidenceBundle({
				bundleDir: first.bundleDir,
				kind: "attribution",
				authority: {
					...first.authority,
					registrationSha256: "f".repeat(64),
				},
			}),
		).toThrow("registration sha256 mismatch");
		expect(existsSync(first.bundleDir)).toBe(false);

		const unbound = fixture();
		const registration = readFileSync(
			unbound.authority.registrationPath,
			"utf8",
		).replace(`Tree SHA: ${TREE}\n`, "");
		writeFileSync(unbound.authority.registrationPath, registration);
		expect(() =>
			prepareG6EvidenceBundle({
				bundleDir: unbound.bundleDir,
				kind: "attribution",
				authority: {
					...unbound.authority,
					registrationSha256: sha256(registration),
				},
			}),
		).toThrow(`registration omitted ${TREE}`);
		expect(existsSync(unbound.bundleDir)).toBe(false);

		prepareG6EvidenceBundle({
			bundleDir: first.bundleDir,
			kind: "attribution",
			authority: first.authority,
		});
		expect(() =>
			prepareG6EvidenceBundle({
				bundleDir: first.bundleDir,
				kind: "attribution",
				authority: first.authority,
			}),
		).toThrow("evidence directory already exists");
	});
});
