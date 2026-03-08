/**
 * Cert hash self-checks:
 * - cert hash (DER cert) used for WebTransport serverCertificateHashes
 * - SPKI hash used for Chromium --ignore-certificate-errors-spki-list
 */
import { test, expect } from "@playwright/test";
import { getCertHashBase64, getSpkiHashBase64 } from "../cert-hash.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const certPath = join(__dirname, "..", "certs", "cert.pem");

function openssl(args: string[], input?: Buffer): Buffer {
	return execFileSync("openssl", args, {
		input,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function opensslSpkiHashBase64(path: string): string {
	const pubkeyPem = openssl(["x509", "-in", path, "-noout", "-pubkey"]);
	const spkiDer = openssl(["pkey", "-pubin", "-outform", "DER"], pubkeyPem);
	return createHash("sha256").update(spkiDer).digest("base64");
}

function opensslCertHashBase64(path: string): string {
	const certDer = openssl(["x509", "-in", path, "-outform", "DER"]);
	return createHash("sha256").update(certDer).digest("base64");
}

test("SPKI hash matches openssl SPKI hash", () => {
	if (!existsSync(certPath)) {
		test.skip(true, "Run prepare:interop to generate certs");
		return;
	}
	const jsHash = getSpkiHashBase64();
	expect(jsHash).toBeTruthy();
	const opensslHash = opensslSpkiHashBase64(certPath);
	expect(jsHash).toBe(opensslHash);
});

test("certificate hash matches openssl DER certificate hash", () => {
	if (!existsSync(certPath)) {
		test.skip(true, "Run prepare:interop to generate certs");
		return;
	}
	const jsHash = getCertHashBase64();
	expect(jsHash).toBeTruthy();
	const opensslHash = opensslCertHashBase64(certPath);
	expect(jsHash).toBe(opensslHash);
});
