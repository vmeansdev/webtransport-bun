/**
 * Cert hash self-checks:
 * - cert hash (DER cert) used for WebTransport serverCertificateHashes
 * - SPKI hash used for Chromium --ignore-certificate-errors-spki-list
 */
import { test, expect } from "@playwright/test";
import { getCertHashBase64, getSpkiHashBase64 } from "../cert-hash.js";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const certPath = join(__dirname, "..", "certs", "cert.pem");

test("SPKI hash matches openssl SPKI hash", () => {
	if (!existsSync(certPath)) {
		test.skip(true, "Run prepare:interop to generate certs");
		return;
	}
	const jsHash = getSpkiHashBase64();
	expect(jsHash).toBeTruthy();
	const opensslHash = execSync(
		`openssl x509 -in "${certPath}" -noout -pubkey | openssl pkey -pubin -outform DER 2>/dev/null | openssl dgst -sha256 -binary | base64`,
		{ encoding: "utf-8" },
	).trim();
	expect(jsHash).toBe(opensslHash);
});

test("certificate hash matches openssl DER certificate hash", () => {
	if (!existsSync(certPath)) {
		test.skip(true, "Run prepare:interop to generate certs");
		return;
	}
	const jsHash = getCertHashBase64();
	expect(jsHash).toBeTruthy();
	const opensslHash = execSync(
		`openssl x509 -in "${certPath}" -outform DER | openssl dgst -sha256 -binary | base64`,
		{ encoding: "utf-8" },
	).trim();
	expect(jsHash).toBe(opensslHash);
});
