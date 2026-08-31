import { describe, expect, test } from "bun:test";
import {
	assertBeforeDeadline,
	assertLifecycleTransition,
	type CreateIntent,
	type DesiredRig,
	type DropletIdentity,
	mayDestroy,
	nextCreateAttempt,
	type OwnedResource,
	type ReconcileDecision,
	type RigLifecycleState,
	type RigState,
	reconcileInventory,
	validateDesiredRig,
	validateRecoveryOutcome,
} from "./g6-c32-rig-model.ts";

const digest = (digit: string) => digit.repeat(64);

const desiredRig: DesiredRig = {
	recordedAt: "2026-08-30T12:00:00.000Z",
	requestedAt: "2026-08-30T12:00:00.000Z",
	deadline: "2026-08-30T16:00:00.000Z",
	runId: "g6-c32-rig-model-test",
	managementTag: "g6-c32-managed",
	runTag: "g6-c32-rig-model-test",
	roles: {
		serverName: "g6-c32-rig-model-test-server",
		generatorName: "g6-c32-rig-model-test-generator",
	},
	profile: {
		region: "ams3",
		size: "c-32",
		image: "ubuntu-24-04-x64",
		vpcUuid: "vpc-123",
		projectMode: "assign",
		projectId: "project-123",
		sshKeyId: 77,
		expectedVcpus: 32,
		expectedMemoryMiB: 65_536,
	},
	semantic: {
		freezeAuthoritySha256: digest("1"),
		freezeArtifactSha256: digest("2"),
		approvalAuthoritySha256: digest("3"),
		approvalArtifactSha256: digest("4"),
	},
	budget: {
		campaignId: "g6-c32-rca-fix-01",
		lifecycle: "rca-only",
		policyPath: "campaign/budget-policy.json",
		policySha256: digest("5"),
		totalBudgetMicrousd: 10_000_000,
		spentBeforeMicrousd: 0,
		priorLedgerArtifactSha256: null,
		maximumLifecycleCostMicrousd: 4_552_100,
		maximumLifecycleSeconds: 5_700,
		teardownReserveSeconds: 600,
		rolePriceCeilingMicrousd: { server: 1_300_600, generator: 1_300_600 },
		priceReceipt: {
			recordedAt: "2026-08-30T12:00:00.000Z",
			clockSource: "provider",
			runId: "g6-c32-rig-model-test",
			serverHourlyMicrousd: 1_300_600,
			generatorHourlyMicrousd: 1_300_600,
			artifactSha256: digest("6"),
		},
		absenceProof: {
			recordedAt: "2026-08-30T12:00:00.000Z",
			clockSource: "provider",
			runId: "g6-c32-rig-model-test",
			campaignTag: "g6-c32-managed",
			liveProviderIds: [],
			artifactSha256: digest("7"),
		},
	},
};

function droplet(
	role: "server" | "generator",
	overrides: Partial<DropletIdentity> = {},
): DropletIdentity {
	return {
		id: role === "server" ? 101 : 102,
		role,
		name:
			role === "server"
				? desiredRig.roles.serverName
				: desiredRig.roles.generatorName,
		tags: [desiredRig.managementTag, desiredRig.runTag],
		region: desiredRig.profile.region,
		size: desiredRig.profile.size,
		image: desiredRig.profile.image,
		vpcUuid: desiredRig.profile.vpcUuid,
		projectId: desiredRig.profile.projectId,
		sshKeyIds: [desiredRig.profile.sshKeyId],
		vcpus: desiredRig.profile.expectedVcpus,
		memoryMiB: desiredRig.profile.expectedMemoryMiB,
		status: "active",
		createdAt: "2026-08-30T12:01:00.000Z",
		publicIpv4: role === "server" ? "203.0.113.10" : "203.0.113.11",
		privateIpv4: role === "server" ? "10.0.0.10" : "10.0.0.11",
		...overrides,
	};
}

function owned(identity: DropletIdentity): OwnedResource {
	return {
		id: identity.id,
		role: identity.role as "server" | "generator",
		source: "CREATED",
		creationAttempt: 1,
		recordedAt: "2026-08-30T12:01:01.000Z",
		recordedIdentity: identity,
	};
}

function intent(overrides: Partial<CreateIntent> = {}): CreateIntent {
	return {
		state: "OPEN",
		mutationNonce: "nonce-1234567890",
		runId: desiredRig.runId,
		managementTag: desiredRig.managementTag,
		runTag: desiredRig.runTag,
		roles: desiredRig.roles,
		profile: desiredRig.profile,
		semantic: desiredRig.semantic,
		attempt: 1,
		notBefore: "2026-08-30T12:00:30.000Z",
		requestSha256: digest("5"),
		...overrides,
	};
}

function state(overrides: Partial<RigState> = {}): RigState {
	return {
		desired: desiredRig,
		lifecycle: "ABSENT",
		ownedResources: [],
		createIntent: null,
		creationAttempt: 0,
		evidence: {
			offrunnerEvidenceSealed: true,
			controllerExited: true,
			cleanupDisposition: "NEVER_DISPATCHED",
			inventoryAmbiguous: false,
		},
		...overrides,
	};
}

function kind(decision: ReconcileDecision): ReconcileDecision["kind"] {
	return decision.kind;
}

function permutations<T>(values: readonly T[]): T[][] {
	if (values.length < 2) return [[...values]];
	const result: T[][] = [];
	for (const [index, value] of values.entries()) {
		for (const tail of permutations(values.filter((_, i) => i !== index))) {
			result.push([value as T, ...tail]);
		}
	}
	return result;
}

describe("G6 c32 exact-two inventory reconciliation", () => {
	test("implements the complete deterministic decision table", () => {
		const server = droplet("server");
		const generator = droplet("generator");
		const pairOwned = [owned(server), owned(generator)];

		expect(reconcileInventory(state(), [])).toEqual({ kind: "CREATE_PAIR" });
		expect(
			reconcileInventory(
				state({
					lifecycle: "PROVISIONED",
					ownedResources: pairOwned,
					creationAttempt: 1,
				}),
				[generator, server],
			),
		).toEqual({ kind: "REUSE_PAIR", ids: [101, 102] });

		for (const resources of [[server], [server, generator]]) {
			const decision = reconcileInventory(
				state({
					lifecycle: "CREATING",
					createIntent: intent(),
					creationAttempt: 1,
				}),
				resources,
			);
			expect(decision.kind).toBe("RECOVER_INTENT");
			if (decision.kind === "RECOVER_INTENT") {
				expect(decision.resources.map(({ id }) => id)).toEqual(
					resources.map(({ id }) => id),
				);
			}
		}

		expect(
			reconcileInventory(
				state({
					lifecycle: "CREATING",
					ownedResources: [owned(server)],
					creationAttempt: 1,
				}),
				[server],
			),
		).toEqual({ kind: "DELETE_OWNED_AND_RETRY", ids: [101] });

		expect(
			reconcileInventory(
				state({
					lifecycle: "TERMINAL",
					ownedResources: pairOwned,
					creationAttempt: 1,
				}),
				[server, generator],
			),
		).toEqual({ kind: "DESTROY_TERMINAL", ids: [101, 102] });

		const exactLookingButUnowned = reconcileInventory(state(), [
			server,
			generator,
		]);
		expect(kind(exactLookingButUnowned)).toBe("INVENTORY_AMBIGUOUS");

		const unknown = droplet("server", {
			id: 999,
			role: null,
			name: "unknown-managed-resource",
		});
		expect(kind(reconcileInventory(state(), [unknown]))).toBe(
			"INVENTORY_AMBIGUOUS",
		);

		const extra = droplet("server", {
			id: 998,
			role: null,
			name: "extra-managed-resource",
		});
		expect(
			kind(
				reconcileInventory(
					state({
						lifecycle: "PROVISIONED",
						ownedResources: pairOwned,
						creationAttempt: 1,
					}),
					[server, generator, extra],
				),
			),
		).toBe("INVENTORY_AMBIGUOUS");

		const duplicateServer = droplet("server", { id: 103 });
		expect(
			kind(
				reconcileInventory(
					state({
						lifecycle: "CREATING",
						createIntent: intent(),
						creationAttempt: 1,
					}),
					[server, duplicateServer],
				),
			),
		).toBe("INVENTORY_AMBIGUOUS");

		const otherRun = droplet("server", {
			id: 997,
			role: null,
			name: "other-run-server",
			tags: [desiredRig.managementTag, "different-run"],
		});
		expect(kind(reconcileInventory(state(), [otherRun]))).toBe(
			"INVENTORY_AMBIGUOUS",
		);

		for (const drift of [
			droplet("server", { size: "c-16" }),
			droplet("server", { vpcUuid: "vpc-drifted" }),
			droplet("server", { projectId: "project-drifted" }),
		]) {
			const decision = reconcileInventory(
				state({
					lifecycle: "PROVISIONED",
					ownedResources: [owned(server), owned(generator)],
					creationAttempt: 1,
				}),
				[drift, generator],
			);
			expect(decision).toEqual({
				kind: "DELETE_OWNED_AND_RETRY",
				ids: [101, 102],
			});
		}

		const beforeIntent = droplet("server", {
			createdAt: "2026-08-30T12:00:29.999Z",
		});
		expect(
			kind(
				reconcileInventory(
					state({
						lifecycle: "CREATING",
						createIntent: intent(),
						creationAttempt: 1,
					}),
					[beforeIntent],
				),
			),
		).toBe("INVENTORY_AMBIGUOUS");

		const extraTag = droplet("server", {
			tags: [desiredRig.managementTag, desiredRig.runTag, "unexpected-tag"],
		});
		expect(
			kind(
				reconcileInventory(
					state({
						lifecycle: "CREATING",
						createIntent: intent(),
						creationAttempt: 1,
					}),
					[extraTag],
				),
			),
		).toBe("INVENTORY_AMBIGUOUS");

		expect(() =>
			reconcileInventory(state(), [
				droplet("server", { publicIpv4: "999.999.999.999" }),
			]),
		).toThrow(/IPv4/i);
		expect(() =>
			reconcileInventory(
				state({ lifecycle: "PROVISIONED", ownedResources: pairOwned }),
				[server, generator],
			),
		).toThrow(/creationAttempt|ownership/i);
	});

	test("is invariant to inventory ordering", () => {
		const server = droplet("server");
		const generator = droplet("generator");
		const fixtureState = state({
			lifecycle: "PROVISIONED",
			ownedResources: [owned(server), owned(generator)],
			creationAttempt: 1,
		});
		const serialized = permutations([server, generator]).map((inventory) =>
			JSON.stringify(reconcileInventory(fixtureState, inventory)),
		);
		expect(new Set(serialized).size).toBe(1);
	});

	test("never authorizes deletion of an unknown or malformed ID", () => {
		const server = droplet("server");
		const generator = droplet("generator");
		const resources = [owned(server), owned(generator)];
		for (let mask = 0; mask < 4; mask += 1) {
			const subset = resources.filter(
				(_, index) => (mask & (1 << index)) !== 0,
			);
			const inventory = subset.map(({ recordedIdentity }) => recordedIdentity);
			const decision = reconcileInventory(
				state({
					lifecycle: subset.length === 2 ? "TERMINAL" : "CREATING",
					ownedResources: subset,
					creationAttempt: subset.length === 0 ? 0 : 1,
				}),
				inventory,
			);
			if (
				decision.kind === "DELETE_OWNED_AND_RETRY" ||
				decision.kind === "DESTROY_TERMINAL"
			) {
				const ownedIds = new Set(subset.map(({ id }) => id));
				expect(decision.ids.length).toBeLessThanOrEqual(2);
				for (const id of decision.ids) {
					expect(
						Number.isFinite(id) && Number.isInteger(id) && id > 0,
					).toBeTrue();
					expect(ownedIds.has(id)).toBeTrue();
				}
			}
		}
	});
});

describe("G6 c32 lifecycle, deadline, retry, and destruction guards", () => {
	test("requires provider price and campaign-wide absence budget authority", () => {
		expect(validateDesiredRig(desiredRig)).toEqual(desiredRig);
		const overpriced = structuredClone(desiredRig);
		overpriced.budget.priceReceipt.serverHourlyMicrousd += 1;
		expect(() => validateDesiredRig(overpriced)).toThrow(
			/price|ceiling|budget/i,
		);
		const unchainedPostFix = structuredClone(desiredRig);
		unchainedPostFix.budget.lifecycle = "post-fix-only";
		expect(() => validateDesiredRig(unchainedPostFix)).toThrow(/prior-spend/i);
	});
	test("allows only the registered lifecycle and routes FAILED to teardown", () => {
		const path: RigLifecycleState[] = [
			"ABSENT",
			"CREATING",
			"PROVISIONED",
			"PREPARING",
			"PREPARED",
			"BINDING",
			"BOUND",
			"QUALIFYING",
			"RUNNING",
			"TERMINAL",
			"DESTROYING",
			"DESTROYED",
		];
		for (let index = 1; index < path.length; index += 1) {
			const from = path[index - 1];
			const to = path[index];
			if (!from || !to) throw new Error(`missing lifecycle pair at ${index}`);
			expect(assertLifecycleTransition(from, to)).toBe(to);
		}
		for (const from of path.slice(0, -1)) {
			expect(assertLifecycleTransition(from, "FAILED")).toBe("FAILED");
		}
		expect(assertLifecycleTransition("FAILED", "DESTROYING")).toBe(
			"DESTROYING",
		);
		for (const [from, to] of [
			["ABSENT", "PROVISIONED"],
			["PREPARED", "PREPARING"],
			["RUNNING", "BOUND"],
			["DESTROYED", "CREATING"],
		] as const) {
			expect(() => assertLifecycleTransition(from, to)).toThrow();
		}
	});

	test("requires one future deadline and permits only one creation retry", () => {
		expect(validateDesiredRig(desiredRig, "2026-08-30T12:00:00.000Z")).toEqual(
			desiredRig,
		);
		expect(() =>
			validateDesiredRig(
				{ ...desiredRig, deadline: desiredRig.requestedAt },
				"2026-08-30T12:00:00.000Z",
			),
		).toThrow(/deadline/i);
		expect(() =>
			validateDesiredRig(desiredRig, "2026-08-30T16:00:00.000Z"),
		).toThrow(/future|deadline/i);

		for (const boundary of [
			"before-local-gates",
			"before-ensure",
			"before-prepare",
			"before-bind",
			"before-qualification",
			"before-cell-A",
			"before-cell-B",
		]) {
			expect(
				assertBeforeDeadline(desiredRig, "2026-08-30T15:59:59.999Z", boundary),
			).toBe("2026-08-30T15:59:59.999Z");
		}
		expect(() =>
			assertBeforeDeadline(
				desiredRig,
				"2026-08-30T16:00:00.000Z",
				"before-cell-C",
			),
		).toThrow(/deadline.*before-cell-C/i);

		expect(nextCreateAttempt(0)).toBe(1);
		expect(nextCreateAttempt(1)).toBe(2);
		expect(() => nextCreateAttempt(2)).toThrow(/retry|exhausted/i);
	});

	test("models bounded recovery and refuses teardown unless every prerequisite holds", () => {
		for (const lifecycle of ["QUALIFYING", "RUNNING"] as const) {
			for (const outcome of [
				"RECOVERY_CLEAN",
				"RECOVERY_UNREACHABLE",
				"RECOVERY_TIMED_OUT",
			] as const) {
				expect(validateRecoveryOutcome(lifecycle, outcome)).toBe(outcome);
			}
		}
		expect(() =>
			validateRecoveryOutcome("PREPARING", "RECOVERY_CLEAN"),
		).toThrow(/QUALIFYING|RUNNING/i);

		const server = droplet("server");
		const generator = droplet("generator");
		const terminal = state({
			lifecycle: "FAILED",
			ownedResources: [owned(server), owned(generator)],
			creationAttempt: 1,
		});
		expect(
			mayDestroy(terminal, [generator, server], "2026-08-30T13:00:00.000Z"),
		).toEqual({ kind: "DESTROY", ids: [101, 102] });

		const refusalCases: RigState[] = [
			state({
				...terminal,
				lifecycle: "RUNNING",
			}),
			state({
				...terminal,
				evidence: {
					...terminal.evidence,
					offrunnerEvidenceSealed: false,
				},
			}),
			state({
				...terminal,
				evidence: { ...terminal.evidence, controllerExited: false },
			}),
			state({
				...terminal,
				evidence: { ...terminal.evidence, cleanupDisposition: null },
			}),
			state({
				...terminal,
				evidence: { ...terminal.evidence, inventoryAmbiguous: true },
			}),
		];
		for (const refusal of refusalCases) {
			expect(
				mayDestroy(refusal, [server, generator], "2026-08-30T13:00:00.000Z")
					.kind,
			).toBe("REFUSE_DESTROY");
		}
		expect(
			mayDestroy(
				terminal,
				[server, droplet("generator", { vpcUuid: "wrong-vpc" })],
				"2026-08-30T13:00:00.000Z",
			).kind,
		).toBe("REFUSE_DESTROY");

		const deadlineRecovery = state({
			...terminal,
			lifecycle: "RUNNING",
			evidence: {
				...terminal.evidence,
				cleanupDisposition: "RECOVERY_TIMED_OUT",
			},
		});
		expect(
			mayDestroy(
				deadlineRecovery,
				[server, generator],
				"2026-08-30T16:00:00.000Z",
			),
		).toEqual({ kind: "DESTROY", ids: [101, 102] });
	});
});
