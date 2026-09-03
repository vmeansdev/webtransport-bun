/**
 * Server-side ACK cadence requested of the client. Default `default`
 * (today's behaviour, quinn's stock cadence); `WEBTRANSPORT_NATIVE_ACK_CADENCE=relaxed`
 * widens `max_ack_delay` to 100 ms and requests ACK_FREQUENCY (threshold 10,
 * 100 ms), as a campaign-only A/B override.
 *
 * The mode is resolved once per process, so like the recv-runtime knob the
 * override and refusal cases each spawn their own child. The relaxed child
 * does a real datagram round trip so the test proves the connection still
 * works under the relaxed cadence, not merely that the getter echoes the env.
 */

import { describe, expect, it } from "bun:test";
import { createServer } from "../src/index.js";
import { nextPort } from "./helpers/network.js";

const BASE_PORT = 26_700;
const PORT_SPREAD = 60;

const CHILD = `
const { createServer } = await import(${JSON.stringify(
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
console.log("ackCadence=" + server.serverAckCadence());
const client = await connectWithRetry("https://127.0.0.1:" + port, {
	tls: { insecureSkipVerify: true },
});
const session = await accepted.promise;
const fromClient = session.incomingDatagrams()[Symbol.asyncIterator]();
await client.sendDatagram(new Uint8Array([9, 9, 9]));
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
	if (value === undefined) delete env.WEBTRANSPORT_NATIVE_ACK_CADENCE;
	else env.WEBTRANSPORT_NATIVE_ACK_CADENCE = value;
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

describe("server ack cadence", () => {
	it("defaults to default in a process that set no override", async () => {
		const server = createServer({
			port: nextPort(BASE_PORT, PORT_SPREAD),
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		try {
			expect(server.serverAckCadence()).toBe("default");
		} finally {
			await server.close();
		}
	});

	it("serves a datagram round trip under the relaxed cadence", async () => {
		const { code, stdout, stderr } = await child("relaxed");
		expect(code).toBe(0);
		expect(stderr).not.toContain("FATAL");
		expect(stderr).not.toContain("panicked");
		expect(stdout).toContain("ackCadence=relaxed");
		expect(stdout).toContain("datagram=9,9,9");
	}, 60_000);

	it("serves the same round trip in default mode", async () => {
		const { code, stdout } = await child("default");
		expect(code).toBe(0);
		expect(stdout).toContain("ackCadence=default");
		expect(stdout).toContain("datagram=9,9,9");
	}, 60_000);

	it("fails closed on an unknown mode rather than falling back", async () => {
		const { code, stderr } = await child("both");
		expect(code).not.toBe(0);
		expect(stderr).toContain(
			"FATAL E_INTERNAL: WEBTRANSPORT_NATIVE_ACK_CADENCE must be 'default' or 'relaxed', got 'both'",
		);
	}, 60_000);
});
