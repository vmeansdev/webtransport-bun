import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectWasm } from "../src/backend.js";
import {
	E_TLS,
	E_UNSUPPORTED_ARGUMENT,
	WebTransportError,
} from "../src/index.js";
import type { PortableServerSession } from "../src/portable.js";
import { createServer } from "../src/portable.js";
import { InMemoryRelay } from "../src/wasm-relay.js";
import { generateLocalhostCert } from "./helpers/certs.js";
import {
	forEachWithTimeout,
	readWithTimeout,
	withTimeout,
} from "./helpers/harness.js";
import { nextPort, openWTWithRetry } from "./helpers/network.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";

const wasm = wasmAvailable
	? await loadWasmModule()
	: (null as unknown as Awaited<ReturnType<typeof loadWasmModule>>);

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));

const cert = generateLocalhostCert();
if (!cert) throw new Error("failed to generate the native test certificate");
afterAll(() => cert.cleanup());
const nativeTls = { certPem: cert.certPem, keyPem: cert.keyPem };

describe("portable createServer", () => {
	test("the portable module never statically imports node: builtins", () => {
		// It has to load inside a Chromium Isolated Web App, where `node:stream`
		// would blow up at parse time. The native adapter is behind a dynamic
		// import precisely so this stays true.
		const source = readFileSync(`${srcDir}portable.ts`, "utf8");
		const staticNodeImports = source.match(
			/^import[^;]*from\s+"node:[^"]+";/gm,
		);
		expect(staticNodeImports).toBeNull();
	});

	test("the native adapter is reached only through a dynamic import", () => {
		const source = readFileSync(`${srcDir}portable.ts`, "utf8");
		expect(source).not.toMatch(/^import .*portable-native/m);
		expect(source).toContain('await import("./portable-native.js")');
	});

	test("echoes datagrams through the portable session surface on native", async () => {
		const port = nextPort(15600, 500);
		const server = await createServer({
			backend: "native",
			host: "127.0.0.1",
			port,
			tls: nativeTls,
			onSession: async (session: PortableServerSession) => {
				await forEachWithTimeout(
					session.incomingDatagrams(),
					5000,
					"portable server incoming datagram",
					async (d) => {
						await session.sendDatagram(d);
					},
				);
			},
		});

		try {
			expect(server.backend).toBe("native");
			expect(server.address.port).toBe(port);

			const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
			});
			const writer = wt.datagrams.writable.getWriter();
			const reader = wt.datagrams.readable.getReader();
			for (let i = 0; i < 20; i++) {
				await writer.write(Uint8Array.of(9, 9, 9));
			}
			const { value } = await readWithTimeout(
				reader,
				5000,
				"portable datagram echo",
			);
			expect(value).toEqual(Uint8Array.of(9, 9, 9));
			reader.releaseLock();
			writer.releaseLock();
			wt.close();
		} finally {
			await server.close();
		}
	});

	test("createBidirectionalStream yields Web Streams, not a Node duplex", async () => {
		const port = nextPort(16100, 500);
		let opened: PromiseWithResolvers<{
			readable: unknown;
			writable: unknown;
		}> | null = null;
		opened = Promise.withResolvers();

		const server = await createServer({
			backend: "native",
			host: "127.0.0.1",
			port,
			tls: nativeTls,
			onSession: async (session: PortableServerSession) => {
				const stream = await session.createBidirectionalStream();
				opened?.resolve(stream);
			},
		});

		try {
			const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
			});
			const stream = await opened.promise;
			// The raw native Duplex exposes booleans on these two properties.
			expect(stream.readable).toBeInstanceOf(ReadableStream);
			expect(stream.writable).toBeInstanceOf(WritableStream);
			wt.close();
		} finally {
			await server.close();
		}
	});

	test.skipIf(!wasmAvailable)(
		"the same echo handler runs unchanged on the wasm backend",
		async () => {
			const relay = new InMemoryRelay();
			const serverAddr = { address: "127.0.0.1", port: 4711 };
			const clientAddr = { address: "127.0.0.1", port: 5711 };

			// Byte-for-byte the handler used against native above.
			const echo = async (session: PortableServerSession) => {
				await forEachWithTimeout(
					session.incomingDatagrams(),
					5000,
					"portable server incoming datagram",
					async (d) => {
						await session.sendDatagram(d);
					},
				);
			};

			const server = await createServer({
				backend: "wasm",
				host: serverAddr.address,
				port: serverAddr.port,
				tls: { allowSelfSigned: true },
				wasmModule: wasm,
				wasmBind: async () => relay.endpoint(serverAddr),
				onSession: echo,
			});

			try {
				expect(server.backend).toBe("wasm");
				expect(server.certHashBase64).toBeTruthy();

				const { session, manager } = await connectWasm(
					wasm,
					relay.endpoint(clientAddr),
					"localhost",
					`${clientAddr.address}:${clientAddr.port}`,
					`${serverAddr.address}:${serverAddr.port}`,
					{ certHashBase64: server.certHashBase64 },
				);
				await session.ready;

				const echoed = Promise.withResolvers<Uint8Array>();
				session.onDatagram((d) => echoed.resolve(d.slice()));
				await session.sendDatagram(Uint8Array.of(7, 7, 7));

				await expect(
					withTimeout(echoed.promise, 5000, "wasm portable datagram echo"),
				).resolves.toEqual(Uint8Array.of(7, 7, 7));

				manager.close();
			} finally {
				await server.close();
			}
		},
	);

	test("rejects wasm-only allowSelfSigned on the native backend", async () => {
		const err = await createServer({
			backend: "native",
			port: 0,
			tls: { allowSelfSigned: true },
			onSession: () => {},
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(WebTransportError);
		expect(err).toMatchObject({ code: E_UNSUPPORTED_ARGUMENT });
		expect((err as Error).message).toMatch(/wasm-only/);
	});

	test("requires a certificate on the native backend instead of generating one", async () => {
		for (const tls of [
			{},
			{ certPem: "", keyPem: "" },
			{ certPem: cert.certPem },
			{ keyPem: cert.keyPem },
		]) {
			const err = await createServer({
				backend: "native",
				host: "127.0.0.1",
				port: 0,
				tls,
				onSession: () => {},
			}).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(WebTransportError);
			expect(err).toMatchObject({ code: E_TLS });
		}
	});
});
