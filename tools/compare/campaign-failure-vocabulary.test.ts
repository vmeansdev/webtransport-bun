/**
 * The one cross-language pin on the §7 refusal-code vocabulary. The Rust
 * supervisors publish onto `remote-supervisor-refusal/v1` out of
 * `cohort::SECTION_7_CODES`; the TypeScript side splits the same set into the
 * staging refusals and the campaign failures (`validateRemoteStatusCodePair`
 * is the status-pair contract). Until this test existed each side pinned its
 * own length and nothing compared them, so a code added on one side could
 * seal a record the other refused to read.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
	COHORT_NOT_READY_FAILURE_CODE,
	COHORT_PROTOCOL_FAILURE_CODE,
	DELIVERY_CONTEXT_MISMATCH_FAILURE_CODE,
	WARMUP_PROTOCOL_FAILURE_CODE,
} from "./cohort-protocol.ts";
import {
	CAMPAIGN_FAILURE_CODES,
	CAMPAIGN_REFUSAL_CODES,
	isCampaignFailureCode,
	validateRemoteStatusCodePair,
} from "./cross-supervisor-protocol.ts";

const SECURE_FS_RS = new URL(
	"../../crates/native/src/secure_fs.rs",
	import.meta.url,
);

/** The literal list, in source order, exactly as the Rust compiler sees it. */
function rustSection7Codes(): readonly string[] {
	const source = readFileSync(SECURE_FS_RS, "utf8");
	const list = /pub const SECTION_7_CODES: &\[&str\] = &\[([^\]]*)\];/.exec(
		source,
	);
	if (list === null)
		throw new Error("SECTION_7_CODES not found in secure_fs.rs");
	const body = list[1] as string;
	const codes = [...body.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1] as string);
	// Every non-blank line of the body is one quoted literal and a comma.
	const lines = body
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	expect(lines.length).toBe(codes.length);
	for (const line of lines) expect(line).toMatch(/^"[A-Z_]+",$/);
	return codes;
}

describe("§7 vocabulary: Rust SECTION_7_CODES == TS refusal ∪ failure", () => {
	test("the sets and the order agree, 22 = 3 + 19", () => {
		const rust = rustSection7Codes();
		const ts = [...CAMPAIGN_REFUSAL_CODES, ...CAMPAIGN_FAILURE_CODES];
		expect(CAMPAIGN_REFUSAL_CODES.length).toBe(3);
		expect(CAMPAIGN_FAILURE_CODES.length).toBe(19);
		expect(rust.length).toBe(22);
		expect(new Set(rust).size).toBe(rust.length);
		expect(new Set(ts).size).toBe(ts.length);
		expect([...rust].sort()).toEqual([...ts].sort());
		expect(rust).toEqual(ts);
	});

	test("the two TS halves are disjoint and the split is the status-pair contract", () => {
		for (const code of CAMPAIGN_REFUSAL_CODES) {
			expect(isCampaignFailureCode(code)).toBe(false);
			expect(validateRemoteStatusCodePair("REFUSED", code).ok).toBe(true);
			expect(validateRemoteStatusCodePair("FAIL", code).ok).toBe(false);
		}
		for (const code of CAMPAIGN_FAILURE_CODES) {
			expect(validateRemoteStatusCodePair("FAIL", code).ok).toBe(true);
			expect(validateRemoteStatusCodePair("REFUSED", code).ok).toBe(false);
		}
	});

	test("DELIVERY_CONTEXT_MISMATCH is a failure code on both sides, and the cohort constants are members", () => {
		expect(rustSection7Codes()).toContain("DELIVERY_CONTEXT_MISMATCH");
		expect(isCampaignFailureCode("DELIVERY_CONTEXT_MISMATCH")).toBe(true);
		for (const code of [
			COHORT_PROTOCOL_FAILURE_CODE,
			COHORT_NOT_READY_FAILURE_CODE,
			WARMUP_PROTOCOL_FAILURE_CODE,
			DELIVERY_CONTEXT_MISMATCH_FAILURE_CODE,
		]) {
			expect(isCampaignFailureCode(code)).toBe(true);
		}
	});
});
