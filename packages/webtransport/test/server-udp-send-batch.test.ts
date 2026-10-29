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
import { __TESTING__, createServer } from "../src/index.js";
import { nextPort } from "./helpers/network.js";
import { fileURLToPath } from "node:url";

const BASE_PORT = 26_800;
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
console.log("udpSendBatch=" + __TESTING__.serverInternals(server).serverUdpSendBatch());
console.log("udpSendEagainMode=" + __TESTING__.serverInternals(server).serverUdpSendEagainMode());
console.log("reflectRingBypass=" + __TESTING__.serverInternals(server).serverReflectRingBypass());
const client = await connectWithRetry("https://127.0.0.1:" + port, {
	tls: { insecureSkipVerify: true },
});
const session = await accepted.promise;
const fromClient = session.incomingDatagrams()[Symbol.asyncIterator]();
const fromServer = client.incomingDatagrams()[Symbol.asyncIterator]();
const nextWithin = (iterator, label) => Promise.race([
	iterator.next(),
	Bun.sleep(5_000).then(() => { throw new Error(label + " timed out"); }),
]);
await client.sendDatagram(new Uint8Array([9, 9, 9]));
const got = await nextWithin(fromClient, "client datagram");
console.log("datagram=" + Array.from(got.value ?? []).join(","));
for (let i = 0; i < 50; i += 1) await session.sendDatagram(new Uint8Array([i]));
let seen = 0;
for (let i = 0; i < 50; i += 1) {
	const back = await nextWithin(fromServer, "server datagram");
	if (back.value && back.value[0] === i) seen += 1;
}
console.log("downstream=" + seen);
const m = __TESTING__.serverInternals(server).metricsSnapshot();
console.log("batchCalls=" + (m.udpSendBatchCalls ?? -1) + " batchMessages=" + (m.udpSendBatchMessages ?? -1) + " batchFallback=" + (m.udpSendBatchFallback ?? -1) + " batchBlocked=" + (m.udpSendBatchBlocked ?? -1) + " batchDropped=" + (m.udpSendBatchDropped ?? -1) + " batchCongestionDropped=" + (m.udpSendBatchCongestionDropped ?? -1) + " batchErrors=" + (m.udpSendBatchErrors ?? -1));
await fromClient.return?.();
await fromServer.return?.();
client.close();
await server.close();
`;

const STARTUP_REFUSAL_CHILD = `
const { __TESTING__, createServer } = await import(${JSON.stringify(
	new URL("../src/index.ts", import.meta.url).href,
)});
let server;
try {
	server = createServer({ port: 0, tls: { certPem: "", keyPem: "" }, onSession: () => {} });
	console.log("unexpected startup success");
} catch (error) {
	console.log("startupError=" + error.message);
	console.log("continuedAfterRefusal=true");
}
await server?.close();
`;

async function child(
	value: string | undefined,
	eagainMode?: string,
	reflectRingBypass?: string,
	source = CHILD,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const env = { ...process.env };
	if (value === undefined) delete env.WEBTRANSPORT_NATIVE_UDP_SEND_BATCH;
	else env.WEBTRANSPORT_NATIVE_UDP_SEND_BATCH = value;
	if (eagainMode === undefined)
		delete env.WEBTRANSPORT_NATIVE_UDP_SEND_EAGAIN_MODE;
	else env.WEBTRANSPORT_NATIVE_UDP_SEND_EAGAIN_MODE = eagainMode;
	if (reflectRingBypass === undefined)
		delete env.WEBTRANSPORT_NATIVE_REFLECT_RING_BYPASS;
	else env.WEBTRANSPORT_NATIVE_REFLECT_RING_BYPASS = reflectRingBypass;
	const proc = Bun.spawn(["bun", "-e", source], {
		env,
		cwd: fileURLToPath(new URL("../../..", import.meta.url)),
		stdout: "pipe",
		stderr: "pipe",
	});
	// These literal fixtures create no subprocesses; killing this owned child
	// closes both output pipes even if native startup or shutdown stalls.
	const timeout = setTimeout(() => {
		if (proc.exitCode === null) proc.kill("SIGKILL");
	}, 15_000);
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
			expect(__TESTING__.serverInternals(server).serverUdpSendBatch()).toBe(0);
			expect(
				__TESTING__.serverInternals(server).serverUdpSendEagainMode(),
			).toBe("wait");
			expect(
				__TESTING__.serverInternals(server).serverReflectRingBypass(),
			).toBe("off");
		} finally {
			await server.close();
		}
	});

	it("resolves the reflector ring bypass and rejects malformed values", async () => {
		const accepted = await child("64", "wait", "1");
		expect(accepted.code).toBe(0);
		expect(accepted.stdout).toContain("reflectRingBypass=on");

		// Malformed: one warning, then the default (off); the process lives.
		const rejected = await child("64", "wait", "true");
		expect(rejected.code).toBe(0);
		expect(rejected.stdout).toContain("reflectRingBypass=off");
		expect(rejected.stderr).toContain(
			"webtransport-native: warning: WEBTRANSPORT_NATIVE_REFLECT_RING_BYPASS must be 0 or 1, got 'true'; ignoring it and using the default (0)",
		);
	}, 60_000);

	it("serves round trips in both directions through the batched socket", async () => {
		const { code, stdout, stderr } = await child("64");
		expect(code).toBe(0);
		expect(stderr).not.toContain("FATAL");
		expect(stderr).not.toContain("panicked");
		expect(stdout).toContain("udpSendBatch=64");
		expect(stdout).toContain("udpSendEagainMode=wait");
		expect(stdout).toContain("datagram=9,9,9");
		expect(stdout).toContain("downstream=50");
		const c = counters(stdout);
		// Every server transmit went through the flusher: batched on Linux,
		// one at a time elsewhere. Nothing dropped, nothing errored.
		expect((c.batchMessages ?? 0) + (c.batchFallback ?? 0)).toBeGreaterThan(0);
		expect(c.batchDropped).toBe(0);
		expect(c.batchCongestionDropped).toBe(0);
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

	it("warns once and falls back to off on an out-of-range size", async () => {
		const { code, stdout, stderr } = await child("1");
		expect(code).toBe(0);
		expect(stdout).toContain("udpSendBatch=0");
		expect(stdout).toContain("downstream=50");
		expect(stderr).toContain(
			"webtransport-native: warning: WEBTRANSPORT_NATIVE_UDP_SEND_BATCH must be 0 or 2..=1024, got '1'; ignoring it and using the default (0)",
		);
		expect(stderr.split("WEBTRANSPORT_NATIVE_UDP_SEND_BATCH ").length - 1).toBe(
			1,
		);
	}, 60_000);

	it("preserves legacy drop-mode parsing with an unbatched socket", async () => {
		const accepted = await child("0", "drop");
		expect(accepted.code).toBe(0);
		expect(accepted.stdout).toContain("udpSendBatch=0");
		expect(accepted.stdout).toContain("udpSendEagainMode=drop");
		expect(accepted.stdout).toContain("downstream=50");
		const c = counters(accepted.stdout);
		expect(c.batchCalls).toBe(0);
		expect(c.batchMessages).toBe(0);
		expect(c.batchFallback).toBe(0);
	}, 60_000);

	it("rejects batched drop mode synchronously before endpoint startup", async () => {
		const rejected = await child(
			"64",
			"drop",
			undefined,
			STARTUP_REFUSAL_CHILD,
		);
		expect(rejected.code).toBe(0);
		expect(rejected.stdout).toContain(
			"startupError=E_INTERNAL: server startup failed: WEBTRANSPORT_NATIVE_UDP_SEND_EAGAIN_MODE must be wait when WEBTRANSPORT_NATIVE_UDP_SEND_BATCH is enabled, got 'drop'",
		);
		expect(rejected.stdout).toContain("continuedAfterRefusal=true");
		expect(rejected.stdout).not.toContain("unexpected startup success");
		expect(rejected.stderr).not.toContain("panicked");
		expect(rejected.stderr).not.toContain("E_HANDSHAKE_TIMEOUT");
	}, 20_000);

	it("warns once and falls back to wait on an unknown EAGAIN mode", async () => {
		const rejected = await child("64", "retry");
		expect(rejected.code).toBe(0);
		expect(rejected.stdout).toContain("udpSendEagainMode=wait");
		expect(rejected.stdout).toContain("downstream=50");
		expect(rejected.stderr).toContain(
			"webtransport-native: warning: WEBTRANSPORT_NATIVE_UDP_SEND_EAGAIN_MODE must be wait or drop, got 'retry'; ignoring it and using the default (wait)",
		);
	}, 60_000);
});
