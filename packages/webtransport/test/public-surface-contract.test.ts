// Freezes the three-surface public API model for 1.0:
//
//   root        native, Node-API server/client API (sync createServer)
//   ./wasm      async WASM/IWA API, backend-specific extensions allowed
//   ./portable  the common async server/session subset both backends implement
//
// Two kinds of assertion live here. The `type _Assert*` aliases are checked by
// `tsc --noEmit` and nothing else; the `test(...)` blocks check the same
// contract at runtime, on a real session from each backend, because a
// structural type says nothing about what the object actually does.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectWasm } from "../src/backend.js";
import * as rootSurface from "../src/index.js";
import * as portableSurface from "../src/portable.js";
import type { PortableServer, PortableServerSession } from "../src/portable.js";
import { InMemoryRelay } from "../src/wasm-relay.js";
import type { WasmServerSession } from "../src/wasm-server-session.js";
import * as wasmSurface from "../src/wasm.js";
import { withTimeout } from "./helpers/harness.js";
import { nextPort, openWTWithRetry } from "./helpers/network.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";

const wasm = wasmAvailable
	? await loadWasmModule()
	: (null as unknown as Awaited<ReturnType<typeof loadWasmModule>>);

const packageJson = JSON.parse(
	readFileSync(
		fileURLToPath(new URL("../package.json", import.meta.url)),
		"utf8",
	),
) as { exports: Record<string, unknown> };

// --- compile-time half of the contract ------------------------------------

type Assert<T extends true> = T;
type Not<T extends boolean> = T extends true ? false : true;
type Extends<A, B> = A extends B ? true : false;

// Both adapters must satisfy the common session contract structurally.
type _AssertWasmSessionIsPortable = Assert<
	Extends<WasmServerSession, PortableServerSession>
>;

// The portable entrypoint must return the common server contract.
type _AssertPortableServer = Assert<
	Extends<
		Awaited<ReturnType<typeof portableSurface.createServer>>,
		PortableServer
	>
>;

// Backend-specific capabilities must stay off the common contract. `goAway()`
// is native-only on purpose: the wasm h3 module has no control-stream GOAWAY
// handling, so promising it here would be a lie the type system would enforce.
type _AssertNoGoAwayOnPortable = Assert<
	Not<Extends<PortableServerSession, { goAway(): void }>>
>;
type _AssertNoUnwrapOnPortable = Assert<
	Not<Extends<PortableServerSession, { unwrap(): unknown }>>
>;
// `sendDatagramBatch()` is native-only for the same reason batched *receiving*
// is: it exists to amortize the N-API crossing, and wasm has none.
type _AssertNoSendDatagramBatchOnPortable = Assert<
	Not<
		Extends<
			PortableServerSession,
			{ sendDatagramBatch(datagrams: readonly Uint8Array[]): unknown }
		>
	>
>;
// ...and it is genuinely on the native session, so the assertion above is a
// statement about the portable surface rather than about a method nobody has.
type _AssertSendDatagramBatchOnNative = Assert<
	Extends<
		rootSurface.ServerSession,
		{ sendDatagramBatch(datagrams: readonly Uint8Array[]): unknown }
	>
>;
type _AssertNoGetStatsOnPortable = Assert<
	Not<Extends<PortableServerSession, { getStats(): unknown }>>
>;

// The portable server exposes no native-only lifecycle knobs (cert rotation,
// SNI, congestion control all live on the root `WebTransportServer`).
type _AssertNoUpdateCertOnPortable = Assert<
	Not<Extends<PortableServer, { updateCert(tls: unknown): Promise<void> }>>
>;

// `sendDatagramMirror()` is native-only for the same reason batched sending is:
// its entire content is amortizing a Node-API crossing wasm does not have, and
// wasm has no session registry to fan out through. See PARITY_MATRIX.md §3.
type _AssertNoSendDatagramMirrorOnPortable = Assert<
	Not<
		Extends<
			PortableServer,
			{
				sendDatagramMirror(
					targets: readonly string[],
					payload: Uint8Array,
				): unknown;
			}
		>
	>
>;
// ...and it is genuinely on the native root server, so the assertion above is a
// statement about the portable surface rather than about a method nobody has.
type _AssertSendDatagramMirrorOnNative = Assert<
	Extends<
		rootSurface.WebTransportServer,
		{
			sendDatagramMirror(
				targets: readonly string[],
				payload: Uint8Array,
			): unknown;
		}
	>
>;

// The paced mirror and its report reader are additive members of the same
// native-only family, and native-only for the same reason: both are about the
// egress pacer's schedule and the session registry it fans out through, neither
// of which wasm has. Added rather than substituted — `sendDatagramMirror` above
// keeps its own assertions, because the paced API exists precisely so that one
// does not change.
type _AssertNoPacedMirrorOnPortable = Assert<
	Not<
		Extends<
			PortableServer,
			{
				sendDatagramMirrorPaced(
					targets: readonly string[],
					payload: Uint8Array,
				): unknown;
			}
		>
	>
>;
type _AssertNoReadMirrorReportsOnPortable = Assert<
	Not<Extends<PortableServer, { readMirrorReports(max?: number): unknown }>>
>;
type _AssertPacedMirrorOnNative = Assert<
	Extends<
		rootSurface.WebTransportServer,
		{
			sendDatagramMirrorPaced(
				targets: readonly string[],
				payload: Uint8Array,
			): unknown;
			readMirrorReports(max?: number): unknown;
		}
	>
>;

// --- the frozen export sets -----------------------------------------------

const ROOT_EXPORTS = [
	"DEFAULT_LIMITS",
	"DEFAULT_RATE_LIMITS",
	"E_BACKPRESSURE_TIMEOUT",
	"E_HANDSHAKE_TIMEOUT",
	"E_INTERNAL",
	"E_INVALID_ARGUMENT",
	"E_LIMIT_EXCEEDED",
	"E_QUEUE_FULL",
	"E_RATE_LIMITED",
	"E_SERVER_CLOSING",
	"E_SESSION_CLOSED",
	"E_SESSION_IDLE_TIMEOUT",
	"E_STOP_SENDING",
	"E_STREAM_RESET",
	"E_TLS",
	"E_UNSUPPORTED_ARGUMENT",
	"METRICS_PREFIX",
	"WT_RESET",
	"WT_STOP_SENDING",
	"WebTransport",
	"WebTransportError",
	"WebTransportSendGroup",
	"clientPoolMetricsSnapshot",
	"connect",
	"createServer",
	// The QUIC-LB connection-ID decoders. Added deliberately, as an additive
	// (semver-minor) widening of the native surface rather than a reshaping of
	// it: they are the balancer's half of the `quicLb` server option, and a
	// balancer cannot reach them anywhere else — the package's `exports` map is
	// pinned to exactly three subpaths by the test below, so a module that is
	// not re-exported from one of the three is unreachable for consumers.
	"decodeQuicLbConfigRotation",
	"decodeQuicLbServerId",
	"exportTicketVault",
	"importTicketVault",
	"metricsToPrometheus",
	"nativeToWebTransportLike",
	// Ships with the two decoders above and for the same reason: a balancer
	// reading a connection ID gets its LENGTH from configuration, never from
	// the wire, so the decoders are only usable alongside the function that
	// computes it. Additive (semver-minor) like they were.
	"quicLbCidLength",
	"releaseNativeMemory",
	"toWebTransport",
];

const WASM_EXPORTS = [
	"DEFAULT_WASM_LIMITS",
	"DEFAULT_WASM_RATE_LIMITS",
	"DirectSocketsUdpTransport",
	"FileTicketStoreHost",
	"InMemoryRelay",
	"IndexedDBTicketStoreHost",
	"MemoryTicketStoreHost",
	"WasmCertRotator",
	"WasmServerSession",
	"WasmTransportManager",
	"WasmWebTransport",
	"WasmWebTransportSendGroup",
	"connectWasm",
	"connectWasmUnified",
	"createIwaServer",
	"createServer",
	"createUnifiedClient",
	"createW3CMappedError",
	"createWasmServer",
	"generateCert",
	"isWasmRuntime",
	"loadWasmModule",
	"loadWasmWebModule",
	"normalizeW3CBrowserName",
	"normalizeWasmEndpointOptions",
	"selectBackend",
	"serveOverUdp",
	"serverCertificateHashes",
	"toWasmServerSession",
	"validateW3CClientOptions",
	"validateWasmWebTransportOptions",
	"wasmClientPoolMetricsSnapshot",
];

const PORTABLE_EXPORTS = ["createServer"];

/** Member name -> the `typeof` every backend must report for it. */
const SESSION_CONTRACT: Record<string, "string" | "object" | "function"> = {
	id: "string",
	peer: "object",
	ready: "object",
	closed: "object",
	incomingBidirectionalStreams: "object",
	incomingUnidirectionalStreams: "object",
	close: "function",
	drain: "function",
	sendDatagram: "function",
	incomingDatagrams: "function",
	createBidirectionalStream: "function",
	createUnidirectionalStream: "function",
	metricsSnapshot: "function",
};

const METRICS_FIELDS = [
	"datagramsIn",
	"datagramsOut",
	"queuedBytes",
	"streamsActive",
];

/** Capabilities that must never leak onto the common session contract. */
const BACKEND_ONLY_SESSION_MEMBERS = ["goAway", "unwrap", "getStats"];

/**
 * Native-only *server* members must be absent in fact, not merely absent from
 * the type. Both adapters build an explicit object literal, so a leak here
 * means a projection turned into a spread.
 */
function assertServerContract(server: PortableServer): void {
	const bag = server as unknown as Record<string, unknown>;
	expect(bag.sendDatagramMirror).toBeUndefined();
	expect(bag.sendDatagramMirrorPaced).toBeUndefined();
	expect(bag.readMirrorReports).toBeUndefined();
	expect(bag.updateCert).toBeUndefined();
}

function assertSessionContract(session: PortableServerSession): void {
	const bag = session as unknown as Record<string, unknown>;
	for (const [member, kind] of Object.entries(SESSION_CONTRACT)) {
		expect(`${member} is ${typeof bag[member]}`).toBe(`${member} is ${kind}`);
	}
	expect(session.ready).toBeInstanceOf(Promise);
	expect(session.closed).toBeInstanceOf(Promise);
	expect(session.incomingBidirectionalStreams).toBeInstanceOf(ReadableStream);
	expect(session.incomingUnidirectionalStreams).toBeInstanceOf(ReadableStream);
	expect(session.id.length).toBeGreaterThan(0);
	expect(typeof session.peer.ip).toBe("string");
	expect(typeof session.peer.port).toBe("number");

	const metrics = session.metricsSnapshot();
	expect(Object.keys(metrics).sort()).toEqual(METRICS_FIELDS);
	for (const field of METRICS_FIELDS) {
		expect(typeof (metrics as unknown as Record<string, unknown>)[field]).toBe(
			"number",
		);
	}

	// Native-only members must be absent in fact, not merely absent from the
	// type: the native adapter projects the session member by member, and a
	// projection that leaked one would make the portable surface backend-shaped.
	expect(bag.sendDatagramBatch).toBeUndefined();
	expect(bag.goAway).toBeUndefined();

	// One datagram consumer per session: repeated calls hand back the same
	// iterable rather than a second view racing for the same source.
	expect(session.incomingDatagrams()).toBe(session.incomingDatagrams());
}

/** Datagrams a live peer pushes at the server, in the order given. */
const DATAGRAM_BURST = 8;
/**
 * Both live sessions run over loopback against a local in-process server and
 * deliver all 8. The floor absorbs two losses so an unlucky run cannot flake,
 * and still fails a backend that drops most of a burst.
 */
const MIN_DATAGRAMS_DELIVERED = 6;

/**
 * The COMMON half of the narrowed `/portable` incoming-datagram contract, run
 * on a live session of each backend: one memoized single-consumer iterable,
 * `Uint8Array` items delivered one per yield, and this backend's own receive
 * order preserved.
 *
 * What it deliberately does not assert is hidden buffering — how deep either
 * backend reads ahead, and how much of a close-time backlog survives. Native
 * batches its Node-API reads and wasm does not, so those numbers differ by
 * design; the native depth is pinned in the Task 3 batch tests instead. Loss is
 * tolerated here too, because this is an unreliable transport.
 */
async function assertIncomingDatagramFlow(
	session: PortableServerSession,
	send: (payload: Uint8Array) => Promise<void>,
): Promise<AsyncIterator<Uint8Array>> {
	const iterable = session.incomingDatagrams();
	expect(iterable).toBe(session.incomingDatagrams());
	expect(typeof iterable[Symbol.asyncIterator]).toBe("function");
	const iterator = iterable[Symbol.asyncIterator]();

	for (let id = 0; id < DATAGRAM_BURST; id += 1) {
		await send(new Uint8Array([id]));
	}

	const ids: number[] = [];
	while (ids.length < DATAGRAM_BURST) {
		const next = await withTimeout(
			iterator.next(),
			5000,
			"portable incoming datagram",
		).catch(() => null);
		// A datagram that never arrives is loss, not a contract breach: stop
		// waiting and judge what did arrive.
		if (next === null || next.done) break;
		// One item per yield — a batched backend must not surface its batch.
		expect(next.value).toBeInstanceOf(Uint8Array);
		expect((next.value as Uint8Array).length).toBe(1);
		ids.push((next.value as Uint8Array)[0] as number);
	}

	expect(ids.length).toBeGreaterThanOrEqual(MIN_DATAGRAMS_DELIVERED);
	expect(new Set(ids).size).toBe(ids.length);
	expect([...ids].sort((a, b) => a - b)).toEqual(ids);
	return iterator;
}

/**
 * Bounded termination: once the session is closed the iterable ends, and every
 * item it yields on the way out is still a `Uint8Array`. The count of those
 * trailing items is per-backend buffering and is intentionally not asserted.
 */
async function assertIncomingDatagramsTerminate(
	iterator: AsyncIterator<Uint8Array>,
): Promise<void> {
	let done = false;
	for (let step = 0; step < DATAGRAM_BURST * 4 && !done; step += 1) {
		const next = await withTimeout(
			iterator.next(),
			5000,
			"portable incoming datagram termination",
		);
		if (next.done) done = true;
		else expect(next.value).toBeInstanceOf(Uint8Array);
	}
	expect(done).toBe(true);
}

describe("three-surface public API model", () => {
	test("the package exports exactly the three documented subpaths", () => {
		expect(Object.keys(packageJson.exports).sort()).toEqual([
			".",
			"./portable",
			"./wasm",
		]);
	});

	test("the native root surface is frozen", () => {
		// __TESTING__ is the one tolerated non-public name on the root module:
		// an explicitly unstable bag of test seams (see SPEC's semver section).
		// It is excluded from the frozen list so reshaping or deleting it is
		// NOT a semver-major event, and pinned here so nothing else sneaks in.
		const names = Object.keys(rootSurface).sort();
		const extras = names.filter((name) => !ROOT_EXPORTS.includes(name));
		expect(extras).toEqual(["__TESTING__"]);
		expect(names.filter((name) => name !== "__TESTING__")).toEqual(
			ROOT_EXPORTS,
		);
	});

	test("the /wasm surface is frozen", () => {
		expect(Object.keys(wasmSurface).sort()).toEqual(WASM_EXPORTS);
	});

	test("the /portable surface is the common subset, and only that", () => {
		expect(Object.keys(portableSurface).sort()).toEqual(PORTABLE_EXPORTS);
	});

	test("native-only APIs stay on the root surface", () => {
		// Node-API memory release, the ticket vault, and the Node-stream client
		// have no wasm or portable equivalent and must not appear to have one.
		for (const nativeOnly of [
			"releaseNativeMemory",
			"exportTicketVault",
			"importTicketVault",
			"connect",
			"metricsToPrometheus",
		]) {
			expect(ROOT_EXPORTS).toContain(nativeOnly);
			expect(WASM_EXPORTS).not.toContain(nativeOnly);
			expect(PORTABLE_EXPORTS).not.toContain(nativeOnly);
		}
	});

	test("the root createServer is sync and the other two are async", async () => {
		// The root API hands back a server object directly; both portable and
		// wasm must be awaited. This is the one shape difference callers feel.
		const port = nativePort();
		const server = rootSurface.createServer({
			host: "127.0.0.1",
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		expect(server).not.toBeInstanceOf(Promise);
		expect(server.address.port).toBe(port);
		await server.close();

		expect(portableSurface.createServer.constructor.name).toBe("AsyncFunction");
		expect(wasmSurface.createServer.constructor.name).toBe("AsyncFunction");
	});
});

function nativePort(): number {
	return nextPort(17200, 400);
}

describe("/portable runtime contract", () => {
	test("the native adapter satisfies the common session contract", async () => {
		const port = nativePort();
		const seen = Promise.withResolvers<PortableServerSession>();
		const server = await portableSurface.createServer({
			backend: "native",
			host: "127.0.0.1",
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: (session) => seen.resolve(session),
		});

		try {
			expect(server.backend).toBe("native");
			expect(typeof server.address.host).toBe("string");
			// Chain validation, not pinning: no hash to hand a client.
			expect(server.certHashBase64).toBeUndefined();
			assertServerContract(server);

			const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
			});
			const session = await withTimeout(
				seen.promise,
				5000,
				"portable native session",
			);
			assertSessionContract(session);
			const writer = wt.datagrams.writable.getWriter();
			const datagrams = await assertIncomingDatagramFlow(session, (payload) =>
				writer.write(payload),
			);
			writer.releaseLock();
			expect(session.drain()).toBeUndefined();
			expect(session.close({ code: 0, reason: "" })).toBeUndefined();
			await assertIncomingDatagramsTerminate(datagrams);
			wt.close();
		} finally {
			const closed = server.close();
			expect(closed).toBeInstanceOf(Promise);
			await expect(closed).resolves.toBeUndefined();
		}
	});

	test.skipIf(!wasmAvailable)(
		"the wasm adapter satisfies the same session contract",
		async () => {
			const relay = new InMemoryRelay();
			const serverAddr = { address: "127.0.0.1", port: 4731 };
			const clientAddr = { address: "127.0.0.1", port: 5731 };
			const seen = Promise.withResolvers<PortableServerSession>();

			const server = await portableSurface.createServer({
				backend: "wasm",
				host: serverAddr.address,
				port: serverAddr.port,
				tls: { allowSelfSigned: true },
				wasmModule: wasm,
				wasmBind: async () => relay.endpoint(serverAddr),
				onSession: (session) => seen.resolve(session),
			});

			try {
				expect(server.backend).toBe("wasm");
				// Clients pin the hash instead of chain-validating.
				expect(typeof server.certHashBase64).toBe("string");
				assertServerContract(server);

				const { session: clientSession, manager } = await connectWasm(
					wasm,
					relay.endpoint(clientAddr),
					"localhost",
					`${clientAddr.address}:${clientAddr.port}`,
					`${serverAddr.address}:${serverAddr.port}`,
					{ certHashBase64: server.certHashBase64 },
				);
				await clientSession.ready;

				const session = await withTimeout(
					seen.promise,
					5000,
					"portable wasm session",
				);
				assertSessionContract(session);
				const datagrams = await assertIncomingDatagramFlow(session, (payload) =>
					clientSession.sendDatagram(payload),
				);
				expect(session.drain()).toBeUndefined();
				expect(session.close({ code: 0, reason: "" })).toBeUndefined();
				await assertIncomingDatagramsTerminate(datagrams);
				manager.close();
			} finally {
				const closed = server.close();
				expect(closed).toBeInstanceOf(Promise);
				await expect(closed).resolves.toBeUndefined();
			}
		},
	);

	test("backend-only session capabilities are absent from the contract", () => {
		for (const member of BACKEND_ONLY_SESSION_MEMBERS) {
			expect(Object.keys(SESSION_CONTRACT)).not.toContain(member);
		}
	});
});
