/**
 * Helpers for certificate pinning in interop tests.
 * - getCertHashBase64(): SHA-256 over DER certificate (for WebTransport serverCertificateHashes)
 * - getSpkiHashBase64(): SHA-256 over DER SPKI (for Chromium --ignore-certificate-errors-spki-list)
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
        return createHash("sha256").update(cert.raw).digest("base64");
    } catch {
        return "";
    }
}

export function getSpkiHashBase64(): string {
    if (!existsSync(certPath)) return "";
    try {
        const cert = new X509Certificate(readFileSync(certPath, "utf-8"));
        const spki = cert.publicKey.export({ type: "spki", format: "der" });
        return createHash("sha256").update(spki).digest("base64");
    } catch {
        return "";
    }
}
