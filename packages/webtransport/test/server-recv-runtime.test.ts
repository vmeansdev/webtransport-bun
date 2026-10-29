/**
 * Placement of quinn's endpoint driver. Default `shared` (today's behaviour);
 * `WEBTRANSPORT_NATIVE_SERVER_RECV_RUNTIME=dedicated` moves the socket reader
 * to its own thread, as a campaign-only A/B override.
 *
 * The mode is resolved once per process, so like the worker-count knob the
 * override and refusal cases each spawn their own child. The dedicated child
 * does a real datagram round trip so the test proves the reader works when it
 * lives on the dedicated thread, not merely that the getter echoes the env.
 */

import { describe, expect, it } from "bun:test";
import { __TESTING__, createServer } from "../src/index.js";
import { nextPort } from "./helpers/network.js";
import { fileURLToPath } from "node:url";

const BASE_PORT = 26_600;
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
const server = createServer({
	port,
	tls: { certPem: "", keyPem: "" },
	onSession: (s) => accepted.resolve(s),
});
console.log("recv=" + __TESTING__.serverInternals(server).serverRecvRuntime());
const client = await connectWithRetry("https://127.0.0.1:" + port, {
	tls: { insecureSkipVerify: true },
});
const session = await accepted.promise;
const fromClient = session.incomingDatagrams()[Symbol.asyncIterator]();
await client.sendDatagram(new Uint8Array([7, 7, 7]));
const got = await fromClient.next();
console.log("datagram=" + Array.from(got.value ?? []).join(","));
await fromClient.return?.();
client.close();
await server.close();
`;

async function child(
	value: string | undefined,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const env = { ...process.env };
	if (value === undefined) delete env.WEBTRANSPORT_NATIVE_SERVER_RECV_RUNTIME;
	else env.WEBTRANSPORT_NATIVE_SERVER_RECV_RUNTIME = value;
	const proc = Bun.spawn(["bun", "-e", CHILD], {
		env,
		cwd: fileURLToPath(new URL("../../..", import.meta.url)),
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

describe("server receive runtime", () => {
	it("defaults to shared in a process that set no override", async () => {
		const server = createServer({
			port: nextPort(BASE_PORT, PORT_SPREAD),
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		try {
			expect(__TESTING__.serverInternals(server).serverRecvRuntime()).toBe(
				"shared",
			);
		} finally {
			await server.close();
		}
	});

	it("serves a datagram round trip with the reader on a dedicated thread", async () => {
		const { code, stdout, stderr } = await child("dedicated");
		expect(code).toBe(0);
		expect(stderr).not.toContain("FATAL");
		expect(stderr).not.toContain("panicked");
		expect(stdout).toContain("recv=dedicated");
		expect(stdout).toContain("datagram=7,7,7");
	}, 60_000);

	it("serves the same round trip in shared mode", async () => {
		const { code, stdout } = await child("shared");
		expect(code).toBe(0);
		expect(stdout).toContain("recv=shared");
		expect(stdout).toContain("datagram=7,7,7");
	}, 60_000);

	it("warns once and falls back to shared on an unknown mode", async () => {
		const { code, stdout, stderr } = await child("both");
		expect(code).toBe(0);
		expect(stdout).toContain("recv=shared");
		expect(stdout).toContain("datagram=7,7,7");
		expect(stderr).toContain(
			"webtransport-native: warning: WEBTRANSPORT_NATIVE_SERVER_RECV_RUNTIME must be 'shared' or 'dedicated', got 'both'; ignoring it and using the default (shared)",
		);
		expect(
			stderr.split("WEBTRANSPORT_NATIVE_SERVER_RECV_RUNTIME").length - 1,
		).toBe(1);
	}, 60_000);
});
