/**
 * Compute SHA-256 hash of cert's Subject Public Key Info (for serverCertificateHashes).
 * Uses Node crypto; falls back to empty string if cert missing or crypto fails.
 */
import { X509Certificate, createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const certPath = join(__dirname, "certs", "cert.pem");

export function getCertHashBase64(): string {
    if (!existsSync(certPath)) return "";
    try {
        const cert = new X509Certificate(readFileSync(certPath, "utf-8"));
        const spki = cert.publicKey.export({ type: "spki", format: "der" });
        return createHash("sha256").update(spki).digest("base64");
    } catch {
        return "";
    }
}
