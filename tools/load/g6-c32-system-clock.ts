/** Campaign timing only: exact OS samples, never Bun's process-relative epoch. */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

export type SystemClockDomain = {
	schema: "g6-c32-clock-domain/1";
	clock: "CLOCK_MONOTONIC";
	platform: "darwin" | "linux";
	hostId: string;
	bootId: string;
};
export type SystemClockSnapshot = {
	domain: SystemClockDomain;
	nanoseconds: string;
};
type ClockSource = {
	platform: string;
	arch: string;
	hostname(): string;
	bootId(): string;
	timespec(): BigInt64Array;
};
function fail(message: string): never {
	throw Error(`g6-c32-system-clock: ${message}`);
}
function exactObject(
	value: unknown,
	keys: string[],
): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== keys.sort().join()
	)
		fail("malformed clock object");
}
export function validateSystemClockSnapshot(
	value: unknown,
): SystemClockSnapshot {
	exactObject(value, ["domain", "nanoseconds"]);
	const domain = value.domain;
	exactObject(domain, ["schema", "clock", "platform", "hostId", "bootId"]);
	if (
		domain.schema !== "g6-c32-clock-domain/1" ||
		domain.clock !== "CLOCK_MONOTONIC" ||
		(domain.platform !== "darwin" && domain.platform !== "linux")
	)
		fail("invalid clock domain");
	if (
		typeof domain.hostId !== "string" ||
		!domain.hostId.startsWith(`${domain.platform}:`) ||
		!/^[a-z]+:[A-Za-z0-9._-]{1,255}$/.test(domain.hostId)
	)
		fail("invalid host identity");
	if (
		typeof domain.bootId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
			domain.bootId,
		)
	)
		fail("invalid boot identity");
	if (
		typeof value.nanoseconds !== "string" ||
		!/^(0|[1-9][0-9]{0,28})$/.test(value.nanoseconds)
	)
		fail("invalid nanoseconds");
	return {
		domain: { ...domain } as SystemClockDomain,
		nanoseconds: value.nanoseconds,
	};
}
export function decodeTimespec(words: BigInt64Array): bigint {
	const sec = words[0],
		ns = words[1];
	if (
		words.length !== 2 ||
		sec === undefined ||
		ns === undefined ||
		sec < 0n ||
		ns < 0n ||
		ns >= 1_000_000_000n
	)
		fail("invalid timespec");
	return sec * 1_000_000_000n + ns;
}
export function systemClockElapsedNs(
	first: SystemClockSnapshot,
	last: SystemClockSnapshot,
): bigint {
	const a = validateSystemClockSnapshot(first),
		b = validateSystemClockSnapshot(last);
	for (const key of [
		"schema",
		"clock",
		"platform",
		"hostId",
		"bootId",
	] as const)
		if (a.domain[key] !== b.domain[key]) fail(`clock domain mismatch: ${key}`);
	const elapsed = BigInt(b.nanoseconds) - BigInt(a.nanoseconds);
	if (elapsed < 0n) fail("clock regression");
	return elapsed;
}

function osSource(): ClockSource {
	const platform = process.platform,
		arch = process.arch;
	if (
		!["darwin", "linux"].includes(platform) ||
		!["arm64", "x64"].includes(arch)
	)
		fail("unsupported OS/ABI");
	const clockAbi = { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 };
	// Keep this library object captured by both readers for their entire lifetime.
	const library =
		platform === "darwin"
			? dlopen("libSystem.B.dylib", {
					clock_gettime: clockAbi,
					sysctlbyname: {
						args: [
							FFIType.ptr,
							FFIType.ptr,
							FFIType.ptr,
							FFIType.ptr,
							FFIType.u64,
						],
						returns: FFIType.i32,
					},
				})
			: dlopen("libc.so.6", { clock_gettime: clockAbi });
	const words = new BigInt64Array(2);
	return {
		platform,
		arch,
		hostname,
		bootId() {
			if (platform === "linux")
				return readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
					.trim()
					.toLowerCase();
			const name = Buffer.from("kern.bootsessionuuid\0"),
				value = Buffer.alloc(64),
				size = new BigUint64Array([64n]);
			const sysctl =
				"sysctlbyname" in library.symbols
					? library.symbols.sysctlbyname
					: undefined;
			if (
				typeof sysctl !== "function" ||
				sysctl(ptr(name), ptr(value), ptr(size), null, 0n) !== 0
			)
				fail("boot identity unavailable");
			const length = size[0];
			if (
				length === undefined ||
				length < 2n ||
				length > 64n ||
				value[Number(length) - 1] !== 0
			)
				fail("malformed boot identity");
			return value
				.subarray(0, Number(length) - 1)
				.toString("utf8")
				.toLowerCase();
		},
		timespec() {
			if (
				library.symbols.clock_gettime(
					platform === "darwin" ? 6 : 1,
					ptr(words),
				) !== 0
			)
				fail("clock_gettime failed");
			return words;
		},
	};
}

export function createSystemClockReader(
	source: ClockSource = osSource(),
): () => SystemClockSnapshot {
	if (
		!["darwin", "linux"].includes(source.platform) ||
		!["arm64", "x64"].includes(source.arch)
	)
		fail("unsupported OS/ABI");
	return () => {
		const host = source.hostname(),
			boot = source.bootId();
		const nanoseconds = String(decodeTimespec(source.timespec()));
		if (host !== source.hostname() || boot !== source.bootId())
			fail("identity changed during sample");
		return validateSystemClockSnapshot({
			domain: {
				schema: "g6-c32-clock-domain/1",
				clock: "CLOCK_MONOTONIC",
				platform: source.platform,
				hostId: `${source.platform}:${host}`,
				bootId: boot,
			},
			nanoseconds,
		});
	};
}
let reader: (() => SystemClockSnapshot) | undefined;
export function readSystemClock(): SystemClockSnapshot {
	reader ??= createSystemClockReader();
	return reader();
}
