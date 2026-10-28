/**
 * Task 6: TLS identity validation.
 *
 * Verifies that a certificate's fingerprint and SAN match the required
 * values: SHA-256 hex fingerprint, SAN includes the Linux server IP.
 *
 * Private keys never leave Linux. Only the public CA, leaf certificate,
 * and fingerprint return to the Mac controller.
 */

export interface TlsIdentity {
	/** SHA-256 fingerprint of the leaf certificate as 64 lowercase hex characters. */
	readonly fingerprint: string;
	/** Certificate SAN entries, e.g. ["IP:10.99.0.2", "DNS:wt-compare.local"]. */
	readonly san: readonly string[];
}

const FINGERPRINT_REGEX = /^[0-9a-f]{64}$/i;

/**
 * Validate a TLS identity.
 * Throws a descriptive error on any validation failure.
 *
 * @param identity The TLS identity to validate.
 * @param requiredIp Optional: the Linux server IP that must appear in the SAN.
 */
export function validateTlsFingerprint(
	identity: TlsIdentity,
	requiredIp?: string,
): void {
	if (!FINGERPRINT_REGEX.test(identity.fingerprint)) {
		throw new Error(
			`TLS fingerprint is invalid: expected 64 hex characters, got '${identity.fingerprint.slice(0, 16)}...'`,
		);
	}

	if (identity.san.length === 0) {
		throw new Error(
			"TLS identity has an empty SAN list; at least one SAN entry is required",
		);
	}

	if (requiredIp !== undefined) {
		const ipSan = `IP:${requiredIp}`;
		const hasIp = identity.san.some(
			(entry) => entry === ipSan || entry.toLowerCase() === ipSan.toLowerCase(),
		);
		if (!hasIp) {
			throw new Error(
				`TLS SAN does not include required IP address '${requiredIp}'; ` +
					`SAN entries: ${identity.san.join(", ")}`,
			);
		}
	}
}
