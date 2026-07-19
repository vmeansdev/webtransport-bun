import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
	generateCert,
	serverCertificateHashes,
	type WasmCertModule,
} from "../src/wasm-cert.js";

const pkgPath = fileURLToPath(
	new URL("../../../crates/wasm/pkg/webtransport_wasm.js", import.meta.url),
);
const wasmAvailable = existsSync(pkgPath);
const wasm = wasmAvailable
	? ((await import(pkgPath)) as unknown as WasmCertModule)
	: (null as unknown as WasmCertModule);

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
});
