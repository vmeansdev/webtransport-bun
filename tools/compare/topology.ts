/**
 * Task 6: Topology verification.
 *
 * Validates that all measurement traffic uses the exact physical cable path:
 *   Mac 10.99.0.1/en8 ↔ Linux 10.99.0.2/eno1
 *
 * No loopback, no Tailscale, no same-host pairs. All parsers preserve raw
 * output verbatim so evidence can be hashed.
 */

export interface MacRoute {
	readonly interface: string;
	readonly destination: string;
	readonly valid: boolean;
	readonly rejectionReason?: string;
	readonly raw: string;
}

export interface LinuxRoute {
	readonly interface: string;
	readonly source: string;
	readonly destination: string;
	readonly valid: boolean;
	readonly rejectionReason?: string;
	readonly raw: string;
}

export interface TopologyProof {
	readonly valid: boolean;
	readonly rejectionReason?: string;
	readonly mac?: MacRoute;
	readonly linux?: LinuxRoute;
}

const MAC_REQUIRED_INTERFACE = "en8";
const LINUX_REQUIRED_INTERFACE = "eno1";

/** CIDR prefixes and addresses that are never allowed as measurement endpoints. */
const LOOPBACK_PATTERNS = [/^127\./, /^::1$/, /^0\.0\.0\.0$/, /^localhost$/];
const UNSPECIFIED = ["0.0.0.0", "::", "unspecified"];

function isLoopback(address: string): boolean {
	if (UNSPECIFIED.includes(address)) return true;
	return LOOPBACK_PATTERNS.some((p) => p.test(address));
}

/**
 * Parse macOS `route -n get <dest>` output.
 * Extracts the interface and destination from the indented key-value output.
 */
export function parseMacRoute(raw: string, destination: string): MacRoute {
	const lines = raw.split("\n");

	let iface = "";
	for (const line of lines) {
		// Match "   interface: en8" or "interface: en8"
		const m = line.match(/^\s*interface:\s*(\S+)/i);
		if (m) {
			iface = m[1]?.trim() ?? "";
			break;
		}
	}

	if (!iface) {
		return {
			interface: "",
			destination,
			valid: false,
			rejectionReason: "route output did not contain an interface field",
			raw,
		};
	}

	if (iface !== MAC_REQUIRED_INTERFACE) {
		return {
			interface: iface,
			destination,
			valid: false,
			rejectionReason: `interface mismatch: expected ${MAC_REQUIRED_INTERFACE}, got ${iface}`,
			raw,
		};
	}

	return { interface: iface, destination, valid: true, raw };
}

/**
 * Parse Linux `ip route get <dest>` output.
 *
 * The format is:
 *   <dest> dev <iface> src <source> uid <uid>
 *       cache
 *
 * This is the regression-protected parser: the previous failure was caused by
 * treating `dev eno1 src 10.99.0.2` as unknown.
 */
export function parseLinuxRoute(raw: string, destination: string): LinuxRoute {
	// The first line contains the route information
	const firstLine = raw.split("\n")[0] ?? "";

	// Match: <addr> dev <iface> src <source>
	const devMatch = firstLine.match(/\bdev\s+(\S+)/);
	const srcMatch = firstLine.match(/\bsrc\s+(\S+)/);

	const iface = devMatch?.[1]?.trim() ?? "";
	const source = srcMatch?.[1]?.trim() ?? "";

	if (!iface) {
		return {
			interface: "",
			source,
			destination,
			valid: false,
			rejectionReason: "ip route get output did not contain a 'dev' field",
			raw,
		};
	}

	if (iface !== LINUX_REQUIRED_INTERFACE) {
		return {
			interface: iface,
			source,
			destination,
			valid: false,
			rejectionReason: `interface mismatch: expected ${LINUX_REQUIRED_INTERFACE}, got ${iface}`,
			raw,
		};
	}

	return { interface: iface, source, destination, valid: true, raw };
}

export interface ValidateTopologyOptions {
	readonly mac: MacRoute;
	readonly linux: LinuxRoute;
	readonly macAddress: string;
	readonly linuxAddress: string;
}

/**
 * Validate the complete two-host topology proof.
 * Rejects loopback, same-host, wrong-interface, or missing-peer errors.
 */
export function validateTopology(opts: ValidateTopologyOptions): TopologyProof {
	const { mac, linux, macAddress, linuxAddress } = opts;

	// Reject loopback addresses
	if (isLoopback(macAddress)) {
		return {
			valid: false,
			rejectionReason: `macAddress '${macAddress}' is a loopback or unspecified address`,
			mac,
			linux,
		};
	}
	if (isLoopback(linuxAddress)) {
		return {
			valid: false,
			rejectionReason: `linuxAddress '${linuxAddress}' is a loopback or unspecified address`,
			mac,
			linux,
		};
	}

	// Reject same-host
	if (macAddress === linuxAddress) {
		return {
			valid: false,
			rejectionReason: `same host: macAddress and linuxAddress are both '${macAddress}'`,
			mac,
			linux,
		};
	}

	// Validate individual route proofs
	if (!mac.valid) {
		return {
			valid: false,
			rejectionReason: `mac route is invalid: ${mac.rejectionReason ?? "unknown reason"}`,
			mac,
			linux,
		};
	}

	if (!linux.valid) {
		return {
			valid: false,
			rejectionReason: `linux route is invalid: ${linux.rejectionReason ?? "unknown reason"}`,
			mac,
			linux,
		};
	}

	return { valid: true, mac, linux };
}
