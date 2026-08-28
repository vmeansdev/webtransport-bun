import { describe, expect, test } from "bun:test";
import { assertOffboxCandidateProvenance } from "./g6-offbox-provenance.ts";

describe("G6 off-box provenance", () => {
	test("requires a tracked generator entrypoint in the exact remote candidate", () => {
		const calls: string[][] = [];
		assertOffboxCandidateProvenance({
			offboxClone: "/root/wtb-candidate",
			entryScript:
				"/root/wtb-candidate/tools/offbox/linux-generator-entry-g6.sh",
			candidateSha: "a".repeat(40),
			run: (args) => {
				calls.push(args);
				return args.includes("rev-parse")
					? `${"a".repeat(40)}\n`
					: "tools/offbox/linux-generator-entry-g6.sh\n";
			},
		});

		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual([
			"git",
			"-C",
			"/root/wtb-candidate",
			"ls-files",
			"--error-unmatch",
			"--",
			"tools/offbox/linux-generator-entry-g6.sh",
		]);
	});

	test("rejects an entrypoint outside the declared remote clone", () => {
		expect(() =>
			assertOffboxCandidateProvenance({
				offboxClone: "/root/wtb-candidate",
				entryScript: "/usr/local/bin/g6-generator",
				candidateSha: "a".repeat(40),
				run: () => "",
			}),
		).toThrow("must be inside G6_OFFBOX_CLONE");
	});
});
