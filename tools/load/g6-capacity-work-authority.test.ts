import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { VerifiedBoundFreeze } from "./g6-c32-freeze.ts";
import { canonicalArtifactSha256 } from "./g6-c32-freeze-model.ts";
import {
	workAuthorityFixture,
	workPolicyFixture,
} from "./g6-c32-work-fixture.test-helper.ts";
import type { WorkAuthority } from "./g6-capacity-work-authority.ts";

const module = await import("./g6-capacity-work-authority.ts").catch(
	() => null,
);
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function root() {
	const path = realpathSync(
		mkdtempSync(join(tmpdir(), "g6-work-authority-unit-")),
	);
	roots.push(path);
	return path;
}
function api() {
	if (!module) throw Error("work authority module is absent");
	return module;
}
const sha = (bytes: string | Buffer) =>
	createHash("sha256").update(bytes).digest("hex");

test("work authority requires its strict immutable capsule rather than caller hints", () => {
	expect(module?.validateWorkAuthority).toBeFunction();
	const validate = module?.validateWorkAuthority;
	if (!validate) throw Error("work authority validation is absent");
	for (const value of [null, {}, { schema: "g6-capacity-work-authority/1" }])
		expect(() => validate(value)).toThrow();
});

test("work authority has a bound-derived constructor and bounded retained reader", () => {
	expect(module?.deriveWorkAuthority).toBeFunction();
	expect(module?.readWorkAuthority).toBeFunction();
});

test("strict capsule binds a distinct exact Linux role pair and disallows override fields", () => {
	const value = workAuthorityFixture();
	expect(api().validateWorkAuthority(value)).toEqual(value);
	const mutations: Array<(v: WorkAuthority) => void> = [
		(v) => {
			v.runId = "../escaped";
		},
		(v) => {
			v.candidateSha = "f".repeat(40);
		},
		(v) => {
			v.registrationSha256 = "f".repeat(63);
		},
		(v) => {
			v.pair.server.runtime.os = "Darwin";
		},
		(v) => {
			Reflect.set(v.pair.server.source, "statusPorcelain", " M source.rs");
		},
		(v) => {
			v.pair.server.provider.size = "c-96-intel";
		},
		(v) => {
			v.pair.server.provider.role = "generator";
		},
		(v) => {
			v.pair.generator.bootId = v.pair.server.bootId;
		},
		(v) => {
			v.pair.generator.provider.id = v.pair.server.provider.id;
		},
		(v) => {
			v.pair.generator.source.tree = "e".repeat(40);
		},
	];
	for (const mutate of mutations) {
		const changed = structuredClone(value);
		mutate(changed);
		expect(() => api().validateWorkAuthority(changed)).toThrow();
	}
	expect(() =>
		api().validateWorkAuthority({ ...value, skipOwnerValidation: true }),
	).toThrow();
	const { dispatchFreezeArtifactSha256: _removed, ...missing } = value;
	expect(() => api().validateWorkAuthority(missing)).toThrow();
});

test("retained authority reader rejects symlink, non-file, excessive and malformed capsules", () => {
	const value = workAuthorityFixture();
	const normal = root();
	writeFileSync(join(normal, "work-authority.json"), JSON.stringify(value));
	expect(api().readWorkAuthority(normal)).toEqual(value);
	const linked = root();
	symlinkSync(
		join(normal, "work-authority.json"),
		join(linked, "work-authority.json"),
	);
	expect(() => api().readWorkAuthority(linked)).toThrow(/symlink/);
	const folder = root();
	mkdirSync(join(folder, "work-authority.json"));
	expect(() => api().readWorkAuthority(folder)).toThrow(/non-file/);
	const huge = root();
	writeFileSync(join(huge, "work-authority.json"), " ".repeat(256 * 1024 + 1));
	expect(() => api().readWorkAuthority(huge)).toThrow(/excessive/);
	writeFileSync(join(normal, "work-authority.json"), "{}");
	expect(() => api().readWorkAuthority(normal)).toThrow(/capsule/);
});

test("a capsule growing after its path-size check cannot evade the bounded reader", () => {
	const directory = root(),
		path = join(directory, "work-authority.json");
	writeFileSync(path, JSON.stringify(workAuthorityFixture()));
	const original = fs.lstatSync;
	const stat = spyOn(fs, "lstatSync").mockImplementation(((
		target: fs.PathLike,
		options?: unknown,
	) => {
		const result = original(target, options as never);
		if (String(target) === path)
			fs.appendFileSync(path, " ".repeat(256 * 1024));
		return result;
	}) as typeof fs.lstatSync);
	try {
		expect(() => api().readWorkAuthority(directory)).toThrow(
			/excessive|changed/,
		);
		expect(original(path).size).toBeGreaterThan(256 * 1024);
	} finally {
		stat.mockRestore();
	}
});

/** Minimal inputs to the constructor only; not a live BOUND verification fixture. */
function constructorFixture() {
	const directory = root(),
		policy = workPolicyFixture(),
		authority = workAuthorityFixture(policy);
	function artifact(path: string, value: unknown, prefix = "") {
		const bytes = JSON.stringify(value),
			target = join(directory, prefix, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, bytes);
		return { path, sha256: sha(bytes) };
	}
	const producerPaths = [
		"crates/native/src/send_path_diagnostics.rs",
		"crates/native/src/datagram_reflector.rs",
		"crates/native/src/udp_send_batch.rs",
		"crates/native/src/lib.rs",
		"crates/native/src/server_napi.rs",
		"tools/load/g6-native-send-path.ts",
		"tools/load/g6-shard-server.ts",
		"tools/load/g6-linux-probe.ts",
	];
	const budgetPolicy = artifact("unit-budget.json", policy, "semantic/inputs/");
	const campaignInputs = producerPaths.map((path) =>
		artifact(path, `explicit unit source ${path}`, "semantic/inputs/"),
	);
	const bound = {
		runId: policy.runId,
		root: directory,
		semanticFreeze: {
			authoritySha256: "1".repeat(64),
			authority: {
				candidate: { commit: authority.candidateSha },
				budgetPolicy,
				campaignInputs,
			},
		},
		hostBinding: {
			authority: {
				hosts: Object.fromEntries(
					(["server", "generator"] as const).map((role) => [
						role,
						{
							identityPacket: artifact(
								`hosts/${role}.json`,
								authority.pair[role],
							),
						},
					]),
				),
			},
		},
		dispatchFreeze: {
			authority: {
				views: {
					registration: {
						path: "registration.md",
						sha256: authority.registrationSha256,
					},
				},
			},
		},
	} as unknown as VerifiedBoundFreeze;
	return { bound, authority };
}

test("constructor binds actual retained producer bytes, pair packets and canonical policy", () => {
	const { bound, authority } = constructorFixture();
	const derived = api().deriveWorkAuthority(bound);
	expect(derived.pair).toEqual(authority.pair);
	expect(derived.policySha256).toBe(authority.policySha256);
	expect(derived.hostBindingArtifactSha256).toBe(
		canonicalArtifactSha256(bound.hostBinding),
	);
	expect(derived.probeProducerSha256).toBe(
		sha(
			readFileSync(
				join(bound.root, "semantic/inputs/tools/load/g6-linux-probe.ts"),
			),
		),
	);
	const changed = join(
		bound.root,
		"semantic/inputs/tools/load/g6-shard-server.ts",
	);
	writeFileSync(changed, "changed producer");
	expect(() => api().deriveWorkAuthority(bound)).toThrow(
		/retained digest changed/,
	);
});

test("constructor refuses absent producers and unsafe or swapped packet inputs", () => {
	const first = constructorFixture();
	first.bound.semanticFreeze.authority.campaignInputs.pop();
	expect(() => api().deriveWorkAuthority(first.bound)).toThrow(
		/missing frozen Linux probe/,
	);
	const second = constructorFixture();
	second.bound.hostBinding.authority.hosts.server.identityPacket.path =
		"../escaped.json";
	expect(() => api().deriveWorkAuthority(second.bound)).toThrow(/unsafe/);
	const third = constructorFixture();
	third.bound.hostBinding.authority.hosts.server.identityPacket =
		third.bound.hostBinding.authority.hosts.generator.identityPacket;
	expect(() => api().deriveWorkAuthority(third.bound)).toThrow(
		/server differs/,
	);
});
