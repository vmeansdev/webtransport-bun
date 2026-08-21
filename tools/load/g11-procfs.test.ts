import { describe, expect, test } from "bun:test";
import {
	parseUdpSocketRows,
	RIG_BASE_CLOCK_MHZ,
	summarizeSockets,
	sustainedThrottle,
} from "./g11-procfs.ts";

describe("sustained throttling — the campaign's per-cell validity flag", () => {
	test("a cell held under the rig's base clock is throttled", () => {
		// The 3550H is a 35 W mobile part: a two-hour run WILL come off boost, and
		// a capacity number taken there is a number about a slower CPU.
		expect(sustainedThrottle([1800, 1750, 1900, 1820])).toBe(true);
	});

	test("a cell running at or above base clock is not", () => {
		expect(sustainedThrottle([3400, 3200, 2900, 3100])).toBe(false);
		expect(sustainedThrottle([RIG_BASE_CLOCK_MHZ])).toBe(false);
	});

	test("one dip between two samples is scheduling, not thermal", () => {
		// The median, not the minimum. A minimum-based rule would flag every cell
		// that ever had an idle core between samples.
		expect(sustainedThrottle([3400, 900, 3300, 3200, 3350])).toBe(false);
	});

	test("an unreadable clock is null, never a cool reading", () => {
		expect(sustainedThrottle([])).toBe(null);
		expect(sustainedThrottle([Number.NaN])).toBe(null);
	});

	test("the base clock is the registered one, not a tuned one", () => {
		// AMD Ryzen 5 3550H: 2.1 GHz base, 3.7 GHz boost. Registered on the G11
		// campaign page before the run; a threshold may not move after one.
		expect(RIG_BASE_CLOCK_MHZ).toBe(2100);
	});
});

describe("per-socket drop attribution", () => {
	test("a row that does not parse is skipped, never counted as zero drops", () => {
		const text = [
			"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops",
			"   0: 0100007F:1194 00000000:0000 07 00000000:0000012C 00:00000000 00000000  1000        0 12345 2 0000 7",
			"   1: 0100007F:1194 00000000:0000 07 truncated",
		].join("\n");
		const rows = parseUdpSocketRows(text, 0x1194);
		expect(rows).toHaveLength(1);
		expect(summarizeSockets(rows)).toEqual({
			drops: 7,
			rxQueueBytes: 300,
			sockets: 1,
		});
	});

	test("no matching socket summarises to nothing, and the caller reads null", () => {
		expect(parseUdpSocketRows("header\n", 4520)).toEqual([]);
	});
});
