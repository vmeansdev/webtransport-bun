/**
 * The staging transaction's uid boundary provisioning.
 *
 * `stage-only` lays the whole Mac trust tree as the invoking controller with
 * mode 0700, so the campaign supervisor account cannot traverse it and the
 * controller's twelve uid preconditions refuse before any traffic. These tests
 * pin the exact modes the provisioning applies per path class, prove no private
 * key is ever opened to the group, and bind the result to the controller's own
 * check list (`macUidPreflightChecks`) rather than to a restated copy of it.
 */
import { describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, relative, sep } from "node:path";
import { macUidPreflightChecks } from "./compare-controller.ts";
import {
	MAC_TRUST_CAMPAIGN_ROOT_ACL_PERMISSIONS,
	MAC_TRUST_CAMPAIGN_ROOT_MODE,
	MAC_TRUST_DIRECTORY_MODE,
	MAC_TRUST_PRIVATE_KEY_MODE,
	provisionMacTrustAccess,
	type TrustAccessGrant,
	WTCOMPARE_USER,
} from "./stage-live-campaign.ts";

const PERMISSION_BITS = 0o7777;

interface StagedTree {
	readonly boundary: string;
	readonly macRoot: string;
	readonly ancestors: readonly string[];
	readonly campaignRoot: string;
	readonly stagingRoot: string;
}

/**
 * A tree shaped like a freshly staged campaign: the evidence parents and the
 * trust root all laid 0700 the way `mkdirSync(..., { mode: 0o700 })` lays them,
 * the prestage directories, the authority pair, the staged rig public key, the
 * TLS pair and a private signing key beside them.
 */
function buildStagedTree(): StagedTree {
	const boundary = mkdtempSync(join(tmpdir(), "mac-trust-access-"));
	const trustStaging = join(
		boundary,
		".release-evidence/transport-comparison/.trust-staging",
	);
	const candidate = join(trustStaging, "0123456789abcdef");
	const macRoot = join(candidate, "campaign-r1");
	mkdirSync(macRoot, { recursive: true, mode: 0o700 });
	for (const dir of [
		"bin",
		"campaign-root",
		"incoming",
		"prebuilds",
		"roles",
		"staging-root",
		"tls",
		"replay/mac-records",
		"replay/rig-records",
	]) {
		mkdirSync(join(macRoot, dir), { recursive: true, mode: 0o700 });
	}
	writeFileSync(join(macRoot, "authority.json"), "{}\n", { mode: 0o600 });
	writeFileSync(join(macRoot, "authority-digest.bin"), "0", { mode: 0o600 });
	writeFileSync(join(macRoot, "stage-receipt.json"), "{}\n", { mode: 0o444 });
	writeFileSync(join(macRoot, "upcoming-run-command.sh"), "#!/bin/sh\n", {
		mode: 0o700,
	});
	writeFileSync(join(macRoot, "roles/server.ts"), "// staged\n", {
		mode: 0o644,
	});
	writeFileSync(
		join(macRoot, "staging-root/rig-supervisor-ed25519.pub"),
		"pub\n",
		{ mode: 0o600 },
	);
	writeFileSync(join(macRoot, "campaign-root/manifest.json"), "{}\n", {
		mode: 0o600,
	});
	writeFileSync(join(macRoot, "tls/staged-server-tls.crt"), "cert\n", {
		mode: 0o644,
	});
	writeFileSync(join(macRoot, "tls/staged-server-tls.key"), "key\n", {
		mode: 0o600,
	});
	writeFileSync(join(macRoot, "incoming/campaign-r1.mac.pk8"), "key\n", {
		mode: 0o600,
	});
	return {
		boundary,
		macRoot,
		ancestors: [
			join(boundary, ".release-evidence"),
			join(boundary, ".release-evidence/transport-comparison"),
			trustStaging,
			candidate,
		],
		campaignRoot: join(macRoot, "campaign-root"),
		stagingRoot: join(macRoot, "staging-root"),
	};
}

function modeOf(path: string): number {
	return statSync(path).mode & PERMISSION_BITS;
}

function withTree<T>(body: (tree: StagedTree) => T): T {
	const tree = buildStagedTree();
	try {
		return body(tree);
	} finally {
		rmSync(tree.boundary, { recursive: true, force: true });
	}
}

/** A recorder standing in for `/bin/chmod +a`, so the modes stay portable. */
function aclRecorder(): {
	readonly calls: { path: string; user: string; permissions: string }[];
	readonly grant: (path: string, user: string, permissions: string) => void;
} {
	const calls: { path: string; user: string; permissions: string }[] = [];
	return {
		calls,
		grant: (path, user, permissions) => {
			calls.push({ path, user, permissions });
		},
	};
}

function everyPathUnder(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			found.push(path);
			if (entry.isDirectory()) walk(path);
		}
	};
	walk(root);
	return found;
}

describe("provisionMacTrustAccess: the staged Mac trust tree's uid boundary", () => {
	it("opens traversal on every evidence ancestor of the trust root", () => {
		withTree((tree) => {
			for (const ancestor of tree.ancestors) {
				expect(modeOf(ancestor) & 0o010).toBe(0);
			}
			const report = provisionMacTrustAccess({
				macRoot: tree.macRoot,
				ancestorBoundary: tree.boundary,
				targetGroupId: process.getgid?.() ?? 0,
				grantDirectoryAcl: aclRecorder().grant,
			});
			for (const ancestor of tree.ancestors) {
				expect(modeOf(ancestor) & 0o010).toBe(0o010);
				expect(modeOf(ancestor) & 0o022).toBe(0);
			}
			expect(
				report.grants
					.filter((g) => g.pathClass === "ancestor-directory")
					.map((g) => g.path),
			).toEqual([...tree.ancestors]);
			// The boundary is the caller's repository root; provisioning stops there.
			expect(report.grants.some((g) => g.path === tree.boundary)).toBe(false);
		});
	});

	it("sets the trust root and its staged directories to 0750", () => {
		withTree((tree) => {
			provisionMacTrustAccess({
				macRoot: tree.macRoot,
				ancestorBoundary: tree.boundary,
				targetGroupId: process.getgid?.() ?? 0,
				grantDirectoryAcl: aclRecorder().grant,
			});
			for (const dir of [
				tree.macRoot,
				join(tree.macRoot, "bin"),
				join(tree.macRoot, "incoming"),
				join(tree.macRoot, "prebuilds"),
				join(tree.macRoot, "roles"),
				tree.stagingRoot,
				join(tree.macRoot, "tls"),
				join(tree.macRoot, "replay"),
				join(tree.macRoot, "replay/mac-records"),
				join(tree.macRoot, "replay/rig-records"),
			]) {
				expect([dir, modeOf(dir)]).toEqual([dir, MAC_TRUST_DIRECTORY_MODE]);
			}
			expect(MAC_TRUST_DIRECTORY_MODE).toBe(0o750);
		});
	});

	it("keeps campaign-root private in the mode bits and grants the target uid through an ACL", () => {
		withTree((tree) => {
			const acl = aclRecorder();
			const report = provisionMacTrustAccess({
				macRoot: tree.macRoot,
				ancestorBoundary: tree.boundary,
				targetGroupId: process.getgid?.() ?? 0,
				grantDirectoryAcl: acl.grant,
			});
			// An authority root that is group-writable in the mode bits is refused
			// by the supervisor's own bootstrap (`required_identity_matches`), so
			// the write the target uid needs cannot come from a group bit.
			expect(modeOf(tree.campaignRoot)).toBe(MAC_TRUST_CAMPAIGN_ROOT_MODE);
			expect(MAC_TRUST_CAMPAIGN_ROOT_MODE & 0o077).toBe(0);
			expect(acl.calls).toEqual([
				{
					path: tree.campaignRoot,
					user: WTCOMPARE_USER,
					permissions: MAC_TRUST_CAMPAIGN_ROOT_ACL_PERMISSIONS,
				},
			]);
			const grant = report.grants.find((g) => g.path === tree.campaignRoot);
			expect(grant?.pathClass).toBe("campaign-root");
			expect(grant?.aclUser).toBe(WTCOMPARE_USER);
		});
	});

	it("takes the target user from the caller rather than a second literal", () => {
		withTree((tree) => {
			const acl = aclRecorder();
			const report = provisionMacTrustAccess({
				macRoot: tree.macRoot,
				ancestorBoundary: tree.boundary,
				targetUser: "_someoneelse",
				targetGroupId: process.getgid?.() ?? 0,
				grantDirectoryAcl: acl.grant,
			});
			expect(report.targetUser).toBe("_someoneelse");
			expect(acl.calls.map((c) => c.user)).toEqual(["_someoneelse"]);
		});
	});

	it("never opens a private key to the group", () => {
		withTree((tree) => {
			const report = provisionMacTrustAccess({
				macRoot: tree.macRoot,
				ancestorBoundary: tree.boundary,
				targetGroupId: process.getgid?.() ?? 0,
				grantDirectoryAcl: aclRecorder().grant,
			});
			const keys = [
				join(tree.macRoot, "tls/staged-server-tls.key"),
				join(tree.macRoot, "incoming/campaign-r1.mac.pk8"),
			];
			for (const key of keys) {
				expect([key, modeOf(key)]).toEqual([key, MAC_TRUST_PRIVATE_KEY_MODE]);
				expect(modeOf(key) & 0o077).toBe(0);
			}
			expect(
				report.grants
					.filter((g) => g.pathClass === "private-key")
					.map((g) => g.path)
					.sort(),
			).toEqual([...keys].sort());
			expect(MAC_TRUST_PRIVATE_KEY_MODE).toBe(0o600);
		});
	});

	it("makes the authority pair, the staged rig public key and the staged records group-readable", () => {
		withTree((tree) => {
			provisionMacTrustAccess({
				macRoot: tree.macRoot,
				ancestorBoundary: tree.boundary,
				targetGroupId: process.getgid?.() ?? 0,
				grantDirectoryAcl: aclRecorder().grant,
			});
			for (const file of [
				join(tree.macRoot, "authority.json"),
				join(tree.macRoot, "authority-digest.bin"),
				join(tree.stagingRoot, "rig-supervisor-ed25519.pub"),
				join(tree.campaignRoot, "manifest.json"),
				join(tree.macRoot, "roles/server.ts"),
				join(tree.macRoot, "tls/staged-server-tls.crt"),
			]) {
				expect([file, modeOf(file) & 0o040]).toEqual([file, 0o040]);
				expect([file, modeOf(file) & 0o022]).toEqual([file, 0]);
			}
			expect(modeOf(join(tree.macRoot, "stage-receipt.json"))).toBe(0o444);
			expect(modeOf(join(tree.macRoot, "authority.json"))).toBe(0o640);
			expect(modeOf(join(tree.macRoot, "roles/server.ts"))).toBe(0o644);
		});
	});

	it("adds group execute only where the owner already has it", () => {
		withTree((tree) => {
			provisionMacTrustAccess({
				macRoot: tree.macRoot,
				ancestorBoundary: tree.boundary,
				targetGroupId: process.getgid?.() ?? 0,
				grantDirectoryAcl: aclRecorder().grant,
			});
			expect(modeOf(join(tree.macRoot, "upcoming-run-command.sh"))).toBe(0o750);
			expect(modeOf(join(tree.macRoot, "roles/server.ts")) & 0o010).toBe(0);
		});
	});

	it("grants write to neither group nor other anywhere in the tree", () => {
		withTree((tree) => {
			const report = provisionMacTrustAccess({
				macRoot: tree.macRoot,
				ancestorBoundary: tree.boundary,
				targetGroupId: process.getgid?.() ?? 0,
				grantDirectoryAcl: aclRecorder().grant,
			});
			for (const grant of report.grants) {
				expect([grant.path, grant.mode & 0o022]).toEqual([grant.path, 0]);
			}
			for (const path of everyPathUnder(tree.macRoot)) {
				expect([path, modeOf(path) & 0o022]).toEqual([path, 0]);
			}
		});
	});

	it("changes no owner, moves every path to the target's group, and reports what it applied", () => {
		withTree((tree) => {
			const report = provisionMacTrustAccess({
				macRoot: tree.macRoot,
				ancestorBoundary: tree.boundary,
				targetGroupId: process.getgid?.() ?? 0,
				grantDirectoryAcl: aclRecorder().grant,
			});
			const uid = process.getuid?.() ?? -1;
			expect(report.targetGroupId).toBe(process.getgid?.() ?? 0);
			for (const grant of report.grants) {
				const stat = statSync(grant.path);
				expect([grant.path, stat.uid]).toEqual([grant.path, uid]);
				expect([grant.path, stat.gid]).toEqual([
					grant.path,
					report.targetGroupId,
				]);
				expect([grant.path, grant.groupId]).toEqual([
					grant.path,
					report.targetGroupId,
				]);
				expect([grant.path, stat.mode & PERMISSION_BITS]).toEqual([
					grant.path,
					grant.mode,
				]);
			}
		});
	});

	it("touches every path in the tree exactly once", () => {
		withTree((tree) => {
			const report = provisionMacTrustAccess({
				macRoot: tree.macRoot,
				ancestorBoundary: tree.boundary,
				targetGroupId: process.getgid?.() ?? 0,
				grantDirectoryAcl: aclRecorder().grant,
			});
			const paths = report.grants.map((g) => g.path);
			expect(new Set(paths).size).toBe(paths.length);
			const inTree = new Set(
				paths.filter(
					(p) => p === tree.macRoot || p.startsWith(tree.macRoot + sep),
				),
			);
			for (const path of [tree.macRoot, ...everyPathUnder(tree.macRoot)]) {
				expect([path, inTree.has(path)]).toEqual([path, true]);
			}
		});
	});

	it("is idempotent", () => {
		withTree((tree) => {
			const first = provisionMacTrustAccess({
				macRoot: tree.macRoot,
				ancestorBoundary: tree.boundary,
				targetGroupId: process.getgid?.() ?? 0,
				grantDirectoryAcl: aclRecorder().grant,
			});
			const second = provisionMacTrustAccess({
				macRoot: tree.macRoot,
				ancestorBoundary: tree.boundary,
				targetGroupId: process.getgid?.() ?? 0,
				grantDirectoryAcl: aclRecorder().grant,
			});
			expect(second).toEqual(first);
		});
	});

	it("refuses a trust root that is not inside the stated boundary", () => {
		withTree((tree) => {
			expect(() =>
				provisionMacTrustAccess({
					macRoot: tree.macRoot,
					ancestorBoundary: join(tree.boundary, "elsewhere"),
					grantDirectoryAcl: aclRecorder().grant,
				}),
			).toThrow(/boundary/);
			expect(() =>
				provisionMacTrustAccess({
					macRoot: tree.boundary,
					ancestorBoundary: tree.boundary,
					grantDirectoryAcl: aclRecorder().grant,
				}),
			).toThrow(/boundary/);
		});
	});
});

/**
 * The binding to the contract: the controller's own twelve checks, evaluated
 * against what the provisioning applied. `macUidPreflightChecks` is the single
 * source for the argv list, so a check that changes there fails here rather
 * than passing against a restated copy.
 */
describe("the provisioned tree satisfies the controller's uid preflight", () => {
	interface AccessModel {
		readonly grants: ReadonlyMap<string, TrustAccessGrant>;
		readonly targetUser: string;
	}

	/** POSIX bits plus the one ACL the provisioning grants, for `who`. */
	function canAccess(
		model: AccessModel,
		who: "controller" | "target",
		path: string,
		need: "r" | "w" | "x",
	): boolean {
		const grant = model.grants.get(path);
		if (grant === undefined) return false;
		const bit = need === "r" ? 4 : need === "w" ? 2 : 1;
		// The controller owns every path it staged; the target uid reaches it
		// through its primary group, plus the campaign-root ACL.
		const posix =
			who === "controller"
				? ((grant.mode >> 6) & bit) !== 0
				: ((grant.mode >> 3) & bit) !== 0;
		if (posix) return true;
		if (who !== "target" || grant.aclUser !== model.targetUser) return false;
		return MAC_TRUST_CAMPAIGN_ROOT_ACL_PERMISSIONS.split(",").some(
			(permission) =>
				need === "r"
					? permission === "list"
					: need === "w"
						? permission === "add_file"
						: permission === "search",
		);
	}

	/** Files under a directory are reachable only if every parent is traversable. */
	function reachable(
		model: AccessModel,
		who: "controller" | "target",
		path: string,
		root: string,
	): boolean {
		const parts = relative(root, path)
			.split(sep)
			.filter((p) => p.length > 0);
		let current = root;
		if (!canAccess(model, who, current, "x")) return false;
		for (const part of parts.slice(0, -1)) {
			current = join(current, part);
			if (!canAccess(model, who, current, "x")) return false;
		}
		return true;
	}

	it("grants each in-tree check the access its argv tests, and touches no out-of-tree check", () => {
		withTree((tree) => {
			const report = provisionMacTrustAccess({
				macRoot: tree.macRoot,
				ancestorBoundary: tree.boundary,
				targetGroupId: process.getgid?.() ?? 0,
				grantDirectoryAcl: aclRecorder().grant,
			});
			const model: AccessModel = {
				grants: new Map(report.grants.map((g) => [g.path, g])),
				targetUser: report.targetUser,
			};
			const checks = macUidPreflightChecks({
				targetUser: WTCOMPARE_USER,
				macSigningKeyPath:
					"/var/db/webtransport-bun/comparison/keys/c/x.mac.pk8",
				macTrustDir: tree.macRoot,
				campaignRootDir: tree.campaignRoot,
				stagingRootDir: tree.stagingRoot,
				bunExecutablePath:
					"/usr/local/libexec/webtransport-bun/comparison/c/x/bun",
			});
			expect(checks).toHaveLength(12);
			// Nothing below is reachable unless the evidence ancestors are, so
			// the chain the staging transaction created is checked first.
			for (const ancestor of report.grants.filter(
				(g) => g.pathClass === "ancestor-directory",
			)) {
				expect([
					ancestor.path,
					canAccess(model, "target", ancestor.path, "x"),
				]).toEqual([ancestor.path, true]);
			}

			const inTree = (path: string) =>
				path === tree.macRoot || path.startsWith(tree.macRoot + sep);
			const verdicts: Record<number, string> = {};
			for (const check of checks) {
				// `sudo -n -u <user> /bin/test <flag> <path> [-a <flag> <path>]`
				const args = check.argv.slice(check.argv.indexOf("/bin/test") + 1);
				const who = check.argv[0] === "/usr/bin/sudo" ? "target" : "controller";
				const paths = args.filter((a) => a.startsWith("/"));
				if (paths.length === 0 || !paths.every(inTree)) {
					// Out-of-tree: the signing key, the staged Bun, /bin/kill, the
					// bare sudo grant. Provisioning must not reach any of them.
					for (const path of paths) {
						expect([
							check.index,
							report.grants.some((g) => g.path === path),
						]).toEqual([check.index, false]);
					}
					verdicts[check.index] = "out-of-tree";
					continue;
				}
				const negated = args[0] === "!";
				const pairs: { flag: string; path: string }[] = [];
				for (let i = negated ? 1 : 0; i < args.length; i += 1) {
					if (args[i] === "-a") continue;
					if (args[i]?.startsWith("-")) {
						const flag = args[i] as string;
						const path = args[i + 1] as string;
						pairs.push({ flag, path });
						i += 1;
					}
				}
				const satisfied = pairs.every(({ flag, path }) => {
					const need = flag === "-r" ? "r" : flag === "-w" ? "w" : "x";
					return (
						reachable(model, who, path, tree.macRoot) &&
						canAccess(model, who, path, need)
					);
				});
				expect([check.index, check.name, satisfied]).toEqual([
					check.index,
					check.name,
					!negated,
				]);
				verdicts[check.index] = "granted";
			}
			expect(verdicts).toEqual({
				1: "out-of-tree",
				2: "out-of-tree",
				3: "out-of-tree",
				4: "granted",
				5: "granted",
				6: "granted",
				7: "granted",
				8: "granted",
				9: "granted",
				10: "granted",
				11: "out-of-tree",
				12: "out-of-tree",
			});
		});
	});
});

describe("the real macOS ACL the provisioning installs", () => {
	it.skipIf(process.platform !== "darwin")(
		"lands one entry for the target user and leaves the mode bits private",
		() => {
			withTree((tree) => {
				// The ACL is installed for whatever account the caller names, so
				// this runs it for the account running the test: the mechanism is
				// what is under test, not the campaign's supervisor user.
				const self = userInfo().username;
				provisionMacTrustAccess({
					macRoot: tree.macRoot,
					ancestorBoundary: tree.boundary,
					targetUser: self,
					targetGroupId: process.getgid?.() ?? 0,
				});
				expect(statSync(tree.campaignRoot).mode & PERMISSION_BITS).toBe(
					MAC_TRUST_CAMPAIGN_ROOT_MODE,
				);
				const listed = Bun.spawnSync({
					cmd: ["/bin/ls", "-lde", tree.campaignRoot],
					stdout: "pipe",
					stderr: "pipe",
				});
				expect(listed.exitCode).toBe(0);
				const entries = listed.stdout
					.toString()
					.split("\n")
					.filter((line) => line.includes(`user:${self}`));
				expect(entries).toHaveLength(1);
				expect(entries[0]).toContain("allow");
				expect(entries[0]).toContain("add_file");
				expect(entries[0]).toContain("search");
			});
		},
	);
});
