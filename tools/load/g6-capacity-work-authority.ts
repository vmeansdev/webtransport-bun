/** Small immutable execution capsule derived once from an already verified BOUND tree.
 * It is not fresh host evidence or an independent permission to dispatch.
 */
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { join } from "node:path";
import {
	budgetPolicyArtifactSha256,
	validateBudgetPolicy,
} from "./g6-c32-budget.ts";
import type {
	VerifiedBoundFreeze,
	VerifiedRetainedBoundFreeze,
} from "./g6-c32-freeze.ts";
import {
	type ArtifactIdentity,
	canonicalArtifactSha256,
} from "./g6-c32-freeze-model.ts";
import { validateHostIdentityPacket } from "./g6-c32-host.ts";
import type { RawPairIdentity } from "./g6-capacity-raw-work.ts";

export type WorkAuthority = {
	schema: "g6-capacity-work-authority/1";
	runId: string;
	candidateSha: string;
	registrationSha256: string;
	nativeProducerSha256: string;
	probeProducerSha256: string;
	policySha256: string;
	pair: RawPairIdentity;
	semanticFreezeAuthoritySha256: string;
	semanticFreezeArtifactSha256: string;
	hostBindingArtifactSha256: string;
	dispatchFreezeArtifactSha256: string;
};

const HASH_FIELDS = [
	"registrationSha256",
	"nativeProducerSha256",
	"probeProducerSha256",
	"policySha256",
	"semanticFreezeAuthoritySha256",
	"semanticFreezeArtifactSha256",
	"hostBindingArtifactSha256",
	"dispatchFreezeArtifactSha256",
] as const;
const PRODUCER_INPUTS = [
	"../../crates/native/src/send_path_diagnostics.rs",
	"../../crates/native/src/datagram_reflector.rs",
	"../../crates/native/src/udp_send_batch.rs",
	"../../crates/native/src/lib.rs",
	"../../crates/native/src/server_napi.rs",
	"g6-native-send-path.ts",
	"g6-shard-server.ts",
] as const;

function fail(message: string): never {
	throw Error(`g6-capacity-work-authority: ${message}`);
}
function object(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		fail("missing or unknown capsule fields");
	return value as Record<string, unknown>;
}
function digest(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function validateWorkAuthority(value: unknown): WorkAuthority {
	const raw = object(value, [
		"schema",
		"runId",
		"candidateSha",
		"pair",
		...HASH_FIELDS,
	]);
	if (
		raw.schema !== "g6-capacity-work-authority/1" ||
		typeof raw.runId !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(raw.runId) ||
		typeof raw.candidateSha !== "string" ||
		!/^[0-9a-f]{40}$/.test(raw.candidateSha) ||
		HASH_FIELDS.some(
			(key) => typeof raw[key] !== "string" || !/^[0-9a-f]{64}$/.test(raw[key]),
		)
	)
		fail("invalid capsule identity or digest");
	const pairRaw = object(raw.pair, ["server", "generator"]);
	const pair = {
		server: validateHostIdentityPacket(pairRaw.server),
		generator: validateHostIdentityPacket(pairRaw.generator),
	};
	for (const role of ["server", "generator"] as const) {
		const host = pair[role];
		if (
			host.envelope.runId !== raw.runId ||
			host.provider.role !== role ||
			host.source.commit !== raw.candidateSha ||
			host.source.statusPorcelain !== "" ||
			host.runtime.os !== "Linux" ||
			host.binary.kind !==
				(role === "server" ? "native-addon" : "mmo-client") ||
			host.provider.region !== "lon1" ||
			host.provider.size !== "c-48" ||
			host.provider.vcpus !== 48 ||
			host.provider.memoryMiB !== 98304
		)
			fail(`${role} differs from exact approved run/source/host shape`);
	}
	if (
		pair.server.provider.id === pair.generator.provider.id ||
		pair.server.bootId === pair.generator.bootId ||
		pair.server.provider.publicIpv4 === pair.generator.provider.publicIpv4 ||
		pair.server.provider.privateIpv4 === pair.generator.provider.privateIpv4 ||
		pair.server.provider.vpcUuid !== pair.generator.provider.vpcUuid ||
		pair.server.source.tree !== pair.generator.source.tree
	)
		fail("capsule does not contain a distinct exact host pair");
	return { ...raw, pair } as WorkAuthority;
}

/** Every component must be a real directory/file, including intermediate parents. */
function readBounded(
	root: string,
	path: string,
	maximum = 16 * 1024 * 1024,
): Buffer {
	if (
		!path ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path.split("/").some((piece) => !piece || piece === "." || piece === "..")
	)
		fail("unsafe retained authority path");
	let current = realpathSync(root);
	const pieces = path.split("/");
	for (const [index, piece] of pieces.entries()) {
		current = join(current, piece);
		const stat = lstatSync(current);
		if (
			stat.isSymbolicLink() ||
			(index < pieces.length - 1
				? !stat.isDirectory()
				: !stat.isFile() || stat.size > maximum)
		)
			fail("symlink, non-file or excessive retained authority");
	}
	const retained = lstatSync(current);
	const fd = openSync(
		current,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const before = fstatSync(fd);
		if (
			!before.isFile() ||
			before.size > maximum ||
			before.dev !== retained.dev ||
			before.ino !== retained.ino
		)
			fail("non-file, changed or excessive retained authority");
		const bytes = Buffer.alloc(before.size + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, null);
			if (count === 0) break;
			length += count;
		}
		const after = fstatSync(fd);
		if (
			length !== before.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs
		)
			fail("retained authority changed during its bounded read");
		return bytes.subarray(0, length);
	} finally {
		closeSync(fd);
	}
}

export function readWorkAuthority(root: string): WorkAuthority {
	return validateWorkAuthority(
		JSON.parse(
			readBounded(root, "work-authority.json", 256 * 1024).toString("utf8"),
		),
	);
}

/** Callers must first verify the complete BOUND tree, live or explicitly retained. */
export function deriveWorkAuthority(
	bound: VerifiedBoundFreeze | VerifiedRetainedBoundFreeze,
): WorkAuthority {
	function retained(identity: ArtifactIdentity, prefix = ""): Buffer {
		const bytes = readBounded(bound.root, `${prefix}${identity.path}`);
		if (digest(bytes) !== identity.sha256)
			fail(`retained digest changed: ${identity.path}`);
		return bytes;
	}
	const semantic = bound.semanticFreeze.authority;
	const policy = validateBudgetPolicy(
		JSON.parse(
			retained(semantic.budgetPolicy, "semantic/inputs/").toString("utf8"),
		),
	);
	if (
		policy.schema !== "g6-c32-budget-policy/2" ||
		policy.runId !== bound.runId
	)
		fail("bound policy is not this /2 work run");
	const pair = Object.fromEntries(
		(["server", "generator"] as const).map((role) => [
			role,
			validateHostIdentityPacket(
				JSON.parse(
					retained(
						bound.hostBinding.authority.hosts[role].identityPacket,
					).toString("utf8"),
				),
			),
		]),
	) as RawPairIdentity;
	const nativeHash = createHash("sha256");
	for (const name of PRODUCER_INPUTS) {
		const path = name.startsWith("../../")
			? name.slice(6)
			: `tools/load/${name}`;
		const identity = semantic.campaignInputs.find((item) => item.path === path);
		if (!identity) fail(`missing frozen native producer: ${path}`);
		nativeHash
			.update(name)
			.update("\0")
			.update(digest(retained(identity, "semantic/inputs/")))
			.update("\n");
	}
	const probeIdentity = semantic.campaignInputs.find(
		(item) => item.path === "tools/load/g6-linux-probe.ts",
	);
	if (!probeIdentity) fail("missing frozen Linux probe producer");
	return validateWorkAuthority({
		schema: "g6-capacity-work-authority/1",
		runId: bound.runId,
		candidateSha: semantic.candidate.commit,
		registrationSha256:
			bound.dispatchFreeze.authority.views.registration.sha256,
		nativeProducerSha256: nativeHash.digest("hex"),
		probeProducerSha256: digest(retained(probeIdentity, "semantic/inputs/")),
		policySha256: budgetPolicyArtifactSha256(policy),
		pair,
		semanticFreezeAuthoritySha256: bound.semanticFreeze.authoritySha256,
		semanticFreezeArtifactSha256: canonicalArtifactSha256(bound.semanticFreeze),
		hostBindingArtifactSha256: canonicalArtifactSha256(bound.hostBinding),
		dispatchFreezeArtifactSha256: canonicalArtifactSha256(bound.dispatchFreeze),
	});
}
