/**
 * wtransport driver datagram read path. Default "pump": each connection reads
 * datagrams in its own task. `WTRANSPORT_DATAGRAM_PUMP=0` keeps the inline
 * read in the driver select loop ("legacy"), as a campaign-only paired control.
 *
 * The mode is resolved once per process, so each mode runs in its own child.
 * Each child does a real datagram round trip in both directions and reads the
 * pump counters back, so the test proves which path actually carried traffic,
 * not merely that the getter echoes the environment.
 */

import { describe, expect, it } from "bun:test";
import { nextPort } from "./helpers/network.js";

const BASE_PORT = 26_900;
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
console.log("datagramDriver=" + __TESTING__.serverInternals(server).serverDatagramDriver());
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
let up = 0, down = 0;
for (let i = 0; i < 50; i += 1) {
	await client.sendDatagram(new Uint8Array([i]));
	const got = await nextWithin(fromClient, "client datagram");
	if (got.value && got.value[0] === i) up += 1;
	await session.sendDatagram(new Uint8Array([i]));
	const back = await nextWithin(fromServer, "server datagram");
	if (back.value && back.value[0] === i) down += 1;
}
console.log("up=" + up + " down=" + down);
const m = __TESTING__.serverInternals(server).metricsSnapshot();
console.log("pumpsSpawned=" + (m.datagramPumpsSpawned ?? -1) + " pumpsLive=" + (m.datagramPumpsLive ?? -1));
await fromClient.return?.();
await fromServer.return?.();
client.close();
await server.close();
`;

async function child(
	pump: string | undefined,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const env = { ...process.env };
	if (pump === undefined) delete env.WTRANSPORT_DATAGRAM_PUMP;
	else env.WTRANSPORT_DATAGRAM_PUMP = pump;
	const proc = Bun.spawn(["bun", "-e", CHILD], {
		env,
		cwd: new URL("../../..", import.meta.url).pathname,
		stdout: "pipe",
		stderr: "pipe",
	});
	// The literal fixture creates no subprocesses; killing this owned child
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

function value(stdout: string, key: string): string {
	const match = stdout.match(new RegExp(`${key}=(\\S+)`));
	if (!match) throw new Error(`no ${key} in ${stdout}`);
	return match[1] as string;
}

describe("server datagram driver", () => {
	it("defaults to the pump and carries datagrams through pump tasks", async () => {
		const { code, stdout, stderr } = await child(undefined);
		expect(code, stderr).toBe(0);
		expect(value(stdout, "datagramDriver")).toBe("pump");
		expect(value(stdout, "up")).toBe("50");
		expect(value(stdout, "down")).toBe("50");
		// Server and client drivers share this process: at least one pump each.
		expect(Number(value(stdout, "pumpsSpawned"))).toBeGreaterThanOrEqual(2);
	}, 20_000);

	it("WTRANSPORT_DATAGRAM_PUMP=0 selects the inline path and spawns no pump", async () => {
		const { code, stdout, stderr } = await child("0");
		expect(code, stderr).toBe(0);
		expect(value(stdout, "datagramDriver")).toBe("legacy");
		expect(value(stdout, "up")).toBe("50");
		expect(value(stdout, "down")).toBe("50");
		expect(Number(value(stdout, "pumpsSpawned"))).toBe(0);
		expect(Number(value(stdout, "pumpsLive"))).toBe(0);
	}, 20_000);
});
