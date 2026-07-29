import { describe, expect, test } from "bun:test";
import { connectWasm } from "../src/backend.js";
import { WasmEndpoint } from "../src/backend-wasm.js";
import { E_TLS } from "../src/errors.js";
import { InMemoryRelay } from "../src/wasm-relay.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";

const wasm = wasmAvailable
	? await loadWasmModule()
	: (null as unknown as Awaited<ReturnType<typeof loadWasmModule>>);

function generatedCert(commonName: string) {
	return JSON.parse(
		wasm.wt_generate_cert(commonName, 14, Math.floor(Date.now() / 1000) - 3600),
	) as { certPem: string; keyPem: string; hashBase64: string };
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
