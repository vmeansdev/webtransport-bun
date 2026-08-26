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

type Rec = Record<string, unknown>;

function isPlainObject(value: unknown): value is Rec {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

const OFFICIAL_ROLE_NAMES = [
	"campaign-child",
	"artifact-child",
	"verifier-child",
	"report-child",
] as const;

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

function routeMentionsInterface(route: unknown, iface: unknown): boolean {
	return (
		typeof route === "string" &&
		typeof iface === "string" &&
		route.endsWith(`via ${iface}`)
	);
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
	linux: ["ip", "tc", "ip+tc"],
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
	// echo of the plan, not an independent supervisor observation.
	if (input.plannedFacts !== undefined) {
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
		!routeMentionsInterface(mac.route, mac.interface) ||
		!routeMentionsInterface(linux.route, linux.interface)
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
