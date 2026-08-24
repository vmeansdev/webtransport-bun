import { describe, expect, test } from "bun:test";
import {
	G6_REGISTERED_OFFBOX_BRANCH,
	assertRegisteredG6CloneBranch,
	g6MacgenCloneCommand,
} from "./g6-offbox.ts";

describe("g6 off-box clone provisioning", () => {
	test("pins clone provisioning to the registered closeout branch", () => {
		expect(G6_REGISTERED_OFFBOX_BRANCH).toBe("probe/g6-mmo-closeout-04");
		expect(assertRegisteredG6CloneBranch("probe/g6-mmo-closeout-04")).toBe(
			"probe/g6-mmo-closeout-04",
		);
		expect(() => assertRegisteredG6CloneBranch("probe/g6-mmo-03")).toThrow(
			"g6-offbox: refusing unsafe mac generator branch 'probe/g6-mmo-03'; expected probe/g6-mmo-closeout-04",
		);
	});

	test("builds a branch-locked provisioning command for role clones", () => {
		const command = g6MacgenCloneCommand({
			cloneName: "wt-macgen-publisher",
			branch: "probe/g6-mmo-closeout-04",
		});

		expect(command).toContain("--branch probe/g6-mmo-closeout-04");
		expect(command).not.toContain("probe/g6-mmo-03");
		expect(command).toContain("CLONE=$HOME/wt-macgen-publisher;");
	});
});
