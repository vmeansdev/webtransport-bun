/**
 * Native UDP socket send-buffer knob for server startup. Default 0 keeps the
 * upstream bind path untouched; a nonzero request is resolved once per process
 * and must either start with that requested knob attested or fail closed with
 * explicit OS-limit diagnostics.
 */

import { describe, expect, it } from "bun:test";
import { createServer } from "../src/index.js";
import { nextPort } from "./helpers/network.js";

const BASE_PORT = 26_900;
const PORT_SPREAD = 60;
const REQUESTED = "26214400";

const CHILD = `
const { createServer } = await import(${JSON.stringify(
	new URL("../src/index.ts", import.meta.url).href,
)});
const server = createServer({
	port: 0,
	tls: { certPem: "", keyPem: "" },
	onSession: () => {},
});
console.log("serverUdpSendBufferBytes=" + server.serverUdpSendBufferBytes());
await server.close();
`;

async function child(
	value: string | undefined,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const env = { ...process.env };
	if (value === undefined)
		delete env.WEBTRANSPORT_NATIVE_SERVER_UDP_SNDBUF_BYTES;
	else env.WEBTRANSPORT_NATIVE_SERVER_UDP_SNDBUF_BYTES = value;
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

describe("server udp send buffer", () => {
	it("defaults to 0 in a process that set no override", async () => {
		const server = createServer({
			port: nextPort(BASE_PORT, PORT_SPREAD),
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		try {
			expect(server.serverUdpSendBufferBytes()).toBe(0);
		} finally {
			await server.close();
		}
	});

	it("treats an explicit zero as the untouched default path", async () => {
		const { code, stdout, stderr } = await child("0");
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
		expect(stdout).toContain("serverUdpSendBufferBytes=0");
	}, 60_000);

	it("fails closed on an invalid override", async () => {
		const { code, stderr } = await child("65535");
		expect(code).not.toBe(0);
		expect(stderr).toContain(
			"E_INTERNAL: server startup failed: WEBTRANSPORT_NATIVE_SERVER_UDP_SNDBUF_BYTES",
		);
		expect(stderr).toContain("'65535'");
	}, 60_000);

	it("either starts with the requested knob or fails explicitly on an OS send-buffer cap", async () => {
		const { code, stdout, stderr } = await child(REQUESTED);
		if (code === 0) {
			expect(stderr).toBe("");
			expect(stdout).toContain(`serverUdpSendBufferBytes=${REQUESTED}`);
			return;
		}
		expect(stderr).toContain("E_INTERNAL: server startup failed:");
		expect(stderr).toContain("effective UDP send buffer size");
		expect(stderr).toContain(REQUESTED);
	}, 60_000);
});
