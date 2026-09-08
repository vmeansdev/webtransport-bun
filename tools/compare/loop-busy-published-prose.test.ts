/**
 * The two pieces of prose the campaign publishes about `busyMs`.
 *
 * Both are strings, and a string is exactly the kind of deliverable that can
 * be narrowed back to a weaker claim without a single test noticing. That
 * already happened once here: `SESSION_LOOP_BUSY_MS_DEFINITION` was reverted
 * to its pre-plan wording -- the wording that named only the arrival turn and
 * claimed no harness exclusion -- and the suite stayed green, because nothing
 * in the tree read the constant's content.
 *
 * So these tests pin properties, not a hash. Each property is one thing the
 * published definition has to state, checked on its own so a narrowing turns
 * a named test red and the name says which claim went missing. A rewording
 * that keeps a property is free; dropping the property is not.
 *
 * The second half is the relay correction. The relay charges its own
 * reassembly and routing decode now, which changes the Phase-B figure the
 * campaign publishes, and a changed figure that the report does not own up to
 * is the same defect in a different place. The report must carry the
 * correction with the size that was actually measured, and with the frame
 * shape that size belongs to.
 */
import { describe, expect, test } from "bun:test";
import {
	RELAY_FRAME_DECODE_CHARGE_CORRECTION_NOTE,
	SESSION_LOOP_BUSY_MS_DEFINITION,
	SESSION_LOOP_BUSY_MS_REPORT_NOTE,
} from "./adapters/transport.ts";
import { renderMarkdownReport } from "./render-report.ts";

/**
 * One property the published definition must state, and the fragments that
 * prove it states it. The fragments are deliberately the load-bearing words
 * of the claim rather than whole sentences: a rewrite that keeps the claim
 * keeps them, and a rewrite that drops the claim cannot keep them.
 */
const REQUIRED_DEFINITION_PROPERTIES: readonly {
	readonly property: string;
	readonly states: readonly string[];
}[] = [
	{
		property:
			"names the quantity: JavaScript event-loop time on one session's transport work",
		states: ["JavaScript event-loop time", "session's transport work"],
	},
	{
		property: "covers both halves of the session over one window",
		states: ["ingest and egress", "same wall-clock window"],
	},
	{
		property:
			"charges both ingest turns: the arrival turn and the consumer turn that reads back out",
		states: ["arrival turn", "consumer turn", "reads it back out"],
	},
	{
		property: "excludes the wall time a reader spends waiting for a byte",
		states: ["never the wall time a reader spends waiting"],
	},
	{
		property: "excludes the wall time outbound bytes take to leave",
		states: ["never the wall time the bytes take to leave"],
	},
	{
		property:
			"denies being process CPU, and names native, kernel and other-thread time as excluded",
		states: [
			"not process CPU",
			"native, kernel and other-thread time are excluded",
		],
	},
	{
		property:
			"excludes harness work outside the session, such as generating or digesting a bulk payload",
		states: [
			"harness work outside the session",
			"generating or digesting a bulk payload",
		],
	},
];

describe("the published busyMs definition states its properties", () => {
	for (const { property, states } of REQUIRED_DEFINITION_PROPERTIES) {
		test(`the definition ${property}`, () => {
			for (const fragment of states) {
				expect(SESSION_LOOP_BUSY_MS_DEFINITION).toContain(fragment);
			}
		});
	}

	test("the report note carries the definition verbatim rather than a copy", () => {
		expect(SESSION_LOOP_BUSY_MS_REPORT_NOTE).toContain(
			SESSION_LOOP_BUSY_MS_DEFINITION,
		);
	});

	test("the rendered report publishes the definition itself", () => {
		expect(renderEmptyReport()).toContain(SESSION_LOOP_BUSY_MS_DEFINITION);
	});
});

function renderEmptyReport(): string {
	return renderMarkdownReport({
		campaignId: "loop-busy-published-prose",
		generatedAt: "2026-09-08T00:00:00.000Z",
		totalCells: 0,
		comparableCells: 0,
		rejectedCells: 0,
		comparisons: [],
	});
}

describe("the rendered report states the relay charging correction", () => {
	test("the correction and its measured per-frame size are in the report", () => {
		const md = renderEmptyReport();
		expect(md).toContain(RELAY_FRAME_DECODE_CHARGE_CORRECTION_NOTE);
		expect(md).toContain("1.28 to 1.38 microseconds per frame");
	});

	test("the report states the correction's size at the campaign rate", () => {
		const md = renderEmptyReport();
		expect(md).toContain("12.8 to 13.8 ms");
		expect(md).toContain("0.77 to 0.83 seconds per minute");
	});

	test("the report says which frame shape the figure applies to", () => {
		const md = renderEmptyReport();
		expect(md).toContain("100-byte ticker data frame");
	});

	test("the report names what the correction charges", () => {
		const md = renderEmptyReport();
		expect(md).toContain("reassembly");
		expect(md).toContain("routing decode");
	});

	test("the report does not cite the two withdrawn figures", () => {
		// The plan's 1.66 to 1.83 microseconds was measured on a different
		// frame shape, and the 18 microsecond citation was withdrawn as an
		// order-of-magnitude inflation. Neither may reappear as evidence.
		const md = renderEmptyReport();
		expect(md).not.toContain("1.66 to 1.83");
		expect(md).not.toContain("18 microseconds per frame");
		expect(md).not.toContain("10.8");
	});
});
