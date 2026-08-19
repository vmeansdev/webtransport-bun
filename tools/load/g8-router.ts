/**
 * The room router the G8 conductor forwards through, and the microbench that
 * proves it is O(1) in M.
 *
 * It is its own module for one reason: V-H(a) (`gate-g8-many-rooms.md` §6) has
 * to demonstrate that per-arrival routing cost does not grow with the room
 * count, and a microbench that benchmarks a *copy* of the router demonstrates
 * nothing. `bench-g8.ts` forwards through exactly these functions, so the
 * microbench and the arm are the same code.
 *
 * One routing rule covers both room shapes: **forward to every other member of
 * the sender's room.** That is `K` targets in a broadcast room, where the
 * publisher is a member that never receives its own media, and `P − 1` in a
 * mutual room. The server needs no notion of role, and the hello needs to carry
 * nothing but a room id.
 *
 * Registered prohibitions on the per-arrival path, transcribed from §6 V-H(a):
 * no array construction, no `filter`, no `sort`, no scan over sessions, no
 * string key built per arrival. The W3C send scheduler's per-datagram `q.sort()`
 * and linear `groupOrder.includes` (spec §Lever contracts) is the exact cost
 * shape being excluded.
 */

export type RoomMember<T> = {
	/** Dense integer handle. Never a string built per arrival. */
	readonly handle: number;
	readonly roomId: number;
	readonly session: T;
};

export type RoomEntry<T> = {
	readonly roomId: number;
	/** Built once at join. Walked, never rebuilt, filtered or sorted. */
	readonly members: RoomMember<T>[];
};

/**
 * Session handle → its room, and the room → its members.
 *
 * `Map.get` on an integer key is the whole per-arrival lookup. The members array
 * is built at join time and mutated only there.
 */
export class RoomTable<T> {
	private readonly byHandle = new Map<number, RoomEntry<T>>();
	private readonly byRoom = new Map<number, RoomEntry<T>>();

	/** Join at setup time. Never called on the arrival path. */
	join(member: RoomMember<T>): RoomEntry<T> {
		let entry = this.byRoom.get(member.roomId);
		if (entry === undefined) {
			entry = { roomId: member.roomId, members: [] };
			this.byRoom.set(member.roomId, entry);
		}
		entry.members.push(member);
		this.byHandle.set(member.handle, entry);
		return entry;
	}

	/** The per-arrival lookup. One `Map.get`, no allocation. */
	entryFor(handle: number): RoomEntry<T> | undefined {
		return this.byHandle.get(handle);
	}

	room(roomId: number): RoomEntry<T> | undefined {
		return this.byRoom.get(roomId);
	}

	get roomCount(): number {
		return this.byRoom.size;
	}

	get memberCount(): number {
		return this.byHandle.size;
	}

	rooms(): IterableIterator<RoomEntry<T>> {
		return this.byRoom.values();
	}
}

/**
 * Walk one arrival's targets, calling `issue` for every member of the sender's
 * room except the sender. Returns the number of targets issued to.
 *
 * This is the loop the arm runs and the loop the microbench times. Keeping them
 * one function is the point of the module.
 */
export function forwardTargets<T>(
	table: RoomTable<T>,
	senderHandle: number,
	issue: (member: RoomMember<T>) => void,
): number {
	const entry = table.entryFor(senderHandle);
	if (entry === undefined) return 0;
	const members = entry.members;
	let issued = 0;
	for (let i = 0; i < members.length; i += 1) {
		const member = members[i];
		if (member === undefined || member.handle === senderHandle) continue;
		issue(member);
		issued += 1;
	}
	return issued;
}

export type RoutingMicrobenchPoint = { rooms: number; nsPerArrival: number };

/**
 * V-H(a): time the routing path alone at several room counts.
 *
 * The `issue` callback does the minimum that cannot be optimised away, so what
 * is timed is the lookup plus the member walk and nothing else — no send, no
 * scheduler, no other tenant. If an O(1) router cannot look flat here, it is not
 * O(1), which is why §6 gives this check a tighter factor (1.5×) than the
 * in-arm discriminator V-H(b) (2×).
 *
 * Deterministic and allocation-free per iteration, so it can run anywhere:
 * off-runner in a unit test, and on the runner beside the arm.
 */
export function benchmarkRouting(
	roomCounts: readonly number[],
	membersPerRoom: number,
	arrivalsPerPoint = 200_000,
	nowNs: () => number = () => Number(Bun.nanoseconds()),
): RoutingMicrobenchPoint[] {
	// Two passes over the whole ladder, keeping the second. One pass alone lets
	// the first M pay for JIT tiering and reads as a router whose cost *falls*
	// with M, which is a measurement artefact and not a property of anything.
	let points: RoutingMicrobenchPoint[] = [];
	for (let pass = 0; pass < 2; pass += 1) {
		points = measureRouting(
			roomCounts,
			membersPerRoom,
			arrivalsPerPoint,
			nowNs,
		);
	}
	return points;
}

function measureRouting(
	roomCounts: readonly number[],
	membersPerRoom: number,
	arrivalsPerPoint: number,
	nowNs: () => number,
): RoutingMicrobenchPoint[] {
	const points: RoutingMicrobenchPoint[] = [];
	for (const rooms of roomCounts) {
		const table = new RoomTable<number>();
		for (let r = 0; r < rooms; r += 1) {
			for (let m = 0; m < membersPerRoom; m += 1) {
				const handle = r * membersPerRoom + m;
				table.join({ handle, roomId: r, session: handle });
			}
		}
		// The senders: one per room, the member a broadcast room's publisher is.
		const senders = new Int32Array(rooms);
		for (let r = 0; r < rooms; r += 1) senders[r] = r * membersPerRoom;

		let sink = 0;
		const issue = (member: RoomMember<number>): void => {
			sink += member.session;
		};
		// Warm the loop so the first point does not pay for tiering.
		for (let i = 0; i < 20_000; i += 1) {
			forwardTargets(table, senders[i % rooms] ?? 0, issue);
		}
		const startNs = nowNs();
		for (let i = 0; i < arrivalsPerPoint; i += 1) {
			forwardTargets(table, senders[i % rooms] ?? 0, issue);
		}
		const elapsedNs = nowNs() - startNs;
		// Referenced so the walk cannot be eliminated.
		if (sink === Number.MIN_SAFE_INTEGER) throw new Error("unreachable");
		points.push({ rooms, nsPerArrival: elapsedNs / arrivalsPerPoint });
	}
	return points;
}
