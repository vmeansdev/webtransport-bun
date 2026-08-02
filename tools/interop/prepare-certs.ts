#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
	rmSync,
	renameSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CERT_DIR = join(__dirname, "certs");
const LOCK_WAIT_MS = 100;
const LOCK_TIMEOUT_MS = 15_000;
const STALE_LOCK_AGE_MS = 60_000;
const CURRENT_GENERATION_FILE = "current-generation.txt";

function sleep(delayMs: number): Promise<void> {
	return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}

export function resolveCertDir(): string {
	const requested = process.env.WEBTRANSPORT_INTEROP_CERT_DIR;
	return requested ? resolve(requested) : DEFAULT_CERT_DIR;
}

export function resolveOpenSSLExecutable(): string {
	const configured = process.env.WEBTRANSPORT_INTEROP_OPENSSL_PATH;
	const candidates = [
		configured,
		"openssl",
		"/usr/bin/openssl",
		"/opt/homebrew/bin/openssl",
		"/opt/homebrew/opt/openssl@3/bin/openssl",
	].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of candidates) {
		try {
			execFileSync(candidate, ["version"], { stdio: "ignore" });
			return candidate;
		} catch {
			// Try the next deterministic location.
		}
	}
	throw new Error(
		"OpenSSL is required; set WEBTRANSPORT_INTEROP_OPENSSL_PATH to an executable path",
	);
}

function runOpenSSL(args: string[]): Buffer {
	return execFileSync(resolveOpenSSLExecutable(), args, {
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function isLocalhostCertificateSummary(summary: string): boolean {
	const hasSubject =
		summary.includes("CN = localhost") ||
		summary.includes("CN=localhost") ||
		summary.includes("Subject: CN = localhost") ||
		summary.includes("Subject:CN=localhost");
	const hasLocalhostDns = summary.includes("DNS:localhost");
	const hasLoopbackIp =
		summary.includes("IP Address:127.0.0.1") ||
		summary.includes("IP:127.0.0.1");
	return hasSubject && hasLocalhostDns && hasLoopbackIp;
}

function readCertificateSummary(certPath: string): string {
	try {
		return runOpenSSL([
			"x509",
			"-in",
			certPath,
			"-noout",
			"-subject",
			"-ext",
			"subjectAltName",
		]).toString("utf8");
	} catch {
		return runOpenSSL([
			"x509",
			"-in",
			certPath,
			"-noout",
			"-subject",
			"-text",
		]).toString("utf8");
	}
}

function verifyGeneratedMaterial(certPath: string, keyPath: string): void {
	const keySummary = runOpenSSL([
		"pkey",
		"-in",
		keyPath,
		"-text",
		"-noout",
	]).toString("utf8");
	if (
		!keySummary.includes("ASN1 OID: prime256v1") &&
		!keySummary.includes("NIST CURVE: P-256")
	) {
		throw new Error("generated key is not a named-curve P-256 key");
	}

	const certSummary = readCertificateSummary(certPath);
	if (!isLocalhostCertificateSummary(certSummary)) {
		throw new Error("generated certificate is missing localhost SAN entries");
	}

	// The key/SAN checks above accept a certificate regardless of its validity
	// window, so an expired cert on disk would be silently reused. These certs
	// are minted with only 10 days of validity, and Chrome enforces the
	// notBefore..notAfter window for `serverCertificateHashes`, so an expired
	// cert produces an immediate connection failure in the interop suite.
	// `openssl x509 -checkend` exits non-zero — and runOpenSSL therefore throws
	// — when the cert has expired or will expire within the margin, forcing
	// regeneration. The margin comfortably clears any single interop run.
	try {
		runOpenSSL(["x509", "-in", certPath, "-checkend", "3600", "-noout"]);
	} catch {
		throw new Error("certificate is expired or expiring within the hour");
	}
}

type InteropMaterialPaths = {
	certDir: string;
	certPath: string;
	keyPath: string;
};

function buildMaterialPaths(certDir: string): InteropMaterialPaths {
	return {
		certDir,
		certPath: join(certDir, "cert.pem"),
		keyPath: join(certDir, "key.pem"),
	};
}

function getCurrentGenerationPath(certDir: string): string {
	return join(certDir, CURRENT_GENERATION_FILE);
}

function readCurrentGeneration(certDir: string): string | null {
	const currentPath = getCurrentGenerationPath(certDir);
	if (!existsSync(currentPath)) {
		return null;
	}
	const generation = readFileSync(currentPath, "utf8").trim();
	return generation.length > 0 ? generation : null;
}

export function resolvePublishedMaterialPaths(
	certDir = resolveCertDir(),
): InteropMaterialPaths {
	const generation = readCurrentGeneration(certDir);
	if (generation) {
		const generationDir = join(certDir, generation);
		const materialPaths = buildMaterialPaths(generationDir);
		if (
			existsSync(materialPaths.certPath) &&
			existsSync(materialPaths.keyPath)
		) {
			return materialPaths;
		}
	}

	return buildMaterialPaths(certDir);
}

function hasValidMaterial(certDir: string): boolean {
	const { certPath, keyPath } = resolvePublishedMaterialPaths(certDir);
	if (!existsSync(certPath) || !existsSync(keyPath)) {
		return false;
	}
	try {
		verifyGeneratedMaterial(certPath, keyPath);
		return true;
	} catch {
		return false;
	}
}

function publishAtomically(certDir: string, tempDir: string): void {
	const generationName = `generation-${Date.now()}-${process.pid}-${Math.random()
		.toString(16)
		.slice(2, 10)}`;
	const generationDir = join(certDir, generationName);
	const stagedCurrentPath = join(certDir, `${CURRENT_GENERATION_FILE}.next`);
	const currentPath = getCurrentGenerationPath(certDir);

	renameSync(tempDir, generationDir);
	writeFileSync(stagedCurrentPath, `${generationName}\n`, "utf8");
	renameSync(stagedCurrentPath, currentPath);
}

function readLockPid(lockDir: string): number | null {
	const ownerPath = join(lockDir, "owner.pid");
	if (!existsSync(ownerPath)) {
		return null;
	}
	const raw = readFileSync(ownerPath, "utf8").trim();
	const pid = Number(raw);
	return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function clearStaleLock(lockDir: string): boolean {
	try {
		const stats = lstatSync(lockDir);
		const ageMs = Date.now() - stats.mtimeMs;
		const ownerPid = readLockPid(lockDir);
		if (ownerPid !== null) {
			if (isPidAlive(ownerPid)) {
				return false;
			}
		} else if (ageMs < STALE_LOCK_AGE_MS) {
			return false;
		}
		rmSync(lockDir, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

async function withPrepLock<T>(
	certDir: string,
	run: () => Promise<T>,
): Promise<T> {
	const lockDir = join(dirname(certDir), `.${basename(certDir)}.lock`);
	const ownerPath = join(lockDir, "owner.pid");
	const deadline = Date.now() + LOCK_TIMEOUT_MS;

	while (true) {
		try {
			mkdirSync(lockDir);
			writeFileSync(ownerPath, `${process.pid}\n`, "utf8");
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}
			clearStaleLock(lockDir);
			if (Date.now() >= deadline) {
				throw new Error(`timed out waiting for cert prep lock: ${lockDir}`);
			}
			await sleep(LOCK_WAIT_MS);
		}
	}

	try {
		return await run();
	} finally {
		rmSync(lockDir, { recursive: true, force: true });
	}
}

export async function ensureInteropCerts(): Promise<void> {
	const certDir = resolveCertDir();
	mkdirSync(certDir, { recursive: true });
	if (hasValidMaterial(certDir)) {
		return;
	}

	await withPrepLock(certDir, async () => {
		if (hasValidMaterial(certDir)) {
			return;
		}
		const tempDir = mkdtempSync(join(certDir, ".pending-"));
		const tempKeyPath = join(tempDir, "key.pem");
		const tempCertPath = join(tempDir, "cert.pem");

		try {
			runOpenSSL([
				"genpkey",
				"-algorithm",
				"EC",
				"-pkeyopt",
				"ec_paramgen_curve:P-256",
				"-pkeyopt",
				"ec_param_enc:named_curve",
				"-out",
				tempKeyPath,
			]);
			runOpenSSL([
				"req",
				"-new",
				"-x509",
				"-key",
				tempKeyPath,
				"-out",
				tempCertPath,
				"-days",
				"10",
				"-subj",
				"/CN=localhost",
				"-addext",
				"subjectAltName = DNS:localhost,IP:127.0.0.1",
			]);

			verifyGeneratedMaterial(tempCertPath, tempKeyPath);
			publishAtomically(certDir, tempDir);
		} finally {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});
}

export const __TESTING__ = {
	clearStaleLock,
	getCurrentGenerationPath,
	hasValidMaterial,
	isLocalhostCertificateSummary,
	publishAtomically,
	resolvePublishedMaterialPaths,
};

if (import.meta.main) {
	await ensureInteropCerts();
	const certDir = resolveCertDir();
	const { certPath, keyPath } = resolvePublishedMaterialPaths(certDir);
	if (!existsSync(certPath) || !existsSync(keyPath)) {
		throw new Error(`interop certs missing after preparation: ${certDir}`);
	}
	const certPreview = readFileSync(certPath, "utf8").split("\n")[0] ?? "";
	console.log(`prepared interop certs in ${certDir} (${certPreview})`);
}
