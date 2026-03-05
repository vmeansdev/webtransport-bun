#!/usr/bin/env bun
/**
 * Cert hash self-check (no browser). Run: bun run check-cert-hash.ts
 * Validates getCertHashBase64() matches openssl certificate DER hash.
 */
import { getCertHashBase64 } from "./cert-hash.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const certDer = execFileSync(
	"openssl",
	["x509", "-in", certPath, "-outform", "DER"],
	{
		stdio: ["pipe", "pipe", "pipe"],
	},
);
const opensslHash = createHash("sha256").update(certDer).digest("base64");
if (jsHash !== opensslHash) {
	console.error("Mismatch: JS", jsHash, "openssl", opensslHash);
	process.exit(1);
}
console.log("cert-hash OK:", jsHash.slice(0, 16) + "...");
