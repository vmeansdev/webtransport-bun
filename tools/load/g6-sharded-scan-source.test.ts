import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "g6-sharded-scan.ts"), "utf8");

describe("g6 sharded scan source-bound configuration", () => {
	test("uses one resolved connect timeout for the client, watchdog, and artifact", () => {
		expect(source).toContain(
			'const CONNECT_TIMEOUT_SECONDS = parsePositiveIntegerEnv("SCAN_CONNECT_TIMEOUT_SECONDS", 300);',
		);
		expect(source).toContain('connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS');
		expect(source).not.toContain('"--connect-timeout",\n\t\t\t\t\t\tprocess.env.SCAN_CONNECT_TIMEOUT_SECONDS');
	});

	test("collects UDP socket counters only for inodes owned by each shard", () => {
		expect(source).toContain(
			'import { readPerProcessUdpSockets } from "./g6-sharded-diagnostic.ts";',
		);
		expect(source).toContain(
			"perShardUdp[shard.serverId] = readPerProcessUdpSockets(shard.child.pid!);",
		);
		expect(source).not.toContain(
			'const lines = text.split("\\n").filter((l) => l.startsWith("Udp:"));',
		);
	});
});
