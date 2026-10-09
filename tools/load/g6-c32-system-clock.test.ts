import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as clock from "./g6-c32-system-clock.ts";

// Legacy process.hrtime failed this assertion with a negative ~400ms delta.
const sampleExpression = `(await import(${JSON.stringify(`${import.meta.dir}/g6-c32-system-clock.ts`)})).readSystemClock()`;

const domain = {
	schema: "g6-c32-clock-domain/1",
	clock: "CLOCK_MONOTONIC",
	platform: "darwin",
	hostId: "darwin:test-host",
	bootId: "11111111-2222-3333-4444-555555555555",
} as const;

test("integer timespec decoding preserves nanoseconds beyond Number precision", async () => {
	expect(
		clock.decodeTimespec(new BigInt64Array([123456789n, 987654321n])),
	).toBe(123456789987654321n);
	for (const words of [[-1n, 0n], [1n, -1n], [1n, 1000000000n], [1n]])
		expect(() => clock.decodeTimespec(new BigInt64Array(words))).toThrow(
			"timespec",
		);
});

test("snapshot validation rejects malformed domains and decimal samples", async () => {
	const valid = { domain, nanoseconds: "123456789987654321" };
	expect(clock.validateSystemClockSnapshot(valid)).toEqual(valid);
	for (const nanoseconds of ["-1", "01", "1.2", "1e9", 123, ""])
		expect(() =>
			clock.validateSystemClockSnapshot({ ...valid, nanoseconds }),
		).toThrow();
	for (const invalid of [
		{ ...domain, bootId: "" },
		{ ...domain, platform: "win32" },
		...[["darwin"], { toString: () => "darwin" }, null, 1, true].map(
			(platform) => ({ ...domain, platform }),
		),
		{ ...domain, clock: "hrtime" },
		{ ...domain, hostId: "" },
		{ ...domain, extra: true },
	])
		expect(() =>
			clock.validateSystemClockSnapshot({ ...valid, domain: invalid }),
		).toThrow();
});

test("elapsed subtraction requires matching clock host and boot and no regression", async () => {
	const first = { domain, nanoseconds: "100" },
		last = { domain, nanoseconds: "150" };
	expect(clock.systemClockElapsedNs(first, last)).toBe(50n);
	for (const changed of [
		{ ...domain, hostId: "darwin:other" },
		{ ...domain, bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
		{ ...domain, platform: "linux" as const, hostId: "linux:test-host" },
	])
		expect(() =>
			clock.systemClockElapsedNs(first, { ...last, domain: changed }),
		).toThrow("domain");
	expect(() => clock.systemClockElapsedNs(last, first)).toThrow("regression");
});

test("reader refuses unsupported ABI, clock errors, and boot changes during sampling", async () => {
	const source = {
		platform: "darwin",
		arch: "arm64",
		hostname: () => "test-host",
		bootId: () => domain.bootId,
		timespec: () => new BigInt64Array([1n, 2n]),
	};
	expect(clock.createSystemClockReader(source)()).toEqual({
		domain,
		nanoseconds: "1000000002",
	});
	expect(() =>
		clock.createSystemClockReader({ ...source, platform: "win32" }),
	).toThrow();
	expect(() =>
		clock.createSystemClockReader({ ...source, arch: "ia32" }),
	).toThrow();
	expect(() =>
		clock.createSystemClockReader({
			...source,
			timespec: () => {
				throw Error("clock unavailable");
			},
		})(),
	).toThrow("clock unavailable");
	let reads = 0;
	expect(() =>
		clock.createSystemClockReader({
			...source,
			bootId: () =>
				++reads === 1 ? domain.bootId : "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		})(),
	).toThrow("identity changed");
});

function childSample(ageMs: number) {
	const result = spawnSync(
		process.execPath,
		[
			"-e",
			`await Bun.sleep(${ageMs}); console.log(JSON.stringify(${sampleExpression}));`,
		],
		{
			encoding: "utf8",
			timeout: 3000,
		},
	);
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	return clock.validateSystemClockSnapshot(JSON.parse(result.stdout));
}

test("different-age Bun processes measure actual elapsed time in one shared epoch", async () => {
	const first = childSample(400);
	const observedStart = performance.now();
	await Bun.sleep(350);
	const second = childSample(0);
	const observedMs = performance.now() - observedStart;
	const elapsedMs = Number(clock.systemClockElapsedNs(first, second)) / 1e6;
	expect(elapsedMs).toBeGreaterThanOrEqual(300);
	expect(Math.abs(elapsedMs - observedMs)).toBeLessThan(150);
}, 8000);
