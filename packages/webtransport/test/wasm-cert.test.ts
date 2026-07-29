import { describe, expect, test } from "bun:test";
import {
	generateCert,
	serverCertificateHashes,
	type WasmCertModule,
} from "../src/wasm-cert.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";

interface WasmCertFfiModule extends WasmCertModule {
	wt_new_server(
		addr: string,
		peerAddr: string,
		commonName: string,
		validityDays: number,
		notBeforeUnix: number,
	): string;
	wt_new_server_with_options(configJson: string): string;
	wt_new_client(
		addr: string,
		peerAddr: string,
		certHashesBase64: string,
	): string;
	wt_close_endpoint(eid: number): void;
}

// Soft-skip when pkg is absent (local `bun test packages/`). With
// WEBTRANSPORT_REQUIRE_WASM=1 the helper throws at import time instead.
const wasm = wasmAvailable
	? ((await loadWasmModule()) as unknown as WasmCertFfiModule)
	: (null as unknown as WasmCertFfiModule);

function serverOptions(
	notBeforeUnix: unknown,
	includeTimestamp = true,
): string {
	return JSON.stringify({
		peerAddr: "127.0.0.1:4433",
		commonName: "localhost",
		validityDays: 14,
		...(includeTimestamp ? { notBeforeUnix } : {}),
		limits: {
			maxSessions: 2000,
			maxHandshakesInFlight: 200,
			maxStreamsPerSessionBidi: 200,
			maxStreamsPerSessionUni: 200,
			maxStreamsGlobal: 50000,
			maxDatagramSize: 1200,
			maxQueuedBytesGlobal: 512 * 1024 * 1024,
			maxQueuedBytesPerSession: 2 * 1024 * 1024,
			maxQueuedBytesPerStream: 256 * 1024,
			backpressureTimeoutMs: 5000,
			handshakeTimeoutMs: 10000,
			idleTimeoutMs: 60000,
		},
		rateLimits: {
			handshakesPerSec: 20,
			handshakesBurst: 40,
			streamOpensPerSec: 200,
			streamOpensBurst: 400,
			datagramsIngressPerSec: 2000,
			datagramsIngressBurst: 5000,
		},
	});
}

function b64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
function bytesToB64(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

describe("wasm cert generation (P4)", () => {
	test.skipIf(!wasmAvailable)(
		"generates a P-256 cert whose advertised hash matches SHA-256 of the DER",
		async () => {
			const cert = generateCert(wasm, "localhost", 14);
			expect(cert.certPem).toContain("BEGIN CERTIFICATE");
			expect(cert.keyPem).toContain("BEGIN PRIVATE KEY");
			expect(cert.hashBase64.length).toBeGreaterThan(0);

			// Recompute SHA-256 over the cert DER with the platform crypto and
			// confirm it equals the hash the wasm backend advertised.
			const der = b64ToBytes(cert.certDerBase64);
			const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
			expect(bytesToB64(digest)).toBe(cert.hashBase64);

			// serverCertificateHashes shape is what a browser client expects.
			const hashes = serverCertificateHashes(cert);
			expect(hashes).toHaveLength(1);
			expect(hashes[0]?.algorithm).toBe("sha-256");
			expect(hashes[0]?.value.length).toBe(32);
		},
	);

	test.skipIf(!wasmAvailable)(
		"certificate and registry failures return stable errors without poisoning later constructors",
		() => {
			const notBeforeUnix = Math.floor(Date.now() / 1000) - 60;
			const firstCert = generateCert(wasm, "localhost", 14, notBeforeUnix);
			const firstServer = JSON.parse(
				wasm.wt_new_server(
					"127.0.0.1:0",
					"127.0.0.1:4433",
					"localhost",
					14,
					notBeforeUnix,
				),
			) as { eid?: number; error?: string };
			expect(firstServer.error).toBeUndefined();
			expect(firstServer.eid).toBeGreaterThan(0);

			const invalidTime = JSON.parse(
				wasm.wt_new_server(
					"127.0.0.1:0",
					"127.0.0.1:4433",
					"localhost",
					14,
					Number.NaN,
				),
			) as { error?: string };
			expect(invalidTime.error).toBe(
				"E_INTERNAL: notBeforeUnix must be finite",
			);

			for (const invalidPinValue of ["", "not-base64", btoa("short")]) {
				const invalidPin = JSON.parse(
					wasm.wt_new_client("127.0.0.1:0", "127.0.0.1:4433", invalidPinValue),
				) as { error?: string };
				expect(invalidPin.error).toBe("E_TLS: invalid server certificate hash");
			}

			const secondServer = JSON.parse(
				wasm.wt_new_server(
					"127.0.0.1:0",
					"127.0.0.1:4433",
					"localhost",
					14,
					notBeforeUnix,
				),
			) as { eid?: number; hashBase64?: string; error?: string };
			expect(secondServer.error).toBeUndefined();
			expect(secondServer.eid).toBe((firstServer.eid as number) + 1);

			const client = JSON.parse(
				wasm.wt_new_client(
					"127.0.0.1:0",
					"127.0.0.1:4433",
					secondServer.hashBase64 as string,
				),
			) as { eid?: number; error?: string };
			expect(client.error).toBeUndefined();
			expect(client.eid).toBe((secondServer.eid as number) + 1);

			wasm.wt_close_endpoint(client.eid as number);
			wasm.wt_close_endpoint(secondServer.eid as number);
			wasm.wt_close_endpoint(firstServer.eid as number);
			expect(firstCert.hashBase64).toHaveLength(44);
		},
	);

	test.skipIf(!wasmAvailable)(
		"server options reject missing or malformed certificate timestamps",
		() => {
			const invalidOptions = [
				serverOptions(0, false),
				serverOptions(Number.NaN),
				serverOptions(null),
				serverOptions("yesterday"),
				serverOptions(1.5),
			];

			for (const config of invalidOptions) {
				const result = JSON.parse(wasm.wt_new_server_with_options(config)) as {
					error?: string;
				};
				expect(result.error).toBe(
					"E_INTERNAL: notBeforeUnix must be a finite integer",
				);
			}
		},
	);
});
