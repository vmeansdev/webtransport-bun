import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePayloadSoakConfig } from "./payload-ownership-soak.ts";

describe("payload ownership soak", () => {
	it("parses a bounded deterministic workload", () => {
		const config = parsePayloadSoakConfig({
			PAYLOAD_SOAK_PACKAGE_ROOT: "/tmp/paired-package",
			PAYLOAD_SOAK_DURATION_SECONDS: "12",
			PAYLOAD_SOAK_TIMEOUT_MS: "1500",
			PAYLOAD_SOAK_SAMPLE_MS: "250",
			PAYLOAD_SOAK_STREAM_EVERY: "50",
			PAYLOAD_SOAK_DATAGRAMS_PER_SECOND: "800",
		});
		expect(config.packageRoot).toBe("/tmp/paired-package");
		expect(config.durationMs).toBe(12_000);
		expect(config.operationTimeoutMs).toBe(1500);
		expect(config.sampleMs).toBe(250);
		expect(config.streamEvery).toBe(50);
		expect(config.datagramsPerSecond).toBe(800);
	});

	it("rejects missing package roots and unbounded timing", () => {
		expect(() => parsePayloadSoakConfig({})).toThrow(
			"PAYLOAD_SOAK_PACKAGE_ROOT is required",
		);
		expect(() =>
			parsePayloadSoakConfig({
				PAYLOAD_SOAK_PACKAGE_ROOT: "/tmp/package",
				PAYLOAD_SOAK_TIMEOUT_MS: "0",
			}),
		).toThrow("PAYLOAD_SOAK_TIMEOUT_MS");
		expect(() =>
			parsePayloadSoakConfig({
				PAYLOAD_SOAK_PACKAGE_ROOT: "/tmp/package",
				PAYLOAD_SOAK_DURATION_SECONDS: "21601",
			}),
		).toThrow("6 hour bound");
	});

	it("contains no explicit GC or allocator relief escape hatch", () => {
		const implementation = readFileSync(
			join(import.meta.dir, "payload-ownership-soak.ts"),
			"utf8",
		);
		const forbidden = ["Bun" + ".gc", "releaseNative" + "Memory"];
		for (const symbol of forbidden)
			expect(implementation).not.toContain(symbol);
		expect(implementation).toContain("withTimeout");
	});
});
