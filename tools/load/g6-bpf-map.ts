type BpfMapEntry = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function entries(raw: string): BpfMapEntry[] | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) &&
			parsed.every((entry) => record(entry) !== null)
			? (parsed as BpfMapEntry[])
			: null;
	} catch {
		return null;
	}
}

// `bpftool -j` emits either BTF-decoded numbers (also under `formatted`) or
// raw little-endian octet arrays when BTF association was lost during pinning.
// Accept only those two documented representations.
function decodeBpfInteger(value: unknown): number | null {
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && value >= 0 ? value : null;
	}
	if (!Array.isArray(value)) return null;
	let decoded = 0;
	for (let index = 0; index < value.length; index += 1) {
		const byte = value[index];
		if (typeof byte !== "string" || !/^0x[0-9a-f]{2}$/i.test(byte)) {
			return null;
		}
		decoded += Number.parseInt(byte, 16) * 256 ** index;
		if (!Number.isSafeInteger(decoded)) return null;
	}
	return decoded;
}

function formattedOrRaw(entry: BpfMapEntry, property: string): unknown {
	return record(entry.formatted)?.[property] ?? entry[property];
}

export function sumPerCpuSteerStats(
	raw: string,
): { steered: number; fallback: number } | null {
	let steered = 0;
	let fallback = 0;
	let sawSteered = false;
	let sawFallback = false;
	const dump = entries(raw);
	if (dump === null) return null;
	for (const entry of dump) {
		const key = decodeBpfInteger(formattedOrRaw(entry, "key"));
		const values = formattedOrRaw(entry, "values");
		if ((key !== 0 && key !== 1) || !Array.isArray(values)) return null;
		let total = 0;
		for (const cpuValue of values) {
			const value = decodeBpfInteger(record(cpuValue)?.value);
			if (value === null) return null;
			total += value;
			if (!Number.isSafeInteger(total)) return null;
		}
		if (key === 0) {
			steered += total;
			sawSteered = true;
		} else {
			fallback += total;
			sawFallback = true;
		}
	}
	return sawSteered && sawFallback ? { steered, fallback } : null;
}

export function countBpfMapEntries(raw: string): number | null {
	const dump = entries(raw);
	if (dump === null) return null;
	let populated = 0;
	for (const entry of dump) {
		if (decodeBpfInteger(formattedOrRaw(entry, "key")) === null) return null;
		if (decodeBpfInteger(formattedOrRaw(entry, "value")) !== null) {
			populated += 1;
			continue;
		}
		if (typeof record(entry.value)?.error === "string") continue;
		return null;
	}
	return populated;
}

export type SlotPacketCounts = { shortHeader: number; longHeader: number };

// Decodes a per-CPU `slot_packets` dump: one entry per sockarray slot, whose
// value is `struct slot_packet_counts { __u64 short_header; __u64 long_header; }`
// repeated once per CPU. bpftool renders that value either as a BTF-decoded
// object or, when BTF association was lost during pinning, as the struct's 16
// raw little-endian octets. Both are accepted; anything else refuses.
export function sumPerCpuSlotPackets(
	raw: string,
): Record<number, SlotPacketCounts> | null {
	const dump = entries(raw);
	if (dump === null) return null;
	const slots: Record<number, SlotPacketCounts> = {};
	for (const entry of dump) {
		const key = decodeBpfInteger(formattedOrRaw(entry, "key"));
		const values = formattedOrRaw(entry, "values");
		if (key === null || !Array.isArray(values) || values.length === 0) {
			return null;
		}
		const totals = slots[key] ?? { shortHeader: 0, longHeader: 0 };
		for (const cpuValue of values) {
			const counts = decodeSlotPacketCounts(record(cpuValue)?.value);
			if (counts === null) return null;
			totals.shortHeader += counts.shortHeader;
			totals.longHeader += counts.longHeader;
			if (
				!Number.isSafeInteger(totals.shortHeader) ||
				!Number.isSafeInteger(totals.longHeader)
			) {
				return null;
			}
		}
		slots[key] = totals;
	}
	return slots;
}

function decodeSlotPacketCounts(value: unknown): SlotPacketCounts | null {
	const fields = record(value);
	if (fields !== null) {
		const shortHeader = decodeBpfInteger(fields.short_header);
		const longHeader = decodeBpfInteger(fields.long_header);
		return shortHeader === null || longHeader === null
			? null
			: { shortHeader, longHeader };
	}
	if (!Array.isArray(value) || value.length !== 16) return null;
	const shortHeader = decodeBpfInteger(value.slice(0, 8));
	const longHeader = decodeBpfInteger(value.slice(8, 16));
	return shortHeader === null || longHeader === null
		? null
		: { shortHeader, longHeader };
}

// Inverts a `slot_by_server_id` dump into slot -> server ID. The key is the
// fixed-width `struct server_id_key`, whose first two octets carry the
// big-endian server ID this rig assigns (setup writes `00 <i>` for shard i);
// the value is the little-endian sockarray slot. Duplicate slots refuse rather
// than pick a winner, because a duplicate means the map does not describe a
// one-to-one placement and no per-slot attribution is sound.
function decodeOctet(value: unknown): number | null {
	if (typeof value === "number") {
		return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
	}
	return decodeBpfInteger([value]);
}

export function parseSlotByServerId(
	raw: string,
): Record<number, number> | null {
	const dump = entries(raw);
	if (dump === null) return null;
	const bySlot: Record<number, number> = {};
	for (const entry of dump) {
		const formattedKey = formattedOrRaw(entry, "key");
		// Two renderings, both seen on the rig: the raw key is an array of
		// "0xNN" strings, while the BTF-decoded `formatted.key` is the struct
		// `{ id: [0, 1, 0, ...] }` with plain numbers. Accept both — reading
		// only the raw form silently loses the whole mapping.
		const keyBytes = Array.isArray(formattedKey)
			? formattedKey
			: record(formattedKey)?.id;
		// `struct server_id_key` is exactly SERVER_ID_KEY_LEN (8) octets wide.
		if (!Array.isArray(keyBytes) || keyBytes.length !== 8) return null;
		const high = decodeOctet(keyBytes[0]);
		const low = decodeOctet(keyBytes[1]);
		const slot = decodeBpfInteger(formattedOrRaw(entry, "value"));
		if (high === null || low === null || slot === null) return null;
		if (bySlot[slot] !== undefined) return null;
		bySlot[slot] = high * 256 + low;
	}
	return bySlot;
}

export type SlotPacketDelta = SlotPacketCounts & { slot: number };

// Differences two `slot_packets` snapshots into a per-slot window and labels
// each slot with its server ID when a `slot_by_server_id` mapping is
// available. `from` of null means "since the map was armed", i.e. the `to`
// totals unchanged.
//
// A slot that went backwards refuses the whole window: the counters are
// monotonic within one arm, so a negative delta means the two snapshots
// straddle a re-arm and no delta over them means anything.
export function diffSlotPackets(
	from: Record<number, SlotPacketCounts> | null,
	to: Record<number, SlotPacketCounts> | null,
	slotToServerId: Record<number, number> | null,
): Record<string, SlotPacketDelta> | null {
	if (to === null) return null;
	const out: Record<string, SlotPacketDelta> = {};
	for (const [slotKey, end] of Object.entries(to)) {
		const slot = Number(slotKey);
		const start = from?.[slot] ?? { shortHeader: 0, longHeader: 0 };
		const shortHeader = end.shortHeader - start.shortHeader;
		const longHeader = end.longHeader - start.longHeader;
		if (shortHeader < 0 || longHeader < 0) return null;
		const serverId = slotToServerId?.[slot];
		// No mapping means no server ID to key by; the `slot` field carries the
		// slot either way, so a reader never has to parse the key.
		out[serverId === undefined ? `slot${slot}` : String(serverId)] = {
			slot,
			shortHeader,
			longHeader,
		};
	}
	return out;
}
