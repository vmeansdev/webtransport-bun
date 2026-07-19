import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
	type WasmModule,
	WasmEndpoint,
	type WasmSessionEvents,
} from "../src/backend-wasm.js";
import { InMemoryRelay } from "../src/wasm-relay.js";

const pkgPath = fileURLToPath(
	new URL("../../../crates/wasm/pkg/webtransport_wasm.js", import.meta.url),
);
const wasmAvailable = existsSync(pkgPath);
const wasm = wasmAvailable
	? ((await import(pkgPath)) as unknown as WasmModule)
	: (null as unknown as WasmModule);

async function pair(
	serverEvents: WasmSessionEvents,
	clientEvents: WasmSessionEvents,
): Promise<{ server: WasmEndpoint; client: WasmEndpoint; conn: number }> {
	const relay = new InMemoryRelay();
	let serverEstablished = false;
	let clientEstablished = false;
	const server = WasmEndpoint.create(
		wasm,
		relay.a,
		true,
		"127.0.0.1:4433",
		"127.0.0.1:5544",
		{ ...serverEvents, onEstablished: () => (serverEstablished = true) },
	);
	const client = WasmEndpoint.create(
		wasm,
		relay.b,
		false,
		"127.0.0.1:5544",
		"127.0.0.1:4433",
		{ ...clientEvents, onEstablished: () => (clientEstablished = true) },
	);
	const conn = client.connect("localhost");
	const deadline = Date.now() + 3000;
	while (!(serverEstablished && clientEstablished) && Date.now() < deadline) {
		await Bun.sleep(5);
	}
	expect(serverEstablished && clientEstablished).toBe(true);
	return { server, client, conn };
}

describe("wasm WebTransport streams (P2)", () => {
	test.skipIf(!wasmAvailable)("bidi stream echo", async () => {
		let echo: Uint8Array | null = null;
		let serverRef: WasmEndpoint | null = null;
		const { server, client, conn } = await pair(
			{
				onStreamData: (_conn, stream, data) => {
					if (data.length > 0) serverRef?.streamWrite(stream, data);
				},
			},
			{
				onStreamData: (_conn, _stream, data) => {
					if (data.length > 0) echo = data.slice();
				},
			},
		);
		serverRef = server;

		const stream = client.openStream(conn, true);
		expect(stream).toBeGreaterThanOrEqual(0);
		client.streamWrite(stream, new TextEncoder().encode("hello-bidi"));

		const deadline = Date.now() + 3000;
		while (echo === null && Date.now() < deadline) await Bun.sleep(5);
		expect(echo).not.toBeNull();
		expect(new TextDecoder().decode(echo as unknown as Uint8Array)).toBe(
			"hello-bidi",
		);
		client.close();
		server.close();
	});

	test.skipIf(!wasmAvailable)("uni stream one-way with FIN", async () => {
		const chunks: Uint8Array[] = [];
		let fin = false;
		const { server, client, conn } = await pair(
			{
				onStreamData: (_conn, _stream, data, isFin) => {
					if (data.length > 0) chunks.push(data.slice());
					if (isFin) fin = true;
				},
			},
			{},
		);

		const stream = client.openStream(conn, false);
		expect(stream).toBeGreaterThanOrEqual(0);
		client.streamWrite(stream, new TextEncoder().encode("uni-msg"));
		client.streamFinish(stream);

		const deadline = Date.now() + 3000;
		while (!fin && Date.now() < deadline) await Bun.sleep(5);
		expect(fin).toBe(true);
		const joined = Buffer.concat(chunks.map((c) => Buffer.from(c)));
		expect(joined.toString()).toBe("uni-msg");
		client.close();
		server.close();
	});
});
