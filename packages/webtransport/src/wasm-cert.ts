// Cert helpers for the wasm backend: generate a short-lived P-256 cert and turn
// its hash into a W3C `serverCertificateHashes` entry for browser clients.

export interface WasmCertModule {
	wt_generate_cert(
		commonName: string,
		validityDays: number,
		notBeforeUnix: number,
	): string;
}

export interface GeneratedCert {
	certPem: string;
	keyPem: string;
	certDerBase64: string;
	hashBase64: string;
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Generate a self-signed P-256 cert via the wasm backend. */
export function generateCert(
	wasm: WasmCertModule,
	commonName = "localhost",
	validityDays = 14,
	notBeforeUnix: number = Math.floor(Date.now() / 1000) - 3600,
): GeneratedCert {
	const json = wasm.wt_generate_cert(commonName, validityDays, notBeforeUnix);
	const parsed = JSON.parse(json) as Partial<GeneratedCert> & {
		error?: string;
	};
	if (parsed.error) throw new Error(`cert generation failed: ${parsed.error}`);
	return parsed as GeneratedCert;
}

/**
 * Build the `serverCertificateHashes` array a browser WebTransport client passes
 * to connect to a server using `cert`.
 */
export function serverCertificateHashes(
	cert: Pick<GeneratedCert, "hashBase64">,
): Array<{ algorithm: "sha-256"; value: Uint8Array }> {
	return [{ algorithm: "sha-256", value: base64ToBytes(cert.hashBase64) }];
}

/**
 * Helper to manage the 14-day P-256 certificate rotation treadmill for wasm servers.
 * Generates a new certificate ahead of expiry and surfaces it for distribution.
 */
export class WasmCertRotator {
	public currentCert: GeneratedCert;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;

	constructor(
		private wasm: WasmCertModule,
		private commonName = "localhost",
		private validityDays = 14,
		/** Callback invoked when a new cert is generated (for server update and hash redistribution). */
		private onRotate: (cert: GeneratedCert) => void,
	) {
		this.currentCert = generateCert(
			this.wasm,
			this.commonName,
			this.validityDays,
		);
		this.scheduleNext();
	}

	private scheduleNext() {
		// Rotate 2 days before the certificate expires.
		const rotateInDays = Math.max(1, this.validityDays - 2);
		const rotateInMs = rotateInDays * 24 * 60 * 60 * 1000;
		this.timer = setTimeout(() => this.rotate(), rotateInMs);
	}

	private rotate() {
		if (this.stopped) return;
		this.currentCert = generateCert(
			this.wasm,
			this.commonName,
			this.validityDays,
		);
		this.onRotate(this.currentCert);
		this.scheduleNext();
	}

	/** Stop the rotation timer. */
	stop() {
		this.stopped = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
}
