import { describe, expect, test } from "bun:test";
import {
	createWasmServer,
	normalizeWasmEndpointOptions,
	toWasmServerSession,
	WasmTransportManager,
} from "../src/backend.js";
import { generateCert } from "../src/wasm-cert.js";
import { InMemoryRelay, type UdpTransport } from "../src/wasm-relay.js";
import { waitFor } from "./helpers/harness.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";

// Soft-skip when pkg is absent (local `bun test packages/`). With
// WEBTRANSPORT_REQUIRE_WASM=1 the helper throws at import time instead.
const wasm = wasmAvailable
	? await loadWasmModule()
	: (null as unknown as Awaited<ReturnType<typeof loadWasmModule>>);

type LogEvent = { type: string; [k: string]: unknown };

/** Managed server/client pair over an in-memory UDP switch, mirroring the
 * helper in wasm-limits.test.ts but wired up for {@link WasmTransportManager.setLog}. */
async function realManagedPair() {
	const relay = new InMemoryRelay();
	const options = normalizeWasmEndpointOptions();
	let resolveServerSession!: (session: unknown) => void;
	const serverSessionPromise = new Promise((resolve) => {
		resolveServerSession = resolve;
	});
	const serverManager = WasmTransportManager.create(
		wasm,
		relay.a,
		true,
		"127.0.0.1:4433",
		"127.0.0.1:5544",
		resolveServerSession as never,
		options,
	);
	const clientManager = WasmTransportManager.create(
		wasm,
		relay.b,
		false,
		"127.0.0.1:5544",
		"127.0.0.1:4433",
		null,
		options,
	);
	const clientSession = clientManager.connectClient("localhost");
	const serverSession = (await Promise.race([
		serverSessionPromise,
		Bun.sleep(3_000).then(() => {
			throw new Error("server session timeout");
		}),
	])) as Awaited<ReturnType<typeof clientManager.connectClient>>;
	await Promise.race([
		clientSession.ready,
		Bun.sleep(3_000).then(() => {
			throw new Error("client session timeout");
		}),
	]);
	return { serverManager, serverSession, clientManager, clientSession };
}

/**
 * A server manager backed by `wt_new_server_with_options` (generated-cert
 * path with live TLS resolver). `createWasmServer` /
 * `wt_new_endpoint_with_options` also wires a live resolver now.
 */
function realTlsServer(udp: UdpTransport) {
	const normalized = normalizeWasmEndpointOptions();
	const json = (
		wasm as unknown as { wt_new_server_with_options(json: string): string }
	).wt_new_server_with_options(
		JSON.stringify({
			addr: "127.0.0.1:4433",
			peerAddr: "127.0.0.1:0",
			commonName: "localhost",
			validityDays: 14,
			notBeforeUnix: Math.floor(Date.now() / 1000) - 3600,
			...normalized,
		}),
	);
	const parsed = JSON.parse(json) as {
		eid?: number;
		hashBase64?: string;
		error?: string;
	};
	if (parsed.error || parsed.eid == null) {
		throw new Error(`wt_new_server failed: ${parsed.error ?? "unknown"}`);
	}
	const manager = WasmTransportManager.adopt(
		wasm,
		udp,
		parsed.eid,
		() => {},
		normalized,
	);
	return { manager, hashBase64: parsed.hashBase64 as string };
}

describe.skipIf(!wasmAvailable)("wasm ops logging (Phase 7)", () => {
	test("emits session_established/session_closed for both peers", async () => {
		const serverEvents: LogEvent[] = [];
		const clientEvents: LogEvent[] = [];
		const { serverManager, serverSession, clientManager, clientSession } =
			await realManagedPair();
		serverManager.setLog((e) => serverEvents.push(e));
		clientManager.setLog((e) => clientEvents.push(e));

		try {
			// Both sides already established before the logger was attached;
			// closing one side re-exercises the lifecycle path deterministically.
			clientSession.close({ code: 0, reason: "test done" });
			await waitFor(
				() => clientEvents.some((e) => e.type === "session_closed"),
				(done) => done,
				3_000,
				10,
				"client observes session_closed",
			);
			await waitFor(
				() => serverEvents.some((e) => e.type === "session_closed"),
				(done) => done,
				3_000,
				10,
				"server observes session_closed",
			);
			const clientClosed = clientEvents.find(
				(e) => e.type === "session_closed",
			);
			expect(clientClosed).toMatchObject({ code: 0 });
		} finally {
			serverSession.close();
			serverManager.close();
			clientManager.close();
		}
	});

	test("emits session_established for the initial client connect", async () => {
		const serverEvents: LogEvent[] = [];
		const relay = new InMemoryRelay();
		const options = normalizeWasmEndpointOptions();
		let resolveServerSession!: (session: unknown) => void;
		const serverSessionPromise = new Promise((resolve) => {
			resolveServerSession = resolve;
		});
		const serverManager = WasmTransportManager.create(
			wasm,
			relay.a,
			true,
			"127.0.0.1:4433",
			"127.0.0.1:5544",
			resolveServerSession as never,
			options,
		);
		serverManager.setLog((e) => serverEvents.push(e));
		const clientManager = WasmTransportManager.create(
			wasm,
			relay.b,
			false,
			"127.0.0.1:5544",
			"127.0.0.1:4433",
			null,
			options,
		);

		try {
			const clientSession = clientManager.connectClient("localhost");
			await Promise.race([
				clientSession.ready,
				Bun.sleep(3_000).then(() => {
					throw new Error("client session timeout");
				}),
			]);
			await Promise.race([
				serverSessionPromise,
				Bun.sleep(3_000).then(() => {
					throw new Error("server session timeout");
				}),
			]);
			const established = serverEvents.find(
				(e) => e.type === "session_established",
			);
			expect(established).toBeDefined();
			expect(typeof established?.conn).toBe("number");
			expect(established?.sessionId).toBeDefined();
		} finally {
			serverManager.close();
			clientManager.close();
		}
	});

	test("emits limit_exceeded when a datagram exceeds maxDatagramSize", async () => {
		const events: LogEvent[] = [];
		const { serverManager, serverSession, clientManager, clientSession } =
			await realManagedPair();
		clientManager.setLog((e) => events.push(e));

		try {
			const oversized = new Uint8Array(clientSession.maxDatagramSize + 1);
			await expect(clientSession.sendDatagram(oversized)).rejects.toThrow();
			const event = events.find((e) => e.type === "limit_exceeded");
			expect(event).toMatchObject({ context: "sendDatagram" });
		} finally {
			serverSession.close();
			serverManager.close();
			clientManager.close();
		}
	});

	test("emits tls_update with the rotated default cert hash, redacted PEM unless debug", async () => {
		const events: LogEvent[] = [];
		const relay = new InMemoryRelay();
		const { manager: serverManager } = realTlsServer(relay.a);
		serverManager.setLog((e) => events.push(e));

		try {
			const cert = generateCert(wasm, "localhost", 14);
			await serverManager.updateTls({
				certPem: cert.certPem,
				keyPem: cert.keyPem,
			});
			const event = events.find((e) => e.type === "tls_update");
			expect(event).toBeDefined();
			expect(event?.defaultCertHashBase64).toBe(cert.hashBase64);
			expect(event?.certPem).toBeUndefined();
			expect(event?.keyPem).toBeUndefined();

			const snapshot = serverManager.tlsSnapshot();
			expect(snapshot.defaultCertPresent).toBe(true);
			expect(snapshot.defaultCertHashBase64).toBe(cert.hashBase64);
		} finally {
			serverManager.close();
		}
	});

	test("debug mode does not strip PEM fields from log events", async () => {
		const events: LogEvent[] = [];
		const relay = new InMemoryRelay();
		const { manager: serverManager } = realTlsServer(relay.a);
		serverManager.setLog((e) => events.push(e), true);

		try {
			serverManager.emitLog("debug_probe", { certPem: "-----BEGIN-----" });
			const event = events.find((e) => e.type === "debug_probe");
			expect(event?.certPem).toBe("-----BEGIN-----");
		} finally {
			serverManager.close();
		}
	});

	test("createWasmServer wires live TLS resolver (updateTls/tlsSnapshot)", async () => {
		const relay = new InMemoryRelay();
		const serverManager = createWasmServer(
			wasm,
			relay.a,
			() => {},
			"127.0.0.1:4433",
			"127.0.0.1:0",
		);
		try {
			const before = serverManager.tlsSnapshot();
			expect(before.defaultCertPresent).toBe(true);
			const cert = generateCert(wasm, "localhost", 14);
			await serverManager.updateTls({
				certPem: cert.certPem,
				keyPem: cert.keyPem,
			});
			const after = serverManager.tlsSnapshot();
			expect(after.defaultCertPresent).toBe(true);
			expect(after.defaultCertHashBase64).toBe(cert.hashBase64);
		} finally {
			serverManager.close();
		}
	});
});

describe.skipIf(!wasmAvailable)("WasmServerSession facade (Phase 8)", () => {
	test("metricsSnapshot reports real datagram counts and active streams", async () => {
		const { serverManager, serverSession, clientManager, clientSession } =
			await realManagedPair();

		try {
			const serverFacade = toWasmServerSession(serverSession);
			const clientFacade = toWasmServerSession(clientSession);

			await clientFacade.sendDatagram(Uint8Array.of(0x01));
			const serverGotDatagram = new Promise<void>((resolve) => {
				serverFacade.onDatagram(() => resolve());
			});
			await Promise.race([
				serverGotDatagram,
				Bun.sleep(3_000).then(() => {
					throw new Error("server did not observe the datagram");
				}),
			]);

			await waitFor(
				() => serverFacade.metricsSnapshot().datagramsIn,
				(count) => count === 1,
				3_000,
				10,
				"server metricsSnapshot reflects the received datagram",
			);
			expect(clientFacade.metricsSnapshot().datagramsOut).toBe(1);

			await clientFacade.createBidirectionalStream();
			expect(clientFacade.metricsSnapshot().streamsActive).toBe(1);
		} finally {
			serverSession.close();
			serverManager.close();
			clientManager.close();
		}
	});
});
