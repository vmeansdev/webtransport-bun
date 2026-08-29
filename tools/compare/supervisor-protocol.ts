// R1 supervisor protocol validation (Task C): descriptor-only role loading
// and the supervisor-owned physical-path observation contract. Children can
// never mint physical authority; every receipt class binds back to the
// supervisor-computed set digests. Pure validation: no OS I/O.
import {
	canonicalRecordBytes,
	isImplausibleDigest,
	sha256HexOfBytes,
	type ValidationFailure,
} from "./secure-fs.ts";
import type { MeasurementGrantV1 } from "./supervisor-client.ts";
import { parseLinuxRoute, parseMacRoute } from "./topology.ts";

type Rec = Record<string, unknown>;

function isPlainObject(value: unknown): value is Rec {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

// ---------------------------------------------------------------------------
// Observation provenance
//
// The TS mirror of the Rust `ObservationProvenance` model. Reference
// comparison cannot separate an observation from an echo of the plan —
// `structuredClone` defeats it, and every later check requires observed to
// equal planned anyway. Only the observation's own declared source can, so
// provenance travels with the facts and an echo is rejected structurally
// rather than detected by comparison.
// ---------------------------------------------------------------------------

export type ObservationProvenance =
	| "supervisor-measured"
	| "echo-of-plan"
	| "child-reported";

/** Planned facts from the validated lock: inputs only, never evidence. */
export interface PlannedPathFacts {
	readonly macInterface: string;
	readonly macAddress: string;
	readonly linuxInterface: string;
	readonly linuxAddress: string;
	readonly mtu: number;
}

/**
 * Independently observed facts. A deliberately distinct shape from the plan:
 * every field is optional so omission is a typed failure rather than a
 * skipped check, and provenance is explicit so an echo can never validate.
 */
export interface ObservedPathFacts {
	readonly provenance: ObservationProvenance;
	readonly macInterface?: string;
	readonly macAddress?: string;
	readonly linuxInterface?: string;
	readonly linuxAddress?: string;
	readonly mtu?: number;
	readonly qdiscRestored?: boolean;
	readonly cleanupReleased?: boolean;
}

/**
 * The toolchain facts the supervisor observed on one host.
 *
 * Same pattern as `ObservedPathFacts`: every fact is optional so omission
 * is a typed failure, not a skipped check. The platform is the only
 * required key because it is what the join uses to assemble the
 * two-host set; the rest are the strict subset of `host-runtime-facts/v1`'s
 * `toolchain` sub-record the supervisor actually measures.
 */
export interface ObservedToolchainHostFacts {
	readonly platform: string;
	readonly bunVersion?: string;
	readonly bunRevision?: string;
	readonly bunExecutableSha256?: string;
}

/**
 * The supervisor's own toolchain observation across both hosts.
 *
 * Per-host rather than merged, mirroring the `validateSupervisorPhysicalReceipts`
 * shape: each side carries its own platform and its own evidence. Joining
 * the two into a `host-runtime-facts-set/v1` is a separate concern (the
 * next phase); this type only declares what a supervisor measurement looks
 * like on the way in.
 */
export interface ObservedToolchainFacts {
	readonly provenance: ObservationProvenance;
	readonly mac?: ObservedToolchainHostFacts;
	readonly linux?: ObservedToolchainHostFacts;
}

const TOOLCHAIN_PLATFORMS = ["darwin-arm64", "linux-x86_64"] as const;
const TOOLCHAIN_HEX64 = /^[0-9a-f]{64}$/;

/**
 * The capability facts the supervisor observed on one host.
 *
 * Same pattern as `ObservedToolchainHostFacts`: every fact is optional
 * so omission is a typed failure, not a skipped check. The platform is
 * the only required key because it is what the join uses to assemble
 * the two-host set; the rest are the strict subset of the staged
 * capability bundle the supervisor actually measures when it reads the
 * staged file on each host.
 */
export interface ObservedCapabilityHostFacts {
	readonly platform: string;
	readonly capabilityVersion?: string;
	readonly capabilityDigestSha256?: string;
	readonly capabilities?: readonly string[];
}

/**
 * The supervisor's own capability observation across both hosts.
 *
 * Per-host rather than merged, mirroring `ObservedToolchainFacts`:
 * each side carries its own platform and its own evidence. Joining
 * the two into a two-host set is a separate concern (the next step);
 * this type only declares what a supervisor measurement looks like
 * on the way in. The capability is a campaign-level fact — both hosts
 * should observe the same digest if staging was correct — and the
 * cross-host equality is enforced in the set validator, not here.
 */
export interface ObservedCapabilityFacts {
	readonly provenance: ObservationProvenance;
	readonly mac?: ObservedCapabilityHostFacts;
	readonly linux?: ObservedCapabilityHostFacts;
}

const CAPABILITY_PLATFORMS = ["darwin-arm64", "linux-x86_64"] as const;
const CAPABILITY_HEX64 = /^[0-9a-f]{64}$/;

/**
 * The lock facts the supervisor observed on one host.
 *
 * Same pattern as `ObservedCapabilityHostFacts`: every fact is
 * optional so omission is a typed failure, not a skipped check.
 * The platform is the only required key because it is what the
 * join uses to assemble the two-host set; the rest are the strict
 * subset of the staged lock bundle the supervisor actually measures
 * when it reads the staged file on each host.
 */
export interface ObservedLockHostFacts {
	readonly platform: string;
	readonly lockVersion?: string;
	readonly lockDigestSha256?: string;
	readonly locks?: readonly string[];
}

/**
 * The supervisor's own lock observation across both hosts.
 *
 * Per-host rather than merged, mirroring `ObservedCapabilityFacts`:
 * each side carries its own platform and its own evidence. Joining
 * the two into a two-host set is a separate concern (the next step);
 * this type only declares what a supervisor measurement looks like
 * on the way in. The lock is a campaign-level fact -- both hosts
 * should observe the same digest if staging was correct -- and the
 * cross-host equality is enforced in the set validator, not here.
 */
export interface ObservedLockFacts {
	readonly provenance: ObservationProvenance;
	readonly mac?: ObservedLockHostFacts;
	readonly linux?: ObservedLockHostFacts;
}

const LOCK_PLATFORMS = ["darwin-arm64", "linux-x86_64"] as const;
const LOCK_HEX64 = /^[0-9a-f]{64}$/;

/**
 * The manifest facts the supervisor observed on one host.
 *
 * Same pattern as `ObservedLockHostFacts`: every fact is optional
 * so omission is a typed failure, not a skipped check. The
 * platform is the only required key because it is what the join
 * uses to assemble the two-host set; the rest are the strict
 * subset of the staged manifest bundle the supervisor actually
 * measures when it reads the staged file on each host.
 */
export interface ObservedManifestHostFacts {
	readonly platform: string;
	readonly manifestVersion?: string;
	readonly manifestDigestSha256?: string;
	readonly manifests?: readonly string[];
}

/**
 * The supervisor's own manifest observation across both hosts.
 *
 * Per-host rather than merged, mirroring `ObservedLockFacts`:
 * each side carries its own platform and its own evidence.
 * Joining the two into a two-host set is a separate concern
 * (the next step); this type only declares what a supervisor
 * measurement looks like on the way in. The manifest is a
 * campaign-level fact -- both hosts should observe the same
 * digest if staging was correct -- and the cross-host equality
 * is enforced in the set validator, not here.
 */
export interface ObservedManifestFacts {
	readonly provenance: ObservationProvenance;
	readonly mac?: ObservedManifestHostFacts;
	readonly linux?: ObservedManifestHostFacts;
}

const MANIFEST_PLATFORMS = ["darwin-arm64", "linux-x86_64"] as const;
const MANIFEST_HEX64 = /^[0-9a-f]{64}$/;

/**
 * Rejects a declared provenance that is anything other than the
 * supervisor's own measurement. An observation that declares no provenance
 * at all is indistinguishable from an echo, so it is rejected too.
 */
export function observationProvenanceIssue(observed: unknown): string | null {
	if (!isPlainObject(observed)) return "TRUST_CHILD_OBSERVATION_FORBIDDEN";
	const provenance = observed.provenance;
	if (provenance === "supervisor-measured") return null;
	if (provenance === undefined) return "TRUST_OBSERVATION_PROVENANCE_MISSING";
	return "TRUST_CHILD_OBSERVATION_FORBIDDEN";
}

/**
 * Validates an observation against the plan: fails on a non-supervisor
 * provenance, on omission, on drift, or on cleanup/restoration failure.
 */
export function validateObservedPathFacts(
	planned: PlannedPathFacts,
	observed: ObservedPathFacts,
): { ok: true } | ValidationFailure {
	const provenanceIssue = observationProvenanceIssue(observed);
	if (provenanceIssue !== null) {
		return { ok: false, code: provenanceIssue };
	}
	const required = [
		[observed.macInterface, planned.macInterface],
		[observed.macAddress, planned.macAddress],
		[observed.linuxInterface, planned.linuxInterface],
		[observed.linuxAddress, planned.linuxAddress],
		[observed.mtu, planned.mtu],
	] as const;
	for (const [seen] of required) {
		if (seen === undefined) {
			return { ok: false, code: "TRUST_OBSERVATION_OMITTED" };
		}
	}
	for (const [seen, expected] of required) {
		if (seen !== expected) {
			return { ok: false, code: "TRUST_OBSERVATION_DRIFT" };
		}
	}
	if (observed.qdiscRestored !== true) {
		return { ok: false, code: "TRUST_QDISC_RESTORATION_FAILED" };
	}
	if (observed.cleanupReleased !== true) {
		return { ok: false, code: "TRUST_CLEANUP_OBSERVATION_MISSING" };
	}
	return { ok: true };
}

/**
 * Validates a supervisor-measured toolchain observation.
 *
 * Same rules as the path observation, applied to the per-host shape: a
 * non-supervisor provenance is refused structurally, both hosts must be
 * present, every fact on each host must be observed, the executable digest
 * must be a real 64-char hex, and the two hosts must name the two real
 * platforms. A cross-host Bun version mismatch is *not* caught here: that
 * is a campaign-level fact the comparator enforces, and asking the
 * observation to enforce it would couple the two supervisors' read of
 * their own host.
 */
export function validateObservedToolchainFacts(
	observed: ObservedToolchainFacts,
): { ok: true; hostCount: 2 } | ValidationFailure {
	const provenanceIssue = observationProvenanceIssue(observed);
	if (provenanceIssue !== null) {
		return { ok: false, code: provenanceIssue };
	}
	if (!isPlainObject(observed.mac) || !isPlainObject(observed.linux)) {
		return { ok: false, code: "TRUST_OBSERVATION_OMITTED" };
	}
	const mac = observed.mac;
	const linux = observed.linux;
	if (
		!TOOLCHAIN_PLATFORMS.includes(
			mac.platform as (typeof TOOLCHAIN_PLATFORMS)[number],
		) ||
		!TOOLCHAIN_PLATFORMS.includes(
			linux.platform as (typeof TOOLCHAIN_PLATFORMS)[number],
		)
	) {
		return { ok: false, code: "TRUST_OBSERVATION_DRIFT" };
	}
	if (mac.platform === linux.platform) {
		return { ok: false, code: "TRUST_OBSERVATION_DRIFT" };
	}
	for (const facts of [mac, linux]) {
		for (const field of [
			"bunVersion",
			"bunRevision",
			"bunExecutableSha256",
		] as const) {
			const value = facts[field];
			if (typeof value !== "string" || value === "") {
				return { ok: false, code: "TRUST_OBSERVATION_OMITTED" };
			}
			if (field === "bunExecutableSha256" && !TOOLCHAIN_HEX64.test(value)) {
				return { ok: false, code: "TRUST_OBSERVATION_DRIFT" };
			}
		}
	}
	return { ok: true, hostCount: 2 };
}

/**
 * Validates a supervisor-measured capability observation.
 *
 * Same rules as the toolchain observation, applied to the per-host
 * shape: a non-supervisor provenance is refused structurally, both
 * hosts must be present, every fact on each host must be observed,
 * the capability digest must be a real 64-char hex, and the two
 * hosts must name the two real platforms. A cross-host digest
 * mismatch is *not* caught here: that is a campaign-level fact the
 * set validator enforces, and asking the per-host observation to
 * couple the two supervisors' read of their own host would defeat
 * the per-host shape the protocol exists to enforce.
 */
export function validateObservedCapabilityFacts(
	observed: ObservedCapabilityFacts,
): { ok: true; hostCount: 2 } | ValidationFailure {
	const provenanceIssue = observationProvenanceIssue(observed);
	if (provenanceIssue !== null) {
		return { ok: false, code: provenanceIssue };
	}
	if (!isPlainObject(observed.mac) || !isPlainObject(observed.linux)) {
		return { ok: false, code: "TRUST_OBSERVATION_OMITTED" };
	}
	const mac = observed.mac;
	const linux = observed.linux;
	if (
		!CAPABILITY_PLATFORMS.includes(
			mac.platform as (typeof CAPABILITY_PLATFORMS)[number],
		) ||
		!CAPABILITY_PLATFORMS.includes(
			linux.platform as (typeof CAPABILITY_PLATFORMS)[number],
		)
	) {
		return { ok: false, code: "TRUST_OBSERVATION_DRIFT" };
	}
	if (mac.platform === linux.platform) {
		return { ok: false, code: "TRUST_OBSERVATION_DRIFT" };
	}
	for (const facts of [mac, linux]) {
		for (const field of [
			"capabilityVersion",
			"capabilityDigestSha256",
			"capabilities",
		] as const) {
			const value = facts[field];
			if (field === "capabilityDigestSha256") {
				if (typeof value !== "string" || !CAPABILITY_HEX64.test(value)) {
					return { ok: false, code: "TRUST_OBSERVATION_DRIFT" };
				}
			} else if (field === "capabilities") {
				if (!Array.isArray(value)) {
					return { ok: false, code: "TRUST_OBSERVATION_OMITTED" };
				}
			} else {
				if (typeof value !== "string" || value === "") {
					return { ok: false, code: "TRUST_OBSERVATION_OMITTED" };
				}
			}
		}
	}
	return { ok: true, hostCount: 2 };
}

/**
 * Validates a supervisor-measured lock observation.
 *
 * Same rules as the capability observation, applied to the per-host
 * shape: a non-supervisor provenance is refused structurally, both
 * hosts must be present, every fact on each host must be observed,
 * the lock digest must be a real 64-char hex, and the two hosts
 * must name the two real platforms. A cross-host digest mismatch
 * is *not* caught here: that is a campaign-level fact the set
 * validator enforces, and asking the per-host observation to couple
 * the two supervisors' read of their own host would defeat the
 * per-host shape the protocol exists to enforce.
 */
export function validateObservedLockFacts(
	observed: ObservedLockFacts,
): { ok: true; hostCount: 2 } | ValidationFailure {
	const provenanceIssue = observationProvenanceIssue(observed);
	if (provenanceIssue !== null) {
		return { ok: false, code: provenanceIssue };
	}
	if (!isPlainObject(observed.mac) || !isPlainObject(observed.linux)) {
		return { ok: false, code: "TRUST_OBSERVATION_OMITTED" };
	}
	const mac = observed.mac;
	const linux = observed.linux;
	if (
		!LOCK_PLATFORMS.includes(mac.platform as (typeof LOCK_PLATFORMS)[number]) ||
		!LOCK_PLATFORMS.includes(linux.platform as (typeof LOCK_PLATFORMS)[number])
	) {
		return { ok: false, code: "TRUST_OBSERVATION_DRIFT" };
	}
	if (mac.platform === linux.platform) {
		return { ok: false, code: "TRUST_OBSERVATION_DRIFT" };
	}
	for (const facts of [mac, linux]) {
		for (const field of ["lockVersion", "lockDigestSha256", "locks"] as const) {
			const value = facts[field];
			if (field === "lockDigestSha256") {
				if (typeof value !== "string" || !LOCK_HEX64.test(value)) {
					return { ok: false, code: "TRUST_OBSERVATION_DRIFT" };
				}
			} else if (field === "locks") {
				if (!Array.isArray(value)) {
					return { ok: false, code: "TRUST_OBSERVATION_OMITTED" };
				}
			} else {
				if (typeof value !== "string" || value === "") {
					return { ok: false, code: "TRUST_OBSERVATION_OMITTED" };
				}
			}
		}
	}
	return { ok: true, hostCount: 2 };
}

/**
 * Validates a supervisor-measured manifest observation.
 *
 * Same rules as the lock observation, applied to the per-host
 * shape: a non-supervisor provenance is refused structurally,
 * both hosts must be present, every fact on each host must be
 * observed, the manifest digest must be a real 64-char hex, and
 * the two hosts must name the two real platforms. A cross-host
 * digest mismatch is *not* caught here: that is a campaign-level
 * fact the set validator enforces, and asking the per-host
 * observation to couple the two supervisors' read of their own
 * host would defeat the per-host shape the protocol exists to
 * enforce.
 */
export function validateObservedManifestFacts(
	observed: ObservedManifestFacts,
): { ok: true; hostCount: 2 } | ValidationFailure {
	const provenanceIssue = observationProvenanceIssue(observed);
	if (provenanceIssue !== null) {
		return { ok: false, code: provenanceIssue };
	}
	if (!isPlainObject(observed.mac) || !isPlainObject(observed.linux)) {
		return { ok: false, code: "TRUST_OBSERVATION_OMITTED" };
	}
	const mac = observed.mac;
	const linux = observed.linux;
	if (
		!MANIFEST_PLATFORMS.includes(
			mac.platform as (typeof MANIFEST_PLATFORMS)[number],
		) ||
		!MANIFEST_PLATFORMS.includes(
			linux.platform as (typeof MANIFEST_PLATFORMS)[number],
		)
	) {
		return { ok: false, code: "TRUST_OBSERVATION_DRIFT" };
	}
	if (mac.platform === linux.platform) {
		return { ok: false, code: "TRUST_OBSERVATION_DRIFT" };
	}
	for (const facts of [mac, linux]) {
		for (const field of [
			"manifestVersion",
			"manifestDigestSha256",
			"manifests",
		] as const) {
			const value = facts[field];
			if (field === "manifestDigestSha256") {
				if (typeof value !== "string" || !MANIFEST_HEX64.test(value)) {
					return { ok: false, code: "TRUST_OBSERVATION_DRIFT" };
				}
			} else if (field === "manifests") {
				if (!Array.isArray(value)) {
					return { ok: false, code: "TRUST_OBSERVATION_OMITTED" };
				}
			} else {
				if (typeof value !== "string" || value === "") {
					return { ok: false, code: "TRUST_OBSERVATION_OMITTED" };
				}
			}
		}
	}
	return { ok: true, hostCount: 2 };
}

const OFFICIAL_ROLE_NAMES = [
	"campaign-child",
	"artifact-child",
	"verifier-child",
	"report-child",
] as const;

/**
 * The two-host join of supervisor-measured toolchain observations.
 *
 * Carries its own schema tag rather than claiming to be
 * `host-runtime-facts-set/v1`, because a strict subset of the
 * `host-runtime-facts/v1` record wearing that record's schema would be the
 * same defect the per-host observation exists to remove. The supervisor
 * observes bunVersion, bunRevision and the executable digest on each host;
 * the rest of `host-runtime-facts/v1` (cpu, limits, measurement endpoint,
 * command receipts) is filled by a build-time step the live supervisor
 * does not perform, so this set does not wear its schema.
 */
export const OBSERVED_TOOLCHAIN_SET_SCHEMA =
	"observed-toolchain-set/v1" as const;

export interface ObservedToolchainSetV1 {
	readonly schema: typeof OBSERVED_TOOLCHAIN_SET_SCHEMA;
	readonly mac: ObservedToolchainHostFacts;
	readonly linux: ObservedToolchainHostFacts;
	readonly observedAt: string;
}

/**
 * Validate the two-host toolchain join. Reuses
 * `validateObservedToolchainFacts` for the per-host rules, and adds a
 * cross-host guard: the two platforms must be the two real platforms, in
 * the right slots. A Bun version match across hosts is *not* enforced here
 * -- the comparator does that, and the per-host observation is not the
 * place to couple the two supervisors' read of their own host.
 */
export function validateObservedToolchainSetV1(
	input: unknown,
): { ok: true; hostCount: 2 } | ValidationFailure {
	if (
		!isPlainObject(input) ||
		input.schema !== OBSERVED_TOOLCHAIN_SET_SCHEMA ||
		!isPlainObject(input.mac) ||
		!isPlainObject(input.linux) ||
		typeof input.observedAt !== "string" ||
		input.observedAt === ""
	) {
		return { ok: false, code: "TRUST_TOOLCHAIN_SET_INVALID" };
	}
	const hostResult = validateObservedToolchainFacts({
		provenance: "supervisor-measured",
		mac: input.mac as unknown as ObservedToolchainHostFacts,
		linux: input.linux as unknown as ObservedToolchainHostFacts,
	});
	if (!hostResult.ok) return hostResult;
	return { ok: true, hostCount: 2 };
}

const FORBIDDEN_ENVIRONMENT_KEY_PATTERN = /AUTHORITY|CAPABILITY|LOCK|TRUST/i;

export function validateDescriptorOnlyRoleLoading(
	input: unknown,
): { ok: true; roleCount: number } | ValidationFailure {
	if (!isPlainObject(input) || !Array.isArray(input.loads)) {
		return { ok: false, code: "TRUST_ROLE_COUNT_INVALID" };
	}
	const loads = input.loads;
	if (loads.length !== OFFICIAL_ROLE_NAMES.length) {
		return { ok: false, code: "TRUST_ROLE_COUNT_INVALID" };
	}
	const names = loads.map((load) =>
		isPlainObject(load) ? load.logicalName : null,
	);
	for (const [index, name] of OFFICIAL_ROLE_NAMES.entries()) {
		if (names[index] !== name) {
			return { ok: false, code: "TRUST_ROLE_COUNT_INVALID" };
		}
	}
	const descriptors = new Set<number>();
	for (const load of loads as Rec[]) {
		for (const key of ["roleFd", "addonFd"] as const) {
			const fd = load[key];
			if (typeof fd !== "number" || !Number.isInteger(fd) || fd <= 2) {
				return { ok: false, code: "TRUST_DESCRIPTOR_DUPLICATE" };
			}
			if (descriptors.has(fd)) {
				return { ok: false, code: "TRUST_DESCRIPTOR_DUPLICATE" };
			}
			descriptors.add(fd);
		}
	}
	for (const load of loads as Rec[]) {
		if (load.roleEntrypoint !== `/dev/fd/${String(load.roleFd)}`) {
			return { ok: false, code: "TRUST_ROLE_PATH_AUTHORITY_FORBIDDEN" };
		}
		if (load.addonPath !== `/dev/fd/${String(load.addonFd)}`) {
			return { ok: false, code: "TRUST_ADDON_FALLBACK_FORBIDDEN" };
		}
	}
	const environment = input.environment;
	if (environment !== undefined) {
		if (!isPlainObject(environment)) {
			return { ok: false, code: "TRUST_AUTHORITY_ENV_FORBIDDEN" };
		}
		for (const key of Object.keys(environment)) {
			if (
				key !== "COMPARISON_ADDON_FD" &&
				FORBIDDEN_ENVIRONMENT_KEY_PATTERN.test(key)
			) {
				return { ok: false, code: "TRUST_AUTHORITY_ENV_FORBIDDEN" };
			}
		}
	}
	if (isImplausibleDigest(input.authoritySha256)) {
		return { ok: false, code: "TRUST_AUTHORITY_ENV_FORBIDDEN" };
	}
	return { ok: true, roleCount: loads.length };
}

// ---------------------------------------------------------------------------
// Supervisor-owned physical-path observation contract
// ---------------------------------------------------------------------------

/**
 * A direct cable is proved by two signals together: the route resolves out of
 * the expected interface, and it resolves through **no gateway**.  The previous
 * form of this check required the route to end in `via <iface>` — the token
 * `via` introduces a *next hop*, so the check that exists to prove "no
 * intermediary" demanded the token that means there is one, and no output
 * `route -n get` or `ip route get` ever emits could satisfy it.  The real
 * formats are parsed by `topology.ts`, which is where they are documented, so
 * this consumes those parsers rather than keeping a second route model.
 */
function routeProvesDirectPath(
	route: unknown,
	iface: unknown,
	destination: unknown,
	host: "mac" | "linux",
): boolean {
	if (typeof route !== "string" || typeof iface !== "string") return false;
	if (typeof destination !== "string") return false;
	// `via` is the gateway token in every Linux route form; its presence is a
	// next hop, which is the one thing this check exists to exclude.
	if (/\bvia\b/.test(route)) return false;
	const parsed =
		host === "mac"
			? parseMacRoute(route, destination)
			: parseLinuxRoute(route, destination);
	return parsed.valid && parsed.interface === iface;
}

function isTailscaleLike(iface: unknown): boolean {
	return (
		typeof iface === "string" &&
		(iface.includes("tailscale") ||
			iface.startsWith("utun") ||
			iface.startsWith("ts"))
	);
}

function isLoopbackAddress(address: unknown): boolean {
	return (
		typeof address === "string" &&
		(address === "::1" || address.startsWith("127."))
	);
}

const OBSERVATION_TOOLS: Record<string, readonly string[]> = {
	mac: ["route", "ifconfig", "route+ifconfig"],
	// A single `ethtool -K` difference between the arms is otherwise invisible
	// and would be attributed to the transport.
	linux: ["ip", "tc", "ip+tc", "ethtool", "ip+tc+ethtool"],
};

export function validateSupervisorPhysicalReceipts(
	input: unknown,
):
	| { ok: true; receiptCount: number; linuxReceiptCount: number }
	| ValidationFailure {
	if (!isPlainObject(input) || !isPlainObject(input.observation)) {
		return { ok: false, code: "TRUST_LINUX_OBSERVATION_MISSING" };
	}
	// A caller supplying planned facts alongside (or as) the observation is an
	// echo of the plan, not an independent supervisor observation. Checking
	// only that the key is absent catches nothing: omit the field and hand
	// the plan in as the observation. The observation's own declared
	// provenance is what separates the two, so it is what gets checked.
	if (input.plannedFacts !== undefined) {
		return { ok: false, code: "TRUST_CHILD_OBSERVATION_FORBIDDEN" };
	}
	const declaredProvenance = (input.observation as Rec).provenance;
	if (
		declaredProvenance !== undefined &&
		declaredProvenance !== "supervisor-measured"
	) {
		return { ok: false, code: "TRUST_CHILD_OBSERVATION_FORBIDDEN" };
	}
	const observation = input.observation;
	const mac = observation.mac;
	const linux = observation.linux;
	if (!isPlainObject(linux)) {
		return { ok: false, code: "TRUST_LINUX_OBSERVATION_MISSING" };
	}
	if (!isPlainObject(mac)) {
		return { ok: false, code: "TRUST_SOURCE_ADDRESS_MISMATCH" };
	}
	if (mac.hostId === linux.hostId || mac.address === linux.address) {
		return { ok: false, code: "TRUST_HOST_IDS_MUST_DIFFER" };
	}
	if (isTailscaleLike(mac.interface) || isTailscaleLike(linux.interface)) {
		return { ok: false, code: "TRUST_TAILSCALE_MEASUREMENT_FORBIDDEN" };
	}

	const receipts = input.receipts;
	if (!Array.isArray(receipts) || receipts.length === 0) {
		return { ok: false, code: "TRUST_RUN_RECEIPTS_MISSING" };
	}
	const firstReceipt = receipts[0] as Rec;
	if (
		isLoopbackAddress(mac.address) ||
		(isPlainObject(firstReceipt) && firstReceipt.macAddress !== mac.address)
	) {
		return { ok: false, code: "TRUST_SOURCE_ADDRESS_MISMATCH" };
	}
	if (
		isLoopbackAddress(linux.address) ||
		(isPlainObject(firstReceipt) && firstReceipt.linuxAddress !== linux.address)
	) {
		return { ok: false, code: "TRUST_SOURCE_ADDRESS_MISMATCH" };
	}
	if (
		!routeProvesDirectPath(mac.route, mac.interface, linux.address, "mac") ||
		!routeProvesDirectPath(linux.route, linux.interface, mac.address, "linux")
	) {
		return { ok: false, code: "TRUST_ROUTE_MISMATCH" };
	}
	if (
		typeof mac.mtu !== "number" ||
		typeof linux.mtu !== "number" ||
		mac.mtu !== linux.mtu
	) {
		return { ok: false, code: "TRUST_MTU_MISMATCH" };
	}
	if (linux.peer !== mac.hostId || mac.peer !== linux.hostId) {
		return { ok: false, code: "TRUST_SERVER_PEER_MISMATCH" };
	}
	if (
		mac.qdiscBefore !== mac.qdiscAfter ||
		linux.qdiscBefore !== linux.qdiscAfter
	) {
		return { ok: false, code: "TRUST_QDISC_MISMATCH" };
	}
	for (const [host, record] of [
		["mac", mac],
		["linux", linux],
	] as const) {
		const allowed = OBSERVATION_TOOLS[host] ?? [];
		if (typeof record.tool !== "string" || !allowed.includes(record.tool)) {
			return { ok: false, code: "TRUST_OBSERVATION_COMMAND_MISMATCH" };
		}
	}

	const sshHostReceipts = input.sshHostReceipts;
	if (!Array.isArray(sshHostReceipts) || sshHostReceipts.length === 0) {
		return { ok: false, code: "TRUST_SSH_HOST_MISMATCH" };
	}
	const sshReceiptSha256 = sha256HexOfBytes(
		canonicalRecordBytes(sshHostReceipts[0]),
	);
	if (observation.sshHostReceiptSha256 !== sshReceiptSha256) {
		return { ok: false, code: "TRUST_SSH_HOST_MISMATCH" };
	}

	const cleanup = observation.cleanup;
	if (
		!isPlainObject(cleanup) ||
		cleanup.allRunsRestored !== true ||
		cleanup.allProcessGroupsReleased !== true ||
		cleanup.allQdiscRestored !== true
	) {
		return { ok: false, code: "TRUST_CLEANUP_OBSERVATION_MISSING" };
	}

	// Every receipt class must hash back to the digest the observation binds.
	const digestBindings: ReadonlyArray<readonly [string, unknown, string]> = [
		[
			"networkReceiptSetSha256",
			input.receipts,
			"TRUST_RUN_RECEIPT_SET_MISMATCH",
		],
		[
			"commandReceiptSetSha256",
			input.commandReceipts,
			"TRUST_OBSERVATION_COMMAND_MISMATCH",
		],
		["pathReceiptSetSha256", input.pathReceipts, "TRUST_ROUTE_MISMATCH"],
		["qdiscReceiptSetSha256", input.qdiscReceipts, "TRUST_QDISC_MISMATCH"],
		[
			"cleanupReceiptSetSha256",
			input.cleanupReceipts,
			"TRUST_CLEANUP_OBSERVATION_MISSING",
		],
	];
	for (const [field, value, code] of digestBindings) {
		if (value === undefined) {
			return { ok: false, code };
		}
		try {
			if (
				observation[field] !== sha256HexOfBytes(canonicalRecordBytes(value))
			) {
				return { ok: false, code };
			}
		} catch {
			return { ok: false, code };
		}
	}

	let linuxReceiptCount = 0;
	for (const receipt of receipts) {
		if (!isPlainObject(receipt)) {
			return { ok: false, code: "TRUST_RUN_RECEIPTS_MISSING" };
		}
		if (receipt.status !== "OBSERVED" || receipt.captureDropCount !== 0) {
			return { ok: false, code: "TRUST_RUN_RECEIPTS_MISSING" };
		}
		if (typeof receipt.linuxHostId === "string") linuxReceiptCount += 1;
	}
	if (isImplausibleDigest(input.authoritySha256)) {
		return { ok: false, code: "TRUST_SSH_HOST_MISMATCH" };
	}
	return { ok: true, receiptCount: receipts.length, linuxReceiptCount };
}

const CHILD_FORBIDDEN_OBSERVATION_FIELDS = [
	"uname",
	"cpuCount",
	"fdLimit",
	"route",
	"socketList",
	"launchReceipt",
	// The toolchain is the same class of fact as `uname` — a child could
	// claim any runtime it likes to defeat the promotion gate, and there
	// is no downstream check that can recover the truth. Forbidding the
	// umbrella name AND each of the per-field names is the structural
	// answer: a child cannot smuggle a toolchain in as a single
	// `{toolchain: ...}` object, and it cannot smuggle one in by naming
	// the per-host fields directly either. The supervisor's own
	// per-host observation is the only path the toolchain travels.
	"toolchain",
	"bunVersion",
	"bunRevision",
	"bunExecutableSha256",
	// The capability is the same class of fact as the toolchain — a child
	// could claim any capability digest it likes to defeat the promotion
	// gate, and there is no downstream check that can recover the truth.
	// Forbidding the umbrella name AND each of the per-field names is the
	// structural answer: a child cannot smuggle a capability in as a
	// single `{capability: ...}` object, and it cannot smuggle one in by
	// naming the per-host fields directly either. The supervisor's own
	// per-host observation is the only path the capability travels.
	"capability",
	"capabilityVersion",
	"capabilities",
	"capabilityDigestSha256",
	// The lock is the same class of fact as the capability -- a child
	// could claim any lock digest it likes to defeat the promotion
	// gate, and there is no downstream check that can recover the
	// truth. Forbidding the umbrella name AND each of the per-field
	// names is the structural answer: a child cannot smuggle a lock
	// in as a single `{lock: ...}` object, and it cannot smuggle one
	// in by naming the per-host fields directly either. The
	// supervisor's own per-host observation is the only path the
	// lock travels.
	"lock",
	"lockVersion",
	"locks",
	"lockDigestSha256",
	// The manifest is the same class of fact as the lock -- a child
	// could claim any manifest digest it likes to defeat the
	// promotion gate, and there is no downstream check that can
	// recover the truth. Forbidding the umbrella name AND each of
	// the per-field names is the structural answer: a child cannot
	// smuggle a manifest in as a single `{manifest: ...}` object,
	// and it cannot smuggle one in by naming the per-host fields
	// directly either. The supervisor's own per-host observation
	// is the only path the manifest travels.
	"manifest",
	"manifestVersion",
	"manifests",
	"manifestDigestSha256",
] as const;

export function validateChildObservationBoundary(
	input: unknown,
): { ok: true } | ValidationFailure {
	if (!isPlainObject(input) || !isPlainObject(input.childObservation)) {
		return { ok: false, code: "TRUST_CHILD_OBSERVATION_FORBIDDEN" };
	}
	const observation = input.childObservation;
	const allowedKinds = Array.isArray(input.allowedKinds)
		? input.allowedKinds
		: [];
	for (const field of CHILD_FORBIDDEN_OBSERVATION_FIELDS) {
		if (field in observation && !allowedKinds.includes(field)) {
			return { ok: false, code: "TRUST_CHILD_OBSERVATION_FORBIDDEN" };
		}
	}
	return { ok: true };
}

export function validateSupervisorReceiptOrigin(
	input: unknown,
): { ok: true; origin: "supervisor" } | ValidationFailure {
	if (!isPlainObject(input) || !isPlainObject(input.receipt)) {
		return { ok: false, code: "TRUST_CHILD_OBSERVATION_FORBIDDEN" };
	}
	if (input.origin !== "supervisor") {
		return { ok: false, code: "TRUST_CHILD_OBSERVATION_FORBIDDEN" };
	}
	return { ok: true, origin: "supervisor" };
}

// ---------------------------------------------------------------------------
// Measurement admission (M1 + M2)
//
// The binding copy of these rules is `secure_fs::measurement` in the Rust
// supervisor, because that is the one process the thing being measured cannot
// call. What lives here is the same two comparisons stated in the controller's
// own language, for three uses: the campaign can fail fast without paying a
// round trip to a child that is going to be refused, the codes have one
// spelling on both sides of the pipe, and the payload the supervisor parses is
// assembled in exactly one place rather than by each caller that has a leg.
//
// It is deliberately not a second gate. A validator that runs beside the
// producer can be skipped by the producer; this one is advice, and the
// supervisor's refusal is the fact.
// ---------------------------------------------------------------------------

/**
 * The supervisor's own two readings for one execution.
 *
 * `grantIssuedAtMs` is taken as the run-command frame is written -- before the
 * child exists, so before it can have measured anything -- and
 * `frameAcceptedAtMs` as the `artifact-payload` frame is accepted. Neither is
 * a number that arrived in a frame.
 */
export interface MeasurementWallBracket {
	readonly grantIssuedAtMs: number;
	readonly frameAcceptedAtMs: number;
}

/** One round trip as the driver's recorder filed it. */
export interface MeasurementRoundTrip {
	readonly sequence: number;
	readonly sentAtMs: number;
	readonly receivedAtMs: number;
	readonly latencyMs: number;
}

/**
 * The series an `artifact-payload` frame carries.
 *
 * Structural on purpose: this module must not import the driver, whose import
 * graph pulls the adapters into the official-root reachability set.
 */
export interface MeasurementSeries {
	readonly samples: readonly number[];
	readonly roundTrips: readonly MeasurementRoundTrip[];
	readonly ledger: { readonly delivered?: number };
	readonly provenance: {
		readonly sampleCount: number;
		readonly firstSampleAtMs: number;
		readonly lastSampleAtMs: number;
	};
}

/**
 * How many ulps of the compared magnitude one comparison admits.
 *
 * The same constant as `SLACK_ULPS` in the Rust module, and it has to stay the
 * same one: this is the width of a per-sample forgery channel, and two copies
 * of a gate that admit different bands are two gates.
 *
 * Measured, not chosen: over a hundred thousand epoch-scale round trips the
 * worst honest residual of `(receivedAtMs - sentAtMs) - latencyMs` is 1.2e-4
 * ms, under one ulp of the stamps. Eight ulps is 3.2 microseconds. It was 4096
 * -- 1.63 ms, wider than the latency on every local cell -- beside a docstring
 * claiming 1.5 microseconds.
 */
const SLACK_ULPS = 8;

/** The floor under the scaled slack, so a zero magnitude still compares. */
const EPSILON_MS = 1e-6;

/**
 * Slack for one comparison, scaled to the magnitude of its operands.
 *
 * Mirrors `slack_at` in the Rust module, and for the same reason: epoch
 * milliseconds are around 1.7e12, where one ulp is already a quarter of a
 * microsecond, so `receivedAtMs - sentAtMs` does not reproduce a recorded
 * latency bit for bit and a fixed nanosecond tolerance refuses honest series.
 *
 * What it admits, as the code computes it: a few microseconds at epoch scale.
 * That is the cost of representing the stamps, not a measurement allowance.
 * Scaling to the latency instead does not narrow the band -- it collapses to
 * `EPSILON_MS`, two orders under the honest residual, and refuses honest legs.
 */
function slackAt(magnitude: number): number {
	return Math.max(
		Math.abs(magnitude) * (Number.EPSILON * SLACK_ULPS),
		EPSILON_MS,
	);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Apply M1 and M2 to one series under one bracket.
 *
 * M1, the wall bracket: a window outside the supervisor's launch-to-acceptance
 * interval did not happen on this run, whatever clock produced it. That is what
 * makes a fabricated stepping clock useless without closing the seam that lets
 * one be stood up -- which is the difference between this and the two guards
 * that were defeated by execution.
 *
 * M2, the series/ledger join: the sample count, the round trips, the declared
 * count and the ledger's deliveries must be the same number, each sample must
 * be the latency of the trip it sits beside, and each sequence must appear
 * once.
 *
 * What neither bounds, stated rather than implied: the distribution inside the
 * window. A forger who runs the honest leg and reports every sample at a third
 * of its real latency, keeping the count and the window intact, passes both.
 * Closing that needs per-message timestamps observed off-process.
 */
export function validateMeasurementAdmission(
	series: unknown,
	bracket: MeasurementWallBracket,
): { ok: true; sampleCount: number } | ValidationFailure {
	if (!isPlainObject(series)) {
		return { ok: false, code: "TRUST_RECORD_MALFORMED" };
	}
	const samples = series.samples;
	const roundTrips = series.roundTrips;
	const provenance = series.provenance;
	const ledger = series.ledger;
	if (
		!Array.isArray(samples) ||
		!Array.isArray(roundTrips) ||
		!isPlainObject(provenance) ||
		!isPlainObject(ledger)
	) {
		return { ok: false, code: "TRUST_RECORD_MALFORMED" };
	}
	const declaredCount = provenance.sampleCount;
	const delivered = ledger.delivered;
	if (!isCount(declaredCount) || !isCount(delivered)) {
		return { ok: false, code: "TRUST_RECORD_MALFORMED" };
	}

	// M2 first: a series that does not describe the traffic beside it is not a
	// measurement of it, and asking that before the window keeps each refusal
	// reporting the thing it is about.
	if (
		roundTrips.length !== samples.length ||
		declaredCount !== samples.length ||
		delivered !== samples.length
	) {
		return { ok: false, code: "MEASUREMENT_SERIES_LEDGER_DIVERGES" };
	}
	const seen = new Set<number>();
	const trips: MeasurementRoundTrip[] = [];
	for (const [index, entry] of roundTrips.entries()) {
		if (!isPlainObject(entry)) {
			return { ok: false, code: "TRUST_RECORD_MALFORMED" };
		}
		const { sequence, sentAtMs, receivedAtMs, latencyMs } = entry;
		if (
			!isCount(sequence) ||
			!isFiniteNumber(sentAtMs) ||
			!isFiniteNumber(receivedAtMs) ||
			!isFiniteNumber(latencyMs)
		) {
			return { ok: false, code: "TRUST_RECORD_MALFORMED" };
		}
		const sample = samples[index];
		if (!isFiniteNumber(sample)) {
			return { ok: false, code: "TRUST_RECORD_MALFORMED" };
		}
		// A series rewritten beside intact timestamps fails the first of these;
		// timestamps rewritten beside an intact series fail the second.
		if (Math.abs(sample - latencyMs) > slackAt(latencyMs)) {
			return { ok: false, code: "MEASUREMENT_SERIES_LEDGER_DIVERGES" };
		}
		if (Math.abs(receivedAtMs - sentAtMs - latencyMs) > slackAt(receivedAtMs)) {
			return { ok: false, code: "MEASUREMENT_SERIES_LEDGER_DIVERGES" };
		}
		if (seen.has(sequence)) {
			return { ok: false, code: "MEASUREMENT_SERIES_LEDGER_DIVERGES" };
		}
		seen.add(sequence);
		trips.push({ sequence, sentAtMs, receivedAtMs, latencyMs });
	}

	if (
		!isFiniteNumber(bracket.grantIssuedAtMs) ||
		!isFiniteNumber(bracket.frameAcceptedAtMs) ||
		bracket.frameAcceptedAtMs < bracket.grantIssuedAtMs
	) {
		return { ok: false, code: "MEASUREMENT_OUTSIDE_GRANT_WINDOW" };
	}
	// A leg that ran and recorded nothing is a real outcome, scored as one
	// downstream. There is no window to bracket and nothing promotable in it.
	if (samples.length === 0) {
		return { ok: true, sampleCount: 0 };
	}

	const firstSampleAtMs = provenance.firstSampleAtMs;
	const lastSampleAtMs = provenance.lastSampleAtMs;
	if (!isFiniteNumber(firstSampleAtMs) || !isFiniteNumber(lastSampleAtMs)) {
		return { ok: false, code: "TRUST_RECORD_MALFORMED" };
	}
	const contains = (atMs: number): boolean =>
		atMs >= bracket.grantIssuedAtMs - slackAt(bracket.grantIssuedAtMs) &&
		atMs <= bracket.frameAcceptedAtMs + slackAt(bracket.frameAcceptedAtMs);
	if (
		!contains(firstSampleAtMs) ||
		!contains(lastSampleAtMs) ||
		lastSampleAtMs < firstSampleAtMs
	) {
		return { ok: false, code: "MEASUREMENT_OUTSIDE_GRANT_WINDOW" };
	}
	let previousReceivedAtMs = Number.NEGATIVE_INFINITY;
	let latencySumMs = 0;
	for (const trip of trips) {
		if (
			!contains(trip.sentAtMs) ||
			!contains(trip.receivedAtMs) ||
			trip.receivedAtMs < trip.sentAtMs ||
			// One message is in flight at a time, so consecutive trips may not
			// overlap; without this, any number of long trips stacks into a
			// short window.
			trip.sentAtMs < previousReceivedAtMs - slackAt(trip.sentAtMs) ||
			trip.sentAtMs < firstSampleAtMs - slackAt(firstSampleAtMs) ||
			trip.receivedAtMs > lastSampleAtMs + slackAt(lastSampleAtMs)
		) {
			return { ok: false, code: "MEASUREMENT_OUTSIDE_GRANT_WINDOW" };
		}
		previousReceivedAtMs = trip.receivedAtMs;
		latencySumMs += trip.latencyMs;
	}
	const spanMs = lastSampleAtMs - firstSampleAtMs;
	// Each term carries its own rounding, so the sum's slack grows with the
	// number of terms.
	const sumSlack = slackAt(lastSampleAtMs) * (trips.length + 1);
	if (latencySumMs < -sumSlack || latencySumMs > spanMs + sumSlack) {
		return { ok: false, code: "MEASUREMENT_OUTSIDE_GRANT_WINDOW" };
	}
	// The declared window must be the window the trips occupy, or it is a third
	// statement standing beside two that already disagree with it.
	const first = trips[0] as MeasurementRoundTrip;
	const last = trips[trips.length - 1] as MeasurementRoundTrip;
	if (
		Math.abs(first.sentAtMs - firstSampleAtMs) > slackAt(firstSampleAtMs) ||
		Math.abs(last.receivedAtMs - lastSampleAtMs) > slackAt(lastSampleAtMs)
	) {
		return { ok: false, code: "MEASUREMENT_OUTSIDE_GRANT_WINDOW" };
	}
	return { ok: true, sampleCount: samples.length };
}

/**
 * The exact bytes an `artifact-payload` frame carries for one leg.
 *
 * One assembly point, so the payload the supervisor strict-parses is the
 * payload the driver produced -- not a selection of it made by whichever
 * caller happened to hold the leg. Canonical encoding, and the trailing
 * newline the Rust record parser accepts.
 */
export function measurementPayloadBytes(
	series: MeasurementSeries,
	grant: MeasurementGrantV1,
): Uint8Array {
	return canonicalRecordBytes({
		// The grant rides inside the payload rather than beside it, because the
		// payload is what the frame digests and what the supervisor
		// strict-parses. A grant carried in the header would be a claim about
		// bytes rather than a part of them.
		grant,
		samples: [...series.samples],
		roundTrips: series.roundTrips.map((trip) => ({
			sequence: trip.sequence,
			sentAtMs: trip.sentAtMs,
			receivedAtMs: trip.receivedAtMs,
			latencyMs: trip.latencyMs,
		})),
		ledger: series.ledger,
		provenance: series.provenance,
	});
}

/**
 * Canonical bytes for the two-host toolchain set. One assembly point so
 * the bytes the supervisor signs and the bytes the campaign compares
 * against are the same bytes -- a per-caller reconstruction is the
 * same defect the per-host observation's strict-subset schema exists to
 * remove.
 */
export function observedToolchainSetBytes(
	set: ObservedToolchainSetV1,
): Uint8Array {
	return canonicalRecordBytes(set);
}

/** SHA-256 of the canonical set bytes, the value the supervisor output commits to. */
export function observedToolchainSetSha256(
	set: ObservedToolchainSetV1,
): string {
	return sha256HexOfBytes(observedToolchainSetBytes(set));
}

/**
 * The two-host join of supervisor-measured capability observations.
 *
 * Carries its own schema tag rather than claiming to be
 * `host-runtime-facts-set/v1`, because a strict subset of the
 * `host-runtime-facts/v1` record wearing that record's schema would be the
 * same defect the per-host observation exists to remove. The supervisor
 * observes the capability digest and per-host hostSubmissions on each
 * host; the rest of `host-runtime-facts/v1` is filled by a build-time
 * step the live supervisor does not perform, so this set does not wear
 * its schema.
 */
export const OBSERVED_CAPABILITY_SET_SCHEMA =
	"observed-capability-set/v1" as const;

export interface ObservedCapabilitySetV1 {
	readonly schema: typeof OBSERVED_CAPABILITY_SET_SCHEMA;
	readonly mac: ObservedCapabilityHostFacts;
	readonly linux: ObservedCapabilityHostFacts;
	readonly observedAt: string;
}

/**
 * Validate the two-host capability join. Reuses
 * `validateObservedCapabilityFacts` for the per-host rules, and adds a
 * cross-host guard: the two platforms must be the two real platforms, in
 * the right slots. A capability digest match across hosts is *not*
 * enforced here -- the comparator does that, and the per-host
 * observation is not the place to couple the two supervisors' read of
 * their own host.
 */
export function validateObservedCapabilitySetV1(
	input: unknown,
): { ok: true; hostCount: 2 } | ValidationFailure {
	if (
		!isPlainObject(input) ||
		input.schema !== OBSERVED_CAPABILITY_SET_SCHEMA ||
		!isPlainObject(input.mac) ||
		!isPlainObject(input.linux) ||
		typeof input.observedAt !== "string" ||
		input.observedAt === ""
	) {
		return { ok: false, code: "TRUST_CAPABILITY_SET_INVALID" };
	}
	const hostResult = validateObservedCapabilityFacts({
		provenance: "supervisor-measured",
		mac: input.mac as unknown as ObservedCapabilityHostFacts,
		linux: input.linux as unknown as ObservedCapabilityHostFacts,
	});
	if (!hostResult.ok) return hostResult;
	return { ok: true, hostCount: 2 };
}

/**
 * Canonical bytes of the capability set. The same canonical-bytes rule
 * the toolchain set uses applies here: the bytes the supervisor signs
 * and the bytes the campaign compares against are the same bytes --
 * a per-caller reconstruction is the same defect the per-host
 * observation's strict-subset schema exists to remove.
 */
export function observedCapabilitySetBytes(
	set: ObservedCapabilitySetV1,
): Uint8Array {
	return canonicalRecordBytes(set);
}

/** SHA-256 of the canonical capability-set bytes, the value the supervisor output commits to. */
export function observedCapabilitySetSha256(
	set: ObservedCapabilitySetV1,
): string {
	return sha256HexOfBytes(observedCapabilitySetBytes(set));
}

/**
 * The two-host join of supervisor-measured lock observations.
 *
 * Carries its own schema tag rather than claiming to be
 * `host-runtime-facts-set/v1`, because a strict subset of the
 * `host-runtime-facts/v1` record wearing that record's schema would be
 * the same defect the per-host observation exists to remove. The
 * supervisor observes the lock digest and per-host hostSubmissions on
 * each host; the rest of `host-runtime-facts/v1` is filled by a
 * build-time step the live supervisor does not perform, so this set
 * does not wear its schema.
 */
export const OBSERVED_LOCK_SET_SCHEMA = "observed-lock-set/v1" as const;

export interface ObservedLockSetV1 {
	readonly schema: typeof OBSERVED_LOCK_SET_SCHEMA;
	readonly mac: ObservedLockHostFacts;
	readonly linux: ObservedLockHostFacts;
	readonly observedAt: string;
}

/**
 * Validate the two-host lock join. Reuses
 * `validateObservedLockFacts` for the per-host rules, and adds a
 * cross-host guard: the two platforms must be the two real platforms,
 * in the right slots. A lock digest match across hosts is *not*
 * enforced here -- the comparator does that, and the per-host
 * observation is not the place to couple the two supervisors' read
 * of their own host.
 */
export function validateObservedLockSetV1(
	input: unknown,
): { ok: true; hostCount: 2 } | ValidationFailure {
	if (
		!isPlainObject(input) ||
		input.schema !== OBSERVED_LOCK_SET_SCHEMA ||
		!isPlainObject(input.mac) ||
		!isPlainObject(input.linux) ||
		typeof input.observedAt !== "string" ||
		input.observedAt === ""
	) {
		return { ok: false, code: "TRUST_LOCK_SET_INVALID" };
	}
	const hostResult = validateObservedLockFacts({
		provenance: "supervisor-measured",
		mac: input.mac as unknown as ObservedLockHostFacts,
		linux: input.linux as unknown as ObservedLockHostFacts,
	});
	if (!hostResult.ok) return hostResult;
	return { ok: true, hostCount: 2 };
}

/**
 * Canonical bytes of the lock set. The same canonical-bytes rule the
 * toolchain set uses applies here: the bytes the supervisor signs and
 * the bytes the campaign compares against are the same bytes -- a
 * per-caller reconstruction is the same defect the per-host
 * observation's strict-subset schema exists to remove.
 */
export function observedLockSetBytes(set: ObservedLockSetV1): Uint8Array {
	return canonicalRecordBytes(set);
}

/** SHA-256 of the canonical lock-set bytes, the value the supervisor output commits to. */
export function observedLockSetSha256(set: ObservedLockSetV1): string {
	return sha256HexOfBytes(observedLockSetBytes(set));
}
