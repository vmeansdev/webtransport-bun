/**
 * Helpers for certificate pinning in interop tests.
 * - getCertHashBase64(): SHA-256 over DER certificate (for WebTransport serverCertificateHashes)
 * - getSpkiHashBase64(): SHA-256 over DER SPKI (for Chromium --ignore-certificate-errors-spki-list)
 */
import { X509Certificate, createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	resolveCertDir,
	resolvePublishedMaterialPaths,
} from "./prepare-certs.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CERT_DIR = join(__dirname, "certs");

export function getInteropCertDir(): string {
	if (process.env.WEBTRANSPORT_INTEROP_CERT_DIR) {
		return resolveCertDir();
	}
	return DEFAULT_CERT_DIR;
}

export function getInteropCertPath(): string {
	return resolvePublishedMaterialPaths(getInteropCertDir()).certPath;
}

export function getInteropKeyPath(): string {
	return resolvePublishedMaterialPaths(getInteropCertDir()).keyPath;
}

export function getCertHashBase64(): string {
	const certPath = getInteropCertPath();
	if (!existsSync(certPath)) return "";
	try {
		const cert = new X509Certificate(readFileSync(certPath, "utf-8"));
		return createHash("sha256").update(cert.raw).digest("base64");
	} catch (err) {
		console.warn("cert-hash: failed to compute certificate hash:", err);
		return "";
	}
}

export function getSpkiHashBase64(): string {
	const certPath = getInteropCertPath();
	if (!existsSync(certPath)) return "";
	try {
		const cert = new X509Certificate(readFileSync(certPath, "utf-8"));
		const spki = cert.publicKey.export({ type: "spki", format: "der" });
		return createHash("sha256").update(spki).digest("base64");
	} catch (err) {
		console.warn("cert-hash: failed to compute SPKI hash:", err);
		return "";
	}
}
