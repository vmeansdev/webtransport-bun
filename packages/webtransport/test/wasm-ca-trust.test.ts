import { describe, expect, test } from "bun:test";
import { connectWasm, normalizeWasmEndpointOptions } from "../src/backend.js";
import { WasmEndpoint, type WasmSessionEvents } from "../src/backend-wasm.js";
import { E_TLS } from "../src/errors.js";
import { InMemoryRelay } from "../src/wasm-relay.js";
import { wasmCaFingerprint, wasmPoolKey } from "../src/wasm-endpoint-pool.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";

const wasm = wasmAvailable
	? await loadWasmModule()
	: (null as unknown as Awaited<ReturnType<typeof loadWasmModule>>);

// Test-only FFI: the CA chain generator is compiled in under `dev-insecure`
// only, so it exists in `pkg` builds and never in a shipped artifact.
const wasmTestFfi = wasm as unknown as {
	wt_generate_ca_signed_cert_for_test(
		commonName: string,
		validityDays: number,
		notBeforeUnix: number,
	): string;
	wt_new_server_with_options(configJson: string): string;
};

function notBefore() {
	return Math.floor(Date.now() / 1000) - 3600;
}

function generatedCert(commonName: string) {
	return JSON.parse(wasm.wt_generate_cert(commonName, 14, notBefore())) as {
		certPem: string;
		keyPem: string;
		hashBase64: string;
	};
}

function generatedChain(commonName: string) {
	const parsed = JSON.parse(
		wasmTestFfi.wt_generate_ca_signed_cert_for_test(
			commonName,
			14,
			notBefore(),
		),
	) as {
		caPem?: string;
		certPem?: string;
		keyPem?: string;
		error?: string;
	};
	if (parsed.error) throw new Error(`chain generation failed: ${parsed.error}`);
	return parsed as Required<Omit<typeof parsed, "error">>;
}

/**
 * A server holding `chain`'s CA-issued leaf, and a client that trusts only
 * `clientCaPem`, wired back to back over an in-memory relay.
 */
function caTrustedPair(
	chain: { caPem: string; certPem: string; keyPem: string },
	clientCaPem: string,
	serverEvents: WasmSessionEvents = {},
	clientEvents: WasmSessionEvents = {},
) {
	const relay = new InMemoryRelay();
	const parsed = JSON.parse(
		wasmTestFfi.wt_new_server_with_options(
			JSON.stringify({
				addr: "127.0.0.1:4433",
				peerAddr: "127.0.0.1:5544",
				commonName: "localhost",
				validityDays: 14,
				notBeforeUnix: notBefore(),
				certPem: chain.certPem,
				keyPem: chain.keyPem,
				...normalizeWasmEndpointOptions(),
			}),
		),
	) as { eid?: number; error?: string };
	if (parsed.error || parsed.eid == null) {
		throw new Error(`wt_new_server failed: ${parsed.error ?? "unknown"}`);
	}

	let serverEstablished = false;
	let clientEstablished = false;
	let clientClosed: number | null = null;
	const server = WasmEndpoint.adopt(wasm, relay.a, parsed.eid, {
		...serverEvents,
		onEstablished: () => {
			serverEstablished = true;
		},
	});
	const client = WasmEndpoint.createCaVerifiedClient(
		wasm,
		relay.b,
		"127.0.0.1:5544",
		"127.0.0.1:4433",
		clientCaPem,
		{
			...clientEvents,
			onEstablished: () => {
				clientEstablished = true;
			},
			onClosed: (_conn, code) => {
				clientClosed = code;
			},
		},
	);
	const conn = client.connect("localhost");
	return {
		server,
		client,
		conn,
		established: () => serverEstablished && clientEstablished,
		closed: () => clientClosed,
	};
}

async function until(predicate: () => boolean, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
	return predicate();
}

describe.skipIf(!wasmAvailable)("wasm client CA-root trust", () => {
	test("accepts a well-formed CA bundle", () => {
		const relay = new InMemoryRelay();
		const ca = generatedCert("ca.example");
		const endpoint = WasmEndpoint.createCaVerifiedClient(
			wasm,
			relay.a,
			"127.0.0.1:5544",
			"127.0.0.1:4433",
			ca.certPem,
		);
		expect(endpoint).toBeDefined();
		endpoint.close();
	});

	test("accepts a multi-anchor bundle", () => {
		const relay = new InMemoryRelay();
		const first = generatedCert("ca1.example");
		const second = generatedCert("ca2.example");
		const endpoint = WasmEndpoint.createCaVerifiedClient(
			wasm,
			relay.a,
			"127.0.0.1:5544",
			"127.0.0.1:4433",
			`${first.certPem}\n${second.certPem}`,
		);
		expect(endpoint).toBeDefined();
		endpoint.close();
	});

	test("distinct CA fixtures produce distinct pooled trust identities", async () => {
		const first = generatedChain("localhost");
		const second = generatedChain("other.example");
		const firstKey = wasmPoolKey({
			scheme: "https",
			host: "localhost",
			port: 443,
			serverName: "localhost",
			tlsFingerprint: `ca:${await wasmCaFingerprint(first.caPem)}`,
		});
		const secondKey = wasmPoolKey({
			scheme: "https",
			host: "localhost",
			port: 443,
			serverName: "localhost",
			tlsFingerprint: `ca:${await wasmCaFingerprint(second.caPem)}`,
		});
		expect(firstKey).not.toBe(secondKey);
	});

	test("rejects malformed roots with E_TLS, matching native", () => {
		const relay = new InMemoryRelay();
		const key = generatedCert("key.example").keyPem;
		for (const bad of [
			"not a pem",
			"-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----",
			key,
		]) {
			let thrown: unknown;
			try {
				WasmEndpoint.createCaVerifiedClient(
					wasm,
					relay.a,
					"127.0.0.1:5544",
					"127.0.0.1:4433",
					bad,
				);
			} catch (err) {
				thrown = err;
			}
			expect(thrown).toBeInstanceOf(Error);
			expect((thrown as { code?: string }).code).toBe(E_TLS);
			expect(String(thrown)).toContain("E_TLS");
			// The failure must not be reported as a generic internal error.
			expect(String(thrown)).not.toContain("E_INTERNAL");
		}
	});

	test("connectWasm rejects pinning and CA roots together", async () => {
		const relay = new InMemoryRelay();
		const ca = generatedCert("ca.example");
		await expect(
			connectWasm(
				wasm,
				relay.a,
				"localhost",
				"127.0.0.1:5544",
				"127.0.0.1:4433",
				{ certHashBase64: ca.hashBase64, caPem: ca.certPem },
			),
		).rejects.toThrow(/E_TLS.*mutually exclusive/);
	});

	test("completes a handshake and echoes over a CA-verified chain", async () => {
		const chain = generatedChain("localhost");
		let echo: Uint8Array | null = null;
		let serverRef: WasmEndpoint | null = null;
		const pair = caTrustedPair(
			chain,
			chain.caPem,
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
		serverRef = pair.server;

		expect(await until(pair.established)).toBe(true);

		const stream = pair.client.openStream(pair.conn, 0n, true);
		expect(stream).toBeGreaterThanOrEqual(0);
		pair.client.streamWrite(stream, new TextEncoder().encode("ca-verified"));
		expect(await until(() => echo !== null)).toBe(true);
		expect(new TextDecoder().decode(echo as unknown as Uint8Array)).toBe(
			"ca-verified",
		);

		pair.client.close();
		pair.server.close();
	});

	test("a client trusting a different CA fails the handshake with E_TLS", async () => {
		const chain = generatedChain("localhost");
		const foreign = generatedChain("other.example");
		const pair = caTrustedPair(chain, foreign.caPem);

		expect(await until(() => pair.closed() !== null)).toBe(true);
		expect(pair.established()).toBe(false);
		// unknown_ca (48): the leaf does not chain to the only trusted anchor.
		expect(pair.client.takeLastError()).toBe(
			"E_TLS: handshake failed with TLS alert 48",
		);

		pair.client.close();
		pair.server.close();
	});

	test("an empty trust configuration is refused wasm-side", () => {
		const relay = new InMemoryRelay();
		expect(() =>
			WasmEndpoint.createCaVerifiedClient(
				wasm,
				relay.a,
				"127.0.0.1:5544",
				"127.0.0.1:4433",
				"",
			),
		).toThrow(/certHashesBase64 missing|E_TLS/);
	});
});
