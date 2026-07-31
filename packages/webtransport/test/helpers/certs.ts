import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export type GeneratedCert = {
	certPem: string;
	keyPem: string;
	cleanup: () => void;
};

function buildSubjectAltName(names: string[]): string {
	return names
		.map((name) => {
			const normalized = name.trim();
			if (
				/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized) ||
				normalized.includes(":")
			) {
				return `IP:${normalized}`;
			}
			return `DNS:${normalized}`;
		})
		.join(",");
}

export function generateCertForNames(
	names: string[],
	days = 30,
	// Leaf key type. "ec" produces an ECDSA P-256 leaf, required for
	// serverCertificateHashes pinning (W3C). Default "rsa" for the many tests
	// that don't pin.
	leafKeyType: "rsa" | "ec" = "rsa",
): GeneratedCert | null {
	if (names.length === 0) return null;
	const dir = mkdtempSync(join(tmpdir(), "webtransport-bun-cert-"));
	const certPath = join(dir, "cert.pem");
	const keyPath = join(dir, "key.pem");
	const caCertPath = join(dir, "ca-cert.pem");
	const caKeyPath = join(dir, "ca-key.pem");
	const csrPath = join(dir, "leaf.csr");
	const extPath = join(dir, "leaf.ext");
	const subjectName = names[0]?.trim() || "localhost";

	try {
		writeFileSync(
			extPath,
			[
				"basicConstraints=critical,CA:FALSE",
				"keyUsage=critical,digitalSignature,keyEncipherment",
				"extendedKeyUsage=serverAuth",
				`subjectAltName=${buildSubjectAltName(names)}`,
			].join("\n"),
		);

		execFileSync("openssl", [
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-sha256",
			"-nodes",
			"-days",
			"30",
			"-keyout",
			caKeyPath,
			"-out",
			caCertPath,
			"-subj",
			"/CN=webtransport-bun test CA",
		]);

		if (leafKeyType === "ec") {
			// OpenSSL 3's `req -newkey ec` emits a PKCS#8 variant that
			// rustls/ring rejects, while ecparam produces the standard SEC1
			// P-256 encoding accepted by the native TLS parser.
			execFileSync("openssl", [
				"ecparam",
				"-name",
				"prime256v1",
				"-genkey",
				"-noout",
				"-out",
				keyPath,
			]);
			execFileSync("openssl", [
				"req",
				"-new",
				"-sha256",
				"-key",
				keyPath,
				"-out",
				csrPath,
				"-subj",
				`/CN=${subjectName}`,
			]);
		} else {
			execFileSync("openssl", [
				"req",
				"-newkey",
				"rsa:2048",
				"-sha256",
				"-nodes",
				"-keyout",
				keyPath,
				"-out",
				csrPath,
				"-subj",
				`/CN=${subjectName}`,
			]);
		}

		execFileSync("openssl", [
			"x509",
			"-req",
			"-in",
			csrPath,
			"-CA",
			caCertPath,
			"-CAkey",
			caKeyPath,
			"-CAcreateserial",
			"-out",
			certPath,
			"-days",
			String(days),
			"-sha256",
			"-extfile",
			extPath,
		]);
		return {
			certPem:
				readFileSync(certPath, "utf-8") + readFileSync(caCertPath, "utf-8"),
			keyPem: readFileSync(keyPath, "utf-8"),
			cleanup: () => {
				rmSync(dir, { recursive: true, force: true });
			},
		};
	} catch {
		rmSync(dir, { recursive: true, force: true });
		return null;
	}
}

export function generateLocalhostCert(): GeneratedCert | null {
	return generateCertForNames(["localhost", "127.0.0.1"]);
}
