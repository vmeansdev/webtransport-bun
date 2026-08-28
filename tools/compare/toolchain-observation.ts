/**
 * Observed toolchain facts for one host.
 *
 * The field names are borrowed deliberately from the `toolchain` sub-record of
 * `host-runtime-facts/v1` (`r1-fixtures.ts`), which already specifies what a
 * host's toolchain evidence looks like -- `bunVersion`, `bunExecutableSha256`
 * and friends -- and is already enforced by `validateHostRuntimeFactsV1`.
 * Nothing produces that record; it exists as a schema, a validator and a set of
 * fixtures. This module produces the part of it the run artifact needs.
 *
 * It carries its own schema tag rather than claiming to be
 * `host-runtime-facts/v1`, because it is a strict subset: the full record also
 * declares cpu, limits, the measurement endpoint and command receipts, none of
 * which are observed here. A partial record wearing the full record's schema
 * would be the same defect this module exists to remove.
 *
 * Refusal, not substitution: every fact is read from the running process or the
 * filesystem, and a fact that cannot be read throws. There is no default,
 * because the value a default would supply is exactly the thing that made the
 * previous toolchain digest worthless.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

export const OBSERVED_TOOLCHAIN_SCHEMA = "observed-toolchain/v1" as const;

export type ToolchainObservationCode =
	| "TOOLCHAIN_VERSION_UNOBSERVED"
	| "TOOLCHAIN_REVISION_UNOBSERVED"
	| "TOOLCHAIN_PLATFORM_UNOBSERVED"
	| "TOOLCHAIN_EXECUTABLE_UNREADABLE";

export class ToolchainObservationError extends Error {
	readonly code: ToolchainObservationCode;
	constructor(code: ToolchainObservationCode, detail?: string) {
		super(detail === undefined ? code : `${code}: ${detail}`);
		this.name = "ToolchainObservationError";
		this.code = code;
	}
}

export interface ObservedToolchain {
	readonly schema: typeof OBSERVED_TOOLCHAIN_SCHEMA;
	/** `darwin-arm64` / `linux-x86_64`, in `host-runtime-facts/v1` spelling. */
	readonly platform: string;
	readonly bunVersion: string;
	readonly bunRevision: string;
	readonly bunExecutableSha256: string;
}

/**
 * `host-runtime-facts/v1` spells the machine `x86_64`; node and Bun spell it
 * `x64`. One vocabulary or the two records cannot be compared.
 */
export function platformToken(nodePlatform: string, nodeArch: string): string {
	if (nodePlatform === "" || nodeArch === "") {
		throw new ToolchainObservationError("TOOLCHAIN_PLATFORM_UNOBSERVED");
	}
	return `${nodePlatform}-${nodeArch === "x64" ? "x86_64" : nodeArch}`;
}

/** SHA-256 of a file, streamed: the Bun executable is ~90 MB. */
export async function fileSha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	try {
		await pipeline(createReadStream(path), hash);
	} catch (cause) {
		throw new ToolchainObservationError(
			"TOOLCHAIN_EXECUTABLE_UNREADABLE",
			`${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}
	return hash.digest("hex");
}

/**
 * The `js` toolchain's identity, derived from what was observed.
 *
 * It used to be the literal `"bun-1.3.14-darwin-arm64"`, which could not
 * disagree with reality no matter what produced the artifact. Deriving it means
 * a reader comparing identity against the digest is comparing two views of one
 * observation rather than a string against a constant.
 *
 * The platform is deliberately *not* in it. Both arms of a comparison must
 * publish the same `js` toolchain -- that is what `TOOLCHAIN_DIGEST_MISMATCH`
 * exists to enforce -- and the thing that must match across two hosts is the
 * Bun version, not the machine. Where the platform matters it is on the
 * `darwin` and `linux` entries, which name a per-host artifact.
 */
export function toolchainIdentity(observed: ObservedToolchain): string {
	return `bun-${observed.bunVersion}`;
}

/**
 * The identity of a native addon built for one platform.
 *
 * Honest about what it can see: the digest is of the `.node` that was loaded,
 * and the compiler and rust versions that produced it are not recoverable from
 * the binary, so they are not claimed. `host-runtime-facts/v1` has fields for
 * them; whoever produces that record from a build can fill them in.
 */
export function nativeToolchainIdentity(platform: string): string {
	return `${platform}-addon`;
}

/** Observe the native addon this host loaded. */
export async function observeNativeAddon(
	addonPath: string,
	platform: string,
): Promise<{ identity: string; sha256: string }> {
	return {
		identity: nativeToolchainIdentity(platform),
		sha256: await fileSha256(addonPath),
	};
}

/** Observe the toolchain of the process making this call. */
export async function observeLocalToolchain(): Promise<ObservedToolchain> {
	const bunVersion = Bun.version;
	if (typeof bunVersion !== "string" || bunVersion === "") {
		throw new ToolchainObservationError("TOOLCHAIN_VERSION_UNOBSERVED");
	}
	const bunRevision = Bun.revision;
	if (typeof bunRevision !== "string" || bunRevision === "") {
		throw new ToolchainObservationError("TOOLCHAIN_REVISION_UNOBSERVED");
	}
	const executablePath = process.execPath;
	if (typeof executablePath !== "string" || executablePath === "") {
		throw new ToolchainObservationError("TOOLCHAIN_EXECUTABLE_UNREADABLE");
	}
	return {
		schema: OBSERVED_TOOLCHAIN_SCHEMA,
		platform: platformToken(process.platform, process.arch),
		bunVersion,
		bunRevision,
		bunExecutableSha256: await fileSha256(executablePath),
	};
}
