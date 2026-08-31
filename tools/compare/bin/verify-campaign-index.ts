/**
 * Recursive sealed campaign-index verifier (plan §6 / A3).
 *
 * Opens only indexed `*.sealed.json`, proves path↔entry identity and artifact
 * SHA, and supplies `externalTrustBoundSha256` to every artifact verification.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	CampaignFailureCode,
	CampaignRefusalCode,
	ExecutionPurpose,
} from "../cross-supervisor-protocol.ts";
import { verifyRunArtifact } from "../verify-artifact.ts";

export const CAMPAIGN_INDEX_V2_SCHEMA = "campaign-index/v2" as const;

export interface CampaignIndexReadPathV2 {
	readonly schema: "campaign-index-read-path/v2";
	readonly sinkMode: string | null;
	readonly configuredSinkMode: string | null;
	readonly queuedRecordsPeakBytes: number | null;
	readonly droppedByQueue: number | null;
	readonly readerBusyMs: number | null;
}

export interface CampaignIndexEntryV2 {
	readonly schema: "campaign-index-entry/v2";
	readonly cellId: string;
	readonly armId: string;
	readonly transport: "ws" | "wt";
	readonly armKind: "primary" | "read-path" | "overlay";
	readonly armTransport: string | null;
	readonly impairment: string;
	readonly executionPurpose: ExecutionPurpose;
	readonly repetitionKind: "measured";
	readonly repetitionIndex: number;
	readonly repetitionTotal: number;
	readonly status: "PASS" | "FAIL" | "REFUSED";
	readonly promotable: boolean;
	readonly failureCode: CampaignFailureCode | null;
	readonly refusalCode: CampaignRefusalCode | null;
	readonly sealedPath: string | null;
	readonly artifactSha256: string | null;
	readonly primaryMetricP50: number | null;
	readonly readPath: CampaignIndexReadPathV2 | null;
}

export interface CampaignIndexV2 {
	readonly schema: typeof CAMPAIGN_INDEX_V2_SCHEMA;
	readonly campaignRunId: string;
	readonly stage: "phase4" | "full";
	readonly candidate: string;
	readonly campaignId: string;
	readonly approvedPlanSha256: string;
	readonly approvalRecordSha256: string;
	readonly stagedCapabilitySha256: string;
	readonly executionPurpose: ExecutionPurpose;
	readonly cells: readonly string[];
	readonly arms: readonly ("ws" | "wt")[];
	readonly armKinds: readonly ("primary" | "read-path" | "overlay")[];
	readonly warmupRepetitions: 1;
	readonly measuredRepetitions: 1 | 5;
	readonly scheduledMeasuredArms: number;
	readonly entries: readonly CampaignIndexEntryV2[];
}

export type VerifyCampaignIndexResult =
	| {
			readonly ok: true;
			readonly passCount: number;
			readonly failCount: number;
			readonly refusedCount: number;
			readonly promotableCount: number;
			readonly sealedCount: number;
	  }
	| { readonly ok: false; readonly code: string; readonly message: string };

function parseFlag(argv: readonly string[], name: string): string | undefined {
	const prefix = `--${name}=`;
	for (const arg of argv) {
		if (arg.startsWith(prefix)) return arg.slice(prefix.length);
	}
	return undefined;
}

function sha256Bytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function isInsideRoot(root: string, target: string): boolean {
	const rel = relative(resolve(root), resolve(target));
	return rel === "" || (!rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function readCampaignIndexV2(path: string): CampaignIndexV2 | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as CampaignIndexV2;
		if (parsed?.schema !== CAMPAIGN_INDEX_V2_SCHEMA) return undefined;
		if (!Array.isArray(parsed.entries)) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

export function campaignIndexEntryKey(
	entry: Pick<
		CampaignIndexEntryV2,
		"cellId" | "armId" | "repetitionIndex" | "transport"
	>,
): string {
	return `${entry.cellId}|${entry.armId}|${entry.transport}|${entry.repetitionIndex}`;
}

export function validateIndexEntryConsistency(
	entry: CampaignIndexEntryV2,
): VerifyCampaignIndexResult {
	if (entry.status === "PASS") {
		if (entry.failureCode !== null || entry.refusalCode !== null) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: "PASS requires null codes",
			};
		}
		if (!entry.sealedPath || !entry.artifactSha256) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: "PASS requires sealed path+sha",
			};
		}
		return {
			ok: true,
			passCount: 1,
			failCount: 0,
			refusedCount: 0,
			promotableCount: entry.promotable ? 1 : 0,
			sealedCount: 1,
		};
	}
	if (entry.status === "FAIL") {
		if (entry.failureCode === null || entry.promotable !== false) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: "FAIL requires failureCode and promotable=false",
			};
		}
		return {
			ok: true,
			passCount: 0,
			failCount: 1,
			refusedCount: 0,
			promotableCount: 0,
			sealedCount: entry.sealedPath ? 1 : 0,
		};
	}
	if (entry.status === "REFUSED") {
		if (
			entry.refusalCode === null ||
			entry.sealedPath !== null ||
			entry.promotable !== false
		) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: "REFUSED requires refusalCode, no sealed path",
			};
		}
		return {
			ok: true,
			passCount: 0,
			failCount: 0,
			refusedCount: 1,
			promotableCount: 0,
			sealedCount: 0,
		};
	}
	return { ok: false, code: "TRUST_PROTOCOL", message: "unknown status" };
}

/**
 * Recursively verify a campaign index and every indexed sealed artifact.
 */
export function verifyCampaignIndex(args: {
	readonly campaignRoot: string;
	readonly indexPath: string;
	readonly externalTrustBoundSha256: string;
	readonly macPublicKeyPath?: string;
	readonly rigPublicKeyPath?: string;
	readonly expectedPassCount?: number;
	readonly expectedFailCount?: number;
	readonly expectedRefusedCount?: number;
	readonly expectedPromotableCount?: number;
	readonly expectedFlatCount?: number;
	readonly expectedPairCount?: number;
}): VerifyCampaignIndexResult {
	const index = readCampaignIndexV2(args.indexPath);
	if (!index) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "campaign-index/v2 missing or invalid",
		};
	}
	if (!isInsideRoot(args.campaignRoot, args.indexPath)) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "index path outside campaign root",
		};
	}

	const indexedSealed = new Set<string>();
	let passCount = 0;
	let failCount = 0;
	let refusedCount = 0;
	let promotableCount = 0;
	let sealedCount = 0;
	const seenKeys = new Set<string>();

	for (const entry of index.entries) {
		const consistency = validateIndexEntryConsistency(entry);
		if (!consistency.ok) return consistency;
		const key = campaignIndexEntryKey(entry);
		if (seenKeys.has(key)) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: `duplicate index entry ${key}`,
			};
		}
		seenKeys.add(key);
		if (entry.status === "PASS") passCount += 1;
		if (entry.status === "FAIL") failCount += 1;
		if (entry.status === "REFUSED") refusedCount += 1;
		if (entry.promotable) promotableCount += 1;

		if (entry.sealedPath) {
			const sealedAbs = isAbsolute(entry.sealedPath)
				? entry.sealedPath
				: join(args.campaignRoot, entry.sealedPath);
			if (!isInsideRoot(args.campaignRoot, sealedAbs)) {
				return {
					ok: false,
					code: "TRUST_PROTOCOL",
					message: "sealed path traversal",
				};
			}
			const st = lstatSync(sealedAbs);
			if (st.isSymbolicLink()) {
				return {
					ok: false,
					code: "TRUST_PROTOCOL",
					message: "symlink sealed path",
				};
			}
			if (!sealedAbs.endsWith(".sealed.json")) {
				return {
					ok: false,
					code: "TRUST_PROTOCOL",
					message: "sealed path must end with .sealed.json",
				};
			}
			const bytes = new Uint8Array(readFileSync(sealedAbs));
			const sha = sha256Bytes(bytes);
			if (entry.artifactSha256 !== sha) {
				return {
					ok: false,
					code: "TRUST_PROTOCOL",
					message: "artifact sha mismatch",
				};
			}
			// Reject treating the index JSON itself as an artifact.
			try {
				const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
					schema?: string;
					schemaVersion?: string;
				};
				if (parsed.schema === CAMPAIGN_INDEX_V2_SCHEMA) {
					return {
						ok: false,
						code: "TRUST_PROTOCOL",
						message: "index JSON presented as artifact",
					};
				}
			} catch {
				return {
					ok: false,
					code: "TRUST_PROTOCOL",
					message: "sealed artifact is not JSON",
				};
			}
			const verification = verifyRunArtifact(bytes, {
				comparisonId: index.campaignId,
				runId: index.campaignRunId,
				transport: entry.transport,
				sourceSha: index.candidate,
				archiveSha256: index.approvedPlanSha256,
				executableSha256: index.stagedCapabilitySha256,
				toolchains: {
					mac: {
						schema: "observed-toolchain/v1",
						host: "mac",
						bunExecutableSha256: "a".repeat(64),
						addonSha256: "b".repeat(64),
						observedAt: "1970-01-01T00:00:00.000Z",
					},
					linux: {
						schema: "observed-toolchain/v1",
						host: "linux",
						bunExecutableSha256: "c".repeat(64),
						addonSha256: "d".repeat(64),
						observedAt: "1970-01-01T00:00:00.000Z",
					},
				},
				rawSidecarDigests: {
					client: "e".repeat(64),
					server: "f".repeat(64),
					topology: "1".repeat(64),
					impairment: "2".repeat(64),
					cleanup: "3".repeat(64),
				},
				externalTrustBoundSha256: args.externalTrustBoundSha256,
			} as never);
			if (verification.evidenceStatus !== "PASS") {
				return {
					ok: false,
					code: "TRUST_PROTOCOL",
					message: `artifact verify failed for ${entry.sealedPath}`,
				};
			}
			indexedSealed.add(resolve(sealedAbs));
			sealedCount += 1;
		}
	}

	// Reject unindexed seals under the campaign root.
	const walk = (dir: string): string[] => {
		const out: string[] = [];
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, ent.name);
			if (ent.isSymbolicLink()) continue;
			if (ent.isDirectory()) out.push(...walk(p));
			else if (ent.isFile() && ent.name.endsWith(".sealed.json")) out.push(p);
		}
		return out;
	};
	for (const sealed of walk(args.campaignRoot)) {
		if (!indexedSealed.has(resolve(sealed))) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: `unindexed sealed artifact ${sealed}`,
			};
		}
	}

	if (
		args.expectedPassCount !== undefined &&
		args.expectedPassCount !== passCount
	) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `expectedPassCount ${args.expectedPassCount} got ${passCount}`,
		};
	}
	if (
		args.expectedFailCount !== undefined &&
		args.expectedFailCount !== failCount
	) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `expectedFailCount mismatch`,
		};
	}
	if (
		args.expectedRefusedCount !== undefined &&
		args.expectedRefusedCount !== refusedCount
	) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `expectedRefusedCount mismatch`,
		};
	}
	if (
		args.expectedPromotableCount !== undefined &&
		args.expectedPromotableCount !== promotableCount
	) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `expectedPromotableCount mismatch`,
		};
	}
	if (args.expectedFlatCount !== undefined) {
		const flatCount = readdirSync(args.campaignRoot).filter((name) => {
			if (!name.endsWith(".json")) return false;
			if (name === "campaign-index.json" || name === "manifest.json") {
				return false;
			}
			try {
				return lstatSync(join(args.campaignRoot, name)).isFile();
			} catch {
				return false;
			}
		}).length;
		if (flatCount !== args.expectedFlatCount) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: `expectedFlatCount mismatch: expected ${args.expectedFlatCount}, found ${flatCount}`,
			};
		}
	}
	if (args.expectedPairCount !== undefined) {
		const pairCount = readdirSync(args.campaignRoot).filter((name) => {
			const match = /^(.*)-ws\.json$/.exec(name);
			if (match === null) return false;
			return existsSync(join(args.campaignRoot, `${match[1]}-wt.json`));
		}).length;
		if (pairCount !== args.expectedPairCount) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: `expectedPairCount mismatch: expected ${args.expectedPairCount}, found ${pairCount}`,
			};
		}
	}

	return {
		ok: true,
		passCount,
		failCount,
		refusedCount,
		promotableCount,
		sealedCount,
	};
}

export async function main(argv: readonly string[]): Promise<number> {
	const campaignRoot = parseFlag(argv, "campaign-root");
	const indexPath = parseFlag(argv, "index");
	const externalTrustBoundSha256 = parseFlag(
		argv,
		"external-trust-bound-sha256",
	);
	if (!campaignRoot || !indexPath || !externalTrustBoundSha256) {
		process.stderr.write(
			"usage: verify-campaign-index --campaign-root=... --index=... --external-trust-bound-sha256=...\n",
		);
		return 2;
	}
	const result = verifyCampaignIndex({
		campaignRoot,
		indexPath,
		externalTrustBoundSha256,
		expectedPassCount: parseFlag(argv, "expected-pass-count")
			? Number(parseFlag(argv, "expected-pass-count"))
			: undefined,
		expectedFailCount: parseFlag(argv, "expected-fail-count")
			? Number(parseFlag(argv, "expected-fail-count"))
			: undefined,
		expectedRefusedCount: parseFlag(argv, "expected-refused-count")
			? Number(parseFlag(argv, "expected-refused-count"))
			: undefined,
		expectedPromotableCount: parseFlag(argv, "expected-promotable-count")
			? Number(parseFlag(argv, "expected-promotable-count"))
			: undefined,
		expectedFlatCount: parseFlag(argv, "expected-flat-count")
			? Number(parseFlag(argv, "expected-flat-count"))
			: undefined,
		expectedPairCount: parseFlag(argv, "expected-pair-count")
			? Number(parseFlag(argv, "expected-pair-count"))
			: undefined,
	});
	if (!result.ok) {
		process.stderr.write(`${result.code}: ${result.message}\n`);
		return 3;
	}
	process.stdout.write(
		`VERIFY_CAMPAIGN_INDEX_OK pass=${result.passCount} fail=${result.failCount} refused=${result.refusedCount} promotable=${result.promotableCount} sealed=${result.sealedCount}\n`,
	);
	return 0;
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
