import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DEV_CERT_DIR = resolve(import.meta.dir, "../.certs");

export type ScenarioTls = { certPem: string; keyPem: string; caPem: string };

/**
 * TLS material for the scenario examples.
 *
 * With CERT_PEM, KEY_PEM (and optionally CA_PEM) set to file paths, those
 * files are used: that is how you run an example with a real certificate.
 * Otherwise a throwaway CA and an ECDSA P-256 leaf for localhost, 127.0.0.1
 * and ::1 are generated with openssl and kept in examples/scenarios/.certs/
 * (gitignored), so a server and a client started separately share one CA.
 * Clients trust that CA through `caPem`: certificate verification stays on.
 */
export function scenarioTls(): ScenarioTls {
	const { CERT_PEM, KEY_PEM, CA_PEM } = process.env;
	if (CERT_PEM && KEY_PEM) {
		const certPem = readFileSync(CERT_PEM, "utf8");
		return {
			certPem,
			keyPem: readFileSync(KEY_PEM, "utf8"),
			caPem: CA_PEM ? readFileSync(CA_PEM, "utf8") : certPem,
		};
	}
	const files = ["cert.pem", "key.pem", "ca.pem"].map((f) =>
		join(DEV_CERT_DIR, f),
	);
	const [certPath, keyPath, caPath] = files as [string, string, string];
	if (!files.every((f) => existsSync(f))) {
		const tls = generateDevTls();
		mkdirSync(DEV_CERT_DIR, { recursive: true });
		writeFileSync(certPath, tls.certPem);
		writeFileSync(keyPath, tls.keyPem, { mode: 0o600 });
		writeFileSync(caPath, tls.caPem);
		return tls;
	}
	return {
		certPem: readFileSync(certPath, "utf8"),
		keyPem: readFileSync(keyPath, "utf8"),
		caPem: readFileSync(caPath, "utf8"),
	};
}

export function generateDevTls(): ScenarioTls {
	const dir = mkdtempSync(join(tmpdir(), "wt-scenario-tls-"));
	const path = (name: string) => join(dir, name);
	const ec = [
		"-newkey",
		"ec",
		"-pkeyopt",
		"ec_paramgen_curve:prime256v1",
		"-nodes",
	];
	try {
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				...ec,
				"-days",
				"14",
				"-keyout",
				path("ca.key"),
				"-out",
				path("ca.pem"),
				"-subj",
				"/CN=webtransport-bun scenario CA",
			],
			{ stdio: "ignore" },
		);
		execFileSync(
			"openssl",
			[
				"req",
				...ec,
				"-keyout",
				path("leaf.key"),
				"-out",
				path("leaf.csr"),
				"-subj",
				"/CN=localhost",
			],
			{ stdio: "ignore" },
		);
		writeFileSync(
			path("leaf.ext"),
			[
				"basicConstraints=critical,CA:FALSE",
				"keyUsage=critical,digitalSignature",
				"extendedKeyUsage=serverAuth",
				"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1",
			].join("\n"),
		);
		execFileSync(
			"openssl",
			[
				"x509",
				"-req",
				"-in",
				path("leaf.csr"),
				"-CA",
				path("ca.pem"),
				"-CAkey",
				path("ca.key"),
				"-CAcreateserial",
				"-days",
				"14",
				"-sha256",
				"-extfile",
				path("leaf.ext"),
				"-out",
				path("leaf.pem"),
			],
			{ stdio: "ignore" },
		);
		return {
			certPem: readFileSync(path("leaf.pem"), "utf8"),
			keyPem: readFileSync(path("leaf.key"), "utf8"),
			caPem: readFileSync(path("ca.pem"), "utf8"),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
