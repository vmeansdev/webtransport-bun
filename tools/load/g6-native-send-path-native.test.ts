import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { parseNativeSendPath } from "./g6-native-send-path.ts";

describe("source-built native send-path binding", () => {
	test.each([
		["0", "0"],
		["1", "0"],
		["1", "64"],
	])(
		"owned echo and finalization, diagnostics=%s batch=%s",
		(mode, batch) => {
			const child = spawnSync(
				process.execPath,
				[new URL("./g6-native-send-path-smoke.ts", import.meta.url).pathname],
				{
					cwd: process.cwd(),
					timeout: 20_000,
					maxBuffer: 2 * 1024 * 1024,
					encoding: "utf8",
					env: {
						...process.env,
						WEBTRANSPORT_NATIVE_SEND_PATH_DIAGNOSTICS: mode,
						WEBTRANSPORT_NATIVE_UDP_SEND_BATCH: batch,
						WEBTRANSPORT_NATIVE_UDP_SEND_EAGAIN_MODE: "wait",
						WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN: "1",
					},
				},
			);
			if (child.status !== 0 || child.error || child.signal)
				throw Error(
					`${child.error ?? child.signal ?? child.status}\n${child.stderr}\n${child.stdout}`,
				);
			const raw = JSON.parse(child.stdout.trim());
			expect(raw.schema).toBe("g6-native-send-path-smoke/1");
			const snapshot = parseNativeSendPath(raw.snapshot, {
				enabled: mode === "1",
				finalized: mode === "1",
			});
			if (mode === "1") {
				const reflector = snapshot.components.find(
					(component) => component.kind === "reflector",
				);
				expect(reflector).toBeDefined();
				expect(
					reflector!.phases
						.slice(0, 3)
						.map((bank) => bank.intervals[0]!.histogram.count),
				).toEqual([3, 3, 3]);
				expect(
					reflector!.phases
						.slice(0, 3)
						.map((bank) => bank.intervals[1]!.histogram.count),
				).toEqual([3, 3, 3]);
			}
		},
		25_000,
	);
});
