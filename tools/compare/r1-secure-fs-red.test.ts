import { describe, expect, test } from "bun:test";

import {
	R1_CAMPAIGN_AUTHORITY_SHA256,
	R1_CAMPAIGN_MANIFEST_V1_BYTES,
	R1_LINUX_DIRECTORY_IDENTITY,
	R1_MAC_DIRECTORY_IDENTITY,
	R1_MAC_STAGING_DIRECTORY_IDENTITY,
	R1_SECURE_FS_RACE_CASES,
	R1_SECURE_FS_IDENTITY_MUTATION_CASES,
	R1_SECURE_FS_REJECTION_CASES,
	R1_SECURE_FS_SYSCALL_SCRIPT,
	R1_STREAMING_LIMIT_FIXTURE,
	R1_WINDOWS_EARLY_REJECT_EXPECTATION,
	canonicalBytes,
	importExpectedModule,
	requiredExport,
	sha256Hex,
} from "./r1-fixtures.ts";

describe("R1 RED: secure filesystem boundary", () => {
	test("POSIX identity is pinned by group as well as by owner", () => {
		// The engine compared `owner_uid` and nothing else, so a root owned by
		// the expected user but a different group compared equal. Both halves of
		// the ownership pair are now pinned, and a shared-writable mode is its
		// own code rather than being folded into "not private".
		for (const identity of [
			R1_MAC_DIRECTORY_IDENTITY,
			R1_MAC_STAGING_DIRECTORY_IDENTITY,
			R1_LINUX_DIRECTORY_IDENTITY,
		]) {
			const record = identity as unknown as Record<string, unknown>;
			expect(typeof record.ownerUid).toBe("number");
			expect(typeof record.ownerGid).toBe("number");
			expect(record.mode).toBe(0o700);
		}
		const cases = new Map(
			R1_SECURE_FS_IDENTITY_MUTATION_CASES.map(([name, code]) => [name, code]),
		);
		expect(cases.get("wrong-root-gid")).toBe(
			"OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
		);
		expect(cases.get("wrong-staging-gid")).toBe(
			"OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
		);
		expect(cases.get("group-writable-root")).toBe(
			"OUTPUT_PATH_SHARED_WRITABLE",
		);
	});

	test("handle-relative policy requires inherited identities and rejects every unsafe component type", async () => {
		const mod = await importExpectedModule("./secure-fs.ts");
		const valid = {
			platform: "darwin",
			root: { kind: "mac-campaign", identity: R1_MAC_DIRECTORY_IDENTITY },
			staging: {
				kind: "mac-staging",
				identity: R1_MAC_STAGING_DIRECTORY_IDENTITY,
			},
			declaredFiles: [".campaign-reservation.json", "manifest.json"],
			followLinks: false,
			allowEnumeration: false,
			allowReplacement: false,
		};
		expect(requiredExport(mod, "validateSecureFsPolicy")(valid)).toEqual(
			expect.objectContaining({
				ok: true,
				handleRelative: true,
				enumeration: false,
			}),
		);
		for (const [kind, code] of R1_SECURE_FS_REJECTION_CASES) {
			expect(
				requiredExport(
					mod,
					"validateSecureFsPolicy",
				)({
					...valid,
					adversarialComponent: kind,
				}),
			).toEqual(expect.objectContaining({ ok: false, code }));
		}
		expect(
			requiredExport(
				mod,
				"validateSecureFsPolicy",
			)({
				...valid,
				platform: "linux",
				root: { kind: "linux-staging", identity: R1_LINUX_DIRECTORY_IDENTITY },
				staging: {
					kind: "linux-staging",
					identity: R1_LINUX_DIRECTORY_IDENTITY,
				},
			}),
		).toEqual(expect.objectContaining({ ok: true, platform: "linux" }));
		for (const [mutation, code] of R1_SECURE_FS_IDENTITY_MUTATION_CASES) {
			const mutated =
				mutation === "missing-root-identity"
					? { ...valid, root: { ...valid.root, identity: undefined } }
					: mutation === "wrong-root-identity"
						? {
								...valid,
								root: {
									...valid.root,
									identity: { ...R1_MAC_DIRECTORY_IDENTITY, inode: "1" },
								},
							}
						: mutation === "missing-staging-identity"
							? { ...valid, staging: { ...valid.staging, identity: undefined } }
							: mutation === "wrong-root-gid"
								? {
										...valid,
										root: {
											...valid.root,
											identity: {
												...R1_MAC_DIRECTORY_IDENTITY,
												ownerGid: 0,
											},
										},
									}
								: mutation === "wrong-staging-gid"
									? {
											...valid,
											staging: {
												...valid.staging,
												identity: {
													...R1_MAC_STAGING_DIRECTORY_IDENTITY,
													ownerGid: 0,
												},
											},
										}
									: mutation === "group-writable-root"
										? {
												...valid,
												root: {
													...valid.root,
													identity: {
														...R1_MAC_DIRECTORY_IDENTITY,
														mode: 0o770,
													},
												},
											}
										: {
												...valid,
												staging: {
													...valid.staging,
													identity: {
														...R1_MAC_STAGING_DIRECTORY_IDENTITY,
														inode: "2",
													},
												},
											};
			expect(requiredExport(mod, "validateSecureFsPolicy")(mutated)).toEqual(
				expect.objectContaining({ ok: false, code }),
			);
		}
	});

	test("bounded reads and hashes, exclusive creates, sync ordering, short I/O, EINTR, ENOSPC, and opaque cleanup are scripted fail-closed", async () => {
		const mod = await importExpectedModule("./secure-fs.ts");
		const bytes = R1_CAMPAIGN_MANIFEST_V1_BYTES;
		expect(
			requiredExport(
				mod,
				"readAndHashBounded",
			)({ bytes, maxBytes: 67_108_864 }),
		).toEqual(
			expect.objectContaining({
				ok: true,
				size: bytes.byteLength,
				sha256: sha256Hex(bytes),
			}),
		);
		expect(
			requiredExport(
				mod,
				"runSecureFsSyscallScript",
			)({
				rootIdentity: R1_MAC_DIRECTORY_IDENTITY,
				operations: R1_SECURE_FS_SYSCALL_SCRIPT,
			}),
		).toEqual(expect.objectContaining({ ok: true, operationCount: 9 }));
		for (const [failure, code] of [
			["short-read", "OUTPUT_READ_FAILED"],
			["EINTR", "OUTPUT_READ_FAILED"],
			["ENOSPC", "OUTPUT_WRITE_FAILED"],
			["file-sync-failure", "OUTPUT_SYNC_FAILED"],
			["parent-sync-failure", "OUTPUT_SYNC_FAILED"],
			["unexpected-syscall", "OUTPUT_SYSCALL_SCRIPT_MISMATCH"],
		] as const) {
			expect(
				requiredExport(
					mod,
					"runSecureFsSyscallScript",
				)({
					rootIdentity: R1_MAC_DIRECTORY_IDENTITY,
					operations: R1_SECURE_FS_SYSCALL_SCRIPT,
					injectedFailure: failure,
				}),
			).toEqual(expect.objectContaining({ ok: false, code }));
		}
		expect(
			requiredExport(
				mod,
				"cleanupCreatedFileToken",
			)({
				token: "opaque-created-file-token",
				rootIdentity: R1_MAC_DIRECTORY_IDENTITY,
			}),
		).toEqual(expect.objectContaining({ ok: true, tokenConsumed: true }));
	});

	test("streaming input is bounded above 2 MiB and race recovery is single-use without pathname fallback", async () => {
		const mod = await importExpectedModule("./secure-fs.ts");
		expect(
			requiredExport(
				mod,
				"readAndHashBounded",
			)({
				bytes: R1_STREAMING_LIMIT_FIXTURE.underLimitBytes,
				maxBytes: R1_STREAMING_LIMIT_FIXTURE.maxBytes,
			}),
		).toEqual(expect.objectContaining({ ok: true, size: 2 * 1024 * 1024 }));
		expect(
			requiredExport(
				mod,
				"readAndHashBounded",
			)({
				bytes: R1_STREAMING_LIMIT_FIXTURE.overLimitBytes,
				maxBytes: R1_STREAMING_LIMIT_FIXTURE.maxBytes,
			}),
		).toEqual(
			expect.objectContaining({ ok: false, code: "OUTPUT_FILE_TOO_LARGE" }),
		);
		expect(
			requiredExport(
				mod,
				"streamHashBounded",
			)({
				chunks: [
					new Uint8Array(1_048_576),
					new Uint8Array(1_048_576),
					new Uint8Array(1),
				],
				maxBytes: R1_STREAMING_LIMIT_FIXTURE.maxBytes,
			}),
		).toEqual(
			expect.objectContaining({ ok: false, code: "OUTPUT_FILE_TOO_LARGE" }),
		);
		for (const [race, code] of R1_SECURE_FS_RACE_CASES) {
			expect(
				requiredExport(
					mod,
					"recoverSecureFsRace",
				)({
					rootIdentity: R1_MAC_DIRECTORY_IDENTITY,
					race,
					ownedToken: "opaque-created-file-token",
				}),
			).toEqual(expect.objectContaining({ ok: false, code }));
		}
		expect(
			requiredExport(
				mod,
				"recoverSecureFsRace",
			)({
				rootIdentity: R1_MAC_DIRECTORY_IDENTITY,
				race: "single-use-recovery",
				ownedToken: "opaque-created-file-token",
				alreadyConsumed: true,
			}),
		).toEqual(
			expect.objectContaining({ ok: false, code: "OUTPUT_CLEANUP_FAILED" }),
		);
	});

	test("Windows comparison supervisor rejects before argument, environment, path, descriptor, loader, spawn, or artifact access", async () => {
		const mod = await importExpectedModule("./secure-fs.ts");
		expect(
			requiredExport(
				mod,
				"comparisonSupervisorWindowsStub",
			)({
				...R1_WINDOWS_EARLY_REJECT_EXPECTATION,
				argv: ["resident-mac", "--authority-fd", "3"],
				environment: { AUTHORITY_SHA256: R1_CAMPAIGN_AUTHORITY_SHA256 },
			}),
		).toEqual(
			expect.objectContaining({
				code: "OUTPUT_PLATFORM_UNSUPPORTED",
				stdout: "",
				ioEvents: [],
				spawnedChildren: 0,
			}),
		);
	});
});
