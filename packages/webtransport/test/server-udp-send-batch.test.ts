/**
 * Cross-connection UDP send batching. Default 0 (off: one sendmsg per
 * transmit, today's behaviour); `WEBTRANSPORT_NATIVE_UDP_SEND_BATCH=N` routes
 * every transmit through a flusher thread per socket that drains up to N per
 * sendmmsg (Linux) or one at a time (elsewhere), as a campaign-only A/B
 * override.
 *
 * The size is resolved once per process, so like the other knobs the
 * override and refusal cases each spawn their own child. The batched child
 * does a real datagram round trip in both directions so the test proves the
 * connection still works through the flusher, not merely that the getter
 * echoes the env, and it reads the batch counters back from the snapshot.
 */

import { describe, expect, it } from "bun:test";
import { createServer } from "../src/index.js";
import { nextPort } from "./helpers/network.js";

const BASE_PORT = 26_800;
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
console.log("udpSendBatch=" + server.serverUdpSendBatch());
const client = await connectWithRetry("https://127.0.0.1:" + port, {
	tls: { insecureSkipVerify: true },
});
const session = await accepted.promise;
const fromClient = session.incomingDatagrams()[Symbol.asyncIterator]();
const fromServer = client.incomingDatagrams()[Symbol.asyncIterator]();
await client.sendDatagram(new Uint8Array([9, 9, 9]));
const got = await fromClient.next();
console.log("datagram=" + Array.from(got.value ?? []).join(","));
for (let i = 0; i < 50; i += 1) await session.sendDatagram(new Uint8Array([i]));
let seen = 0;
for (let i = 0; i < 50; i += 1) {
	const back = await fromServer.next();
	if (back.value && back.value[0] === i) seen += 1;
}
console.log("downstream=" + seen);
const m = server.metricsSnapshot();
console.log("batchCalls=" + (m.udpSendBatchCalls ?? -1) + " batchMessages=" + (m.udpSendBatchMessages ?? -1) + " batchFallback=" + (m.udpSendBatchFallback ?? -1) + " batchBlocked=" + (m.udpSendBatchBlocked ?? -1) + " batchDropped=" + (m.udpSendBatchDropped ?? -1) + " batchErrors=" + (m.udpSendBatchErrors ?? -1));
await fromClient.return?.();
await fromServer.return?.();
client.close();
await server.close();
`;

async function child(
	value: string | undefined,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const env = { ...process.env };
	if (value === undefined) delete env.WEBTRANSPORT_NATIVE_UDP_SEND_BATCH;
	else env.WEBTRANSPORT_NATIVE_UDP_SEND_BATCH = value;
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

function counters(stdout: string): Record<string, number> {
	const line = stdout.split("\n").find((l) => l.startsWith("batchCalls="));
	if (!line) throw new Error(`no batch counters in ${stdout}`);
	return Object.fromEntries(
		line.split(" ").map((pair) => {
			const [key, value] = pair.split("=");
			return [key, Number(value)];
		}),
	);
}

describe("server udp send batch", () => {
	it("defaults to 0 in a process that set no override", async () => {
		const server = createServer({
			port: nextPort(BASE_PORT, PORT_SPREAD),
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		try {
			expect(server.serverUdpSendBatch()).toBe(0);
		} finally {
			await server.close();
		}
	});

	it("serves round trips in both directions through the batched socket", async () => {
		const { code, stdout, stderr } = await child("64");
		expect(code).toBe(0);
		expect(stderr).not.toContain("FATAL");
		expect(stderr).not.toContain("panicked");
		expect(stdout).toContain("udpSendBatch=64");
		expect(stdout).toContain("datagram=9,9,9");
		expect(stdout).toContain("downstream=50");
		const c = counters(stdout);
		// Every server transmit went through the flusher: batched on Linux,
		// one at a time elsewhere. Nothing dropped, nothing errored.
		expect((c.batchMessages ?? 0) + (c.batchFallback ?? 0)).toBeGreaterThan(0);
		expect(c.batchDropped).toBe(0);
		expect(c.batchErrors).toBe(0);
		if (process.platform === "linux") {
			expect(c.batchCalls).toBeGreaterThan(0);
		}
	}, 60_000);

	it("leaves the socket untouched at 0 and reports zero batch activity", async () => {
		const { code, stdout } = await child("0");
		expect(code).toBe(0);
		expect(stdout).toContain("udpSendBatch=0");
		expect(stdout).toContain("downstream=50");
		const c = counters(stdout);
		expect(c.batchCalls).toBe(0);
		expect(c.batchMessages).toBe(0);
		expect(c.batchFallback).toBe(0);
	}, 60_000);

	it("fails closed on an out-of-range size rather than falling back", async () => {
		const { code, stderr } = await child("1");
		expect(code).not.toBe(0);
		expect(stderr).toContain(
			"FATAL E_INTERNAL: WEBTRANSPORT_NATIVE_UDP_SEND_BATCH must be 0 or 2..=1024, got '1'",
		);
	}, 60_000);
});
