#!/usr/bin/env bun
/**
 * Cert hash self-check (no browser). Run: bun run check-cert-hash.ts
 * Validates getCertHashBase64() matches openssl SPKI hash.
 */
import { getCertHashBase64 } from "./cert-hash.js";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const certPath = join(__dirname, "certs", "cert.pem");

if (!existsSync(certPath)) {
	console.error("Run: bun run prepare:interop");
	process.exit(1);
}
const jsHash = getCertHashBase64();
const opensslHash = execSync(
	`openssl x509 -in "${certPath}" -noout -pubkey | openssl pkey -pubin -outform DER 2>/dev/null | openssl dgst -sha256 -binary | base64`,
	{ encoding: "utf-8" },
).trim();
if (jsHash !== opensslHash) {
	console.error("Mismatch: JS", jsHash, "openssl", opensslHash);
	process.exit(1);
}
console.log("cert-hash OK:", jsHash.slice(0, 16) + "...");
