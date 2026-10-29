/**
 * The `egressPacer` createServer option: the supported way to turn the
 * (experimental) egress pacer on, with `WEBTRANSPORT_PACER_PPS` kept as a
 * fallback. The pacer is process-wide and resolved once, so every case that
 * turns it on runs in its own child process.
 */

import { describe, expect, it } from "bun:test";
import { createServer, E_INVALID_ARGUMENT } from "../src/index.js";
import { nextPort } from "./helpers/network.js";
import { fileURLToPath } from "node:url";

const BASE_PORT = 27_400;
const PORT_SPREAD = 60;

const CHILD = `
const { __TESTING__, createServer } = await import(${JSON.stringify(
	new URL("../src/index.ts", import.meta.url).href,
)});
const { connectWithRetry } = await import(${JSON.stringify(
	new URL("./helpers/network.ts", import.meta.url).href,
)});
const port = ${nextPort(BASE_PORT, PORT_SPREAD)};
const accepted = Promise.withResolvers();
const pacer = JSON.parse(process.env.CHILD_PACER ?? "null");
const failFirst = JSON.parse(process.env.CHILD_FAIL_FIRST ?? "null");
if (failFirst) {
	// A first createServer that fails at bind (the port is taken) must not
	// consume the process-wide pacer configuration it asked for.
	const blocker = createServer({ port: port + 1, tls: { certPem: "", keyPem: "" }, onSession: () => {} });
	try {
		createServer({ port: port + 1, tls: { certPem: "", keyPem: "" }, egressPacer: failFirst, onSession: () => {} });
		console.log("firstFail=none");
	} catch (error) {
		console.log("firstFail=" + error.message.split(":")[0]);
	}
	await blocker.close();
}
const server = createServer({
	port,
	tls: { certPem: "", keyPem: "" },
	...(pacer ? { egressPacer: pacer } : {}),
	onSession: (s) => accepted.resolve(s),
});
const client = await connectWithRetry("https://127.0.0.1:" + port, {
	tls: { insecureSkipVerify: true },
});
const session = await accepted.promise;
const fromServer = client.incomingDatagrams()[Symbol.asyncIterator]();
try {
	const admission = server.sendDatagramMirrorPaced([session.id], new Uint8Array([7, 7]));
	console.log("admitted=" + admission.admitted);
	const got = await Promise.race([
		fromServer.next(),
		Bun.sleep(5_000).then(() => ({ value: undefined })),
	]);
	console.log("delivered=" + Array.from(got.value ?? []).join(","));
	const stats = JSON.parse(__TESTING__.serverInternals(server).__pacerStatsJson?.() ?? "{}");
	console.log("pacer=" + stats.pps + "/" + stats.clump + "/" + stats.queueMs);
} catch (error) {
	console.log("pacedError=" + error.code + " " + error.message);
}
for (const second of JSON.parse(process.env.CHILD_SECOND ?? "[]")) {
	try {
		const other = createServer({
			port: 0,
			tls: { certPem: "", keyPem: "" },
			egressPacer: second,
			onSession: () => {},
		});
		console.log("second=ok");
		await other.close();
	} catch (error) {
		console.log("second=" + error.message);
	}
}
await fromServer.return?.();
client.close();
await server.close();
`;

async function child(
	pacer: unknown,
	env: Record<string, string | undefined> = {},
	second: unknown[] = [],
	failFirst: unknown = null,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const merged: Record<string, string | undefined> = { ...process.env };
	delete merged.WEBTRANSPORT_PACER_PPS;
	delete merged.WEBTRANSPORT_PACER_CLUMP;
	delete merged.WEBTRANSPORT_PACER_QUEUE_MS;
	Object.assign(merged, env, {
		CHILD_PACER: JSON.stringify(pacer),
		CHILD_SECOND: JSON.stringify(second),
		CHILD_FAIL_FIRST: JSON.stringify(failFirst),
	});
	const proc = Bun.spawn(["bun", "-e", CHILD], {
		env: merged,
		cwd: fileURLToPath(new URL("../../..", import.meta.url)),
		stdout: "pipe",
		stderr: "pipe",
	});
	const timeout = setTimeout(() => {
		if (proc.exitCode === null) proc.kill("SIGKILL");
	}, 20_000);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	} finally {
		clearTimeout(timeout);
	}
}

describe("egressPacer option", () => {
	it("turns the pacer on without the environment variable", async () => {
		const { code, stdout } = await child({ pps: 30_000, clump: 16 });
		expect(code).toBe(0);
		expect(stdout).toContain("admitted=1");
		expect(stdout).toContain("delivered=7,7");
		expect(stdout).toContain("pacer=30000/16/250");
		expect(stdout).not.toContain("pacedError=");
	}, 30_000);

	it("is the one process-wide configuration: same is fine, different is refused", async () => {
		const { code, stdout } = await child({ pps: 30_000 }, {}, [
			{ pps: 30_000 },
			{ pps: 60_000 },
		]);
		expect(code).toBe(0);
		expect(stdout).toContain("admitted=1");
		const seconds = stdout
			.split("\n")
			.filter((line) => line.startsWith("second="));
		expect(seconds[0]).toBe("second=ok");
		expect(seconds[1]).toStartWith(`second=${E_INVALID_ARGUMENT}: egressPacer`);
		expect(seconds[1]).toContain(
			"conflicts with the process-wide egress pacer",
		);
	}, 30_000);

	it("wins over the environment when it arrives first", async () => {
		const { stdout } = await child(
			{ pps: 30_000 },
			{ WEBTRANSPORT_PACER_PPS: "60000" },
			[{ pps: 30_000 }],
		);
		expect(stdout).toContain("admitted=1");
		expect(stdout).toContain("pacer=30000/32/250");
		expect(stdout).toContain("second=ok");
	}, 30_000);

	it("keeps WEBTRANSPORT_PACER_PPS as the fallback when no server passes it", async () => {
		const { stdout } = await child(null, {
			WEBTRANSPORT_PACER_PPS: "30000",
			WEBTRANSPORT_PACER_CLUMP: "8",
		});
		expect(stdout).toContain("admitted=1");
		expect(stdout).toContain("pacer=30000/8/250");
		expect(stdout).toContain("delivered=7,7");
	}, 30_000);

	it("leaves the pacer off with neither, and says how to turn it on", async () => {
		const { stdout } = await child(null);
		expect(stdout).toContain("pacedError=E_UNSUPPORTED_ARGUMENT");
		expect(stdout).toContain("egressPacer");
	}, 30_000);

	it("a failed first createServer does not consume the configuration", async () => {
		const { code, stdout } = await child({ pps: 60_000 }, {}, [], {
			pps: 30_000,
		});
		expect(code).toBe(0);
		expect(stdout).toContain("firstFail=E_INTERNAL");
		expect(stdout).toContain("admitted=1");
		expect(stdout).toContain("pacer=60000/32/250");
	}, 30_000);

	it("warns once and turns the pacer off on a malformed WEBTRANSPORT_PACER_PPS", async () => {
		const { code, stdout, stderr } = await child(null, {
			WEBTRANSPORT_PACER_PPS: "30000pps",
		});
		expect(code).toBe(0);
		expect(stdout).toContain("pacedError=E_UNSUPPORTED_ARGUMENT");
		expect(stderr).toContain(
			"webtransport-native: warning: WEBTRANSPORT_PACER_PPS must be an integer 0..=1000000, got '30000pps'; ignoring it and using the default (0, pacer off)",
		);
		expect(stderr.split("WEBTRANSPORT_PACER_PPS").length - 1).toBe(1);
	}, 30_000);

	it("warns and falls back to the defaults on a malformed clump or window", async () => {
		const { stdout, stderr } = await child(null, {
			WEBTRANSPORT_PACER_PPS: "30000",
			WEBTRANSPORT_PACER_CLUMP: "abc",
			WEBTRANSPORT_PACER_QUEUE_MS: "999999",
		});
		expect(stdout).toContain("admitted=1");
		expect(stdout).toContain("pacer=30000/32/250");
		expect(stderr).toContain(
			"WEBTRANSPORT_PACER_CLUMP must be an integer 1..=64, got 'abc'; ignoring it and using the default (32)",
		);
		expect(stderr).toContain(
			"WEBTRANSPORT_PACER_QUEUE_MS must be an integer 1..=5000, got '999999'; ignoring it and using the default (250)",
		);
	}, 30_000);

	it("rejects a malformed option before touching the addon", () => {
		for (const bad of [
			{ pps: 1_000_001 },
			{ pps: Number.MAX_SAFE_INTEGER, queueMs: Number.MAX_SAFE_INTEGER },
			{ pps: 1000, queueMs: 5001 },
			{ pps: 0 },
			{ pps: 1.5 },
			{ pps: 1000, clump: 65 },
			{ pps: 1000, clump: 0 },
			{ pps: 1000, queueMs: 0 },
			"30000",
		]) {
			expect(() =>
				createServer({
					port: 0,
					tls: { certPem: "", keyPem: "" },
					egressPacer: bad as never,
					onSession: () => {},
				}),
			).toThrow(/^E_INVALID_ARGUMENT: egressPacer/);
		}
	});
});
