/**
 * The router's contract, and V-H(a) demonstrated both ways: the real router
 * looks flat, and a deliberately O(M) one is caught.
 */

import { describe, expect, test } from "bun:test";
import { routingVerdict } from "./g8-classify.ts";
import {
	benchmarkRouting,
	forwardTargets,
	type RoomMember,
	RoomTable,
} from "./g8-router.ts";

function build(rooms: number, membersPerRoom: number): RoomTable<number> {
	const table = new RoomTable<number>();
	for (let r = 0; r < rooms; r += 1) {
		for (let m = 0; m < membersPerRoom; m += 1) {
			const handle = r * membersPerRoom + m;
			table.join({ handle, roomId: r, session: handle });
		}
	}
	return table;
}

describe("the routing rule", () => {
	test("a broadcast room forwards to K targets and never to the publisher", () => {
		const table = build(3, 11);
		const seen: number[] = [];
		// Handle 11 is room 1's first member — the publisher.
		const issued = forwardTargets(table, 11, (m) => seen.push(m.handle));
		expect(issued).toBe(10);
		expect(seen).not.toContain(11);
		expect(seen.every((h) => h >= 11 && h <= 21)).toBe(true);
	});

	test("a mutual room forwards to P-1, whoever the sender is", () => {
		const table = build(2, 10);
		for (const sender of [10, 14, 19]) {
			const seen: number[] = [];
			expect(forwardTargets(table, sender, (m) => seen.push(m.handle))).toBe(9);
			expect(seen).not.toContain(sender);
		}
	});

	test("forwarding stays inside the room", () => {
		const table = build(5, 11);
		const seen: number[] = [];
		forwardTargets(table, 22, (m) => seen.push(m.roomId));
		expect(new Set(seen)).toEqual(new Set([2]));
	});

	test("an unknown handle forwards nowhere rather than throwing", () => {
		expect(forwardTargets(build(2, 3), 999, () => {})).toBe(0);
	});

	test("the lookup is one map read on an integer key", () => {
		const table = build(10, 11);
		const entry = table.entryFor(0);
		expect(entry?.roomId).toBe(0);
		expect(entry?.members).toHaveLength(11);
		// Same array object every time: built at join, never rebuilt per arrival.
		expect(table.entryFor(0)?.members).toBe(entry?.members);
	});
});

describe("V-H(a) — the microbench discriminates", () => {
	// Small so the suite stays fast; the arm runs it with far more arrivals.
	const ARRIVALS = 20_000;

	test("the real router looks flat from M=10 to M=100 and clears the rule", () => {
		const points = benchmarkRouting([10, 50, 100], 11, ARRIVALS);
		expect(points).toHaveLength(3);
		expect(routingVerdict(points).fired).toBe(false);
	});

	test("an O(M) router — the shape the rule exists to exclude — is caught", () => {
		// A per-arrival scan over every room, which is what a `filter` over all
		// sessions or a sorted send queue costs.
		const scanned = ([10, 100] as const).map((rooms) => {
			const members: RoomMember<number>[] = [];
			for (let r = 0; r < rooms; r += 1) {
				for (let m = 0; m < 11; m += 1) {
					members.push({ handle: r * 11 + m, roomId: r, session: r });
				}
			}
			let sink = 0;
			const scan = (i: number): void => {
				const sender = (i % rooms) * 11;
				const room = Math.floor(sender / 11);
				for (const member of members) {
					if (member.roomId === room && member.handle !== sender) sink += 1;
				}
			};
			// Warm the loop for the same reason `benchmarkRouting` does: without
			// it the smallest M pays for tiering and the ratio understates.
			for (let i = 0; i < 2_000; i += 1) scan(i);
			const start = Number(Bun.nanoseconds());
			for (let i = 0; i < 2_000; i += 1) scan(i);
			const elapsed = Number(Bun.nanoseconds()) - start;
			if (sink < 0) throw new Error("unreachable");
			return { rooms, nsPerArrival: elapsed / 2_000 };
		});
		const v = routingVerdict(scanned);
		expect(v.fired).toBe(true);
		expect(v.reason).toBe("grew");
		// Comfortably past the 1.5x threshold. Not 10x, because even a scanning
		// router pays a fixed per-arrival cost that dilutes the growth at M=10 —
		// which is exactly why the threshold is 1.5 and not "grew by M".
		expect(v.ratio ?? 0).toBeGreaterThan(2);
	});
});
