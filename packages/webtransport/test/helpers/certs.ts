import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export type GeneratedCert = {
	certPem: string;
	keyPem: string;
	cleanup: () => void;
};

export function generateLocalhostCert(): GeneratedCert | null {
	const dir = mkdtempSync(join(tmpdir(), "webtransport-bun-cert-"));
	const certPath = join(dir, "cert.pem");
	const keyPath = join(dir, "key.pem");
	const caCertPath = join(dir, "ca-cert.pem");
	const caKeyPath = join(dir, "ca-key.pem");
	const csrPath = join(dir, "leaf.csr");
	const extPath = join(dir, "leaf.ext");

	try {
		writeFileSync(
			extPath,
			[
				"basicConstraints=critical,CA:FALSE",
				"keyUsage=critical,digitalSignature,keyEncipherment",
				"extendedKeyUsage=serverAuth",
				"subjectAltName=DNS:localhost,IP:127.0.0.1",
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
			"/CN=localhost",
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
			"30",
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
