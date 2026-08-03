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
	// PEM encoding for the emitted leaf key. openssl writes PKCS#8 ("PRIVATE
	// KEY"); "sec1" re-encodes an EC key as "EC PRIVATE KEY".
	keyFormat: "pkcs8" | "sec1" = "pkcs8",
): GeneratedCert | null {
	if (keyFormat === "sec1" && leafKeyType !== "ec") {
		throw new Error("sec1 key format requires an ec leaf key");
	}
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

		const leafKeyArgs =
			leafKeyType === "ec"
				? ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"]
				: ["-newkey", "rsa:2048"];
		execFileSync("openssl", [
			"req",
			...leafKeyArgs,
			"-sha256",
			"-nodes",
			"-keyout",
			keyPath,
			"-out",
			csrPath,
			"-subj",
			`/CN=${subjectName}`,
		]);

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

		// `openssl ec` writes SEC1 ("EC PRIVATE KEY") by default; go through a
		// separate file so the input is never truncated under the reader.
		const sec1Path = join(dir, "key-sec1.pem");
		if (keyFormat === "sec1") {
			execFileSync("openssl", ["ec", "-in", keyPath, "-out", sec1Path]);
		}
		return {
			certPem:
				readFileSync(certPath, "utf-8") + readFileSync(caCertPath, "utf-8"),
			keyPem: readFileSync(keyFormat === "sec1" ? sec1Path : keyPath, "utf-8"),
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
