/**
 * The server runtime's Tokio worker count. Default 2 — every measured
 * alternative was worse — with `WEBTRANSPORT_NATIVE_SERVER_WORKERS` as a
 * campaign-only A/B override.
 *
 * The runtime is a process-global `Lazy`, so the override can only be proven
 * from a fresh process: the in-process case pins the default, and the override
 * and refusal cases each spawn their own child.
 */

import { describe, expect, it } from "bun:test";
import { __TESTING__, createServer } from "../src/index.js";
import { nextPort } from "./helpers/network.js";

const BASE_PORT = 26_400;
const PORT_SPREAD = 60;

const CHILD = `
const { __TESTING__, createServer } = await import(${JSON.stringify(
	new URL("../src/index.ts", import.meta.url).href,
)});
const server = createServer({
	port: 0,
	tls: { certPem: "", keyPem: "" },
	onSession: () => {},
});
console.log("workers=" + __TESTING__.serverInternals(server).serverWorkerThreads());
await server.close();
`;

async function childWorkers(
	value: string | undefined,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const env = { ...process.env };
	if (value === undefined) delete env.WEBTRANSPORT_NATIVE_SERVER_WORKERS;
	else env.WEBTRANSPORT_NATIVE_SERVER_WORKERS = value;
	const proc = Bun.spawn(["bun", "-e", CHILD], {
		env,
		cwd: new URL("../../..", import.meta.url).pathname,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

describe("server worker threads", () => {
	it("defaults to 2 in a process that set no override", async () => {
		const server = createServer({
			port: nextPort(BASE_PORT, PORT_SPREAD),
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		try {
			expect(__TESTING__.serverInternals(server).serverWorkerThreads()).toBe(2);
		} finally {
			await server.close();
		}
	});

	it("reports 3 when the override asked for 3", async () => {
		const { code, stdout, stderr } = await childWorkers("3");
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
		expect(stdout).toContain("workers=3");
	}, 60_000);

	it("reports the default when the override is unset", async () => {
		const { code, stdout } = await childWorkers(undefined);
		expect(code).toBe(0);
		expect(stdout).toContain("workers=2");
	}, 60_000);

	// An unsupported internal knob must never take the process down: an
	// invalid value warns once and falls back to the default, not a clamp.
	it("warns once and falls back to 2 on an out-of-range override", async () => {
		const { code, stdout, stderr } = await childWorkers("9");
		expect(code).toBe(0);
		expect(stdout).toContain("workers=2");
		expect(stderr).toContain(
			"webtransport-native: warning: WEBTRANSPORT_NATIVE_SERVER_WORKERS must be an integer 1..=8, got '9'; ignoring it and using the default (2)",
		);
		expect(stderr.split("WEBTRANSPORT_NATIVE_SERVER_WORKERS").length - 1).toBe(
			1,
		);
	}, 60_000);

	it("warns and falls back to 2 on a non-numeric override", async () => {
		const { code, stdout, stderr } = await childWorkers("abc");
		expect(code).toBe(0);
		expect(stdout).toContain("workers=2");
		expect(stderr).toContain(
			"webtransport-native: warning: WEBTRANSPORT_NATIVE_SERVER_WORKERS must be an integer 1..=8, got 'abc'; ignoring it and using the default (2)",
		);
	}, 60_000);
});
