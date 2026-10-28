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
					: args.includes("ls-files")
						? "tools/offbox/linux-generator-entry-g6.sh\n"
						: "";
			},
		});

		expect(calls).toHaveLength(4);
		expect(calls[2]).toEqual([
			"git",
			"-C",
			"/root/wtb-candidate",
			"ls-files",
			"--error-unmatch",
			"--",
			"tools/offbox/linux-generator-entry-g6.sh",
		]);
	}, 15_000);

	test("rejects a dirty remote candidate before running its entrypoint", () => {
		expect(() =>
			assertOffboxCandidateProvenance({
				offboxClone: "/root/wtb-candidate",
				entryScript:
					"/root/wtb-candidate/tools/offbox/linux-generator-entry-g6.sh",
				candidateSha: "a".repeat(40),
				run: (args) =>
					args.includes("status")
						? " M tools/offbox/linux-generator-entry-g6.sh\n"
						: "",
			}),
		).toThrow("remote clone is dirty");
	}, 15_000);

	test("rejects an entrypoint outside the declared remote clone", () => {
		expect(() =>
			assertOffboxCandidateProvenance({
				offboxClone: "/root/wtb-candidate",
				entryScript: "/usr/local/bin/g6-generator",
				candidateSha: "a".repeat(40),
				run: () => "",
			}),
		).toThrow("must be inside G6_OFFBOX_CLONE");
	}, 15_000);
});
