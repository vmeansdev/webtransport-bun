import { isIP } from "node:net";

/**
 * Validates a server `host` and returns it in the form the native bind parses:
 * an IPv4 or IPv6 literal, IPv6 brackets stripped. Returns an error message for
 * anything else, hostnames included: a hostname has no single bind address
 * (`localhost` resolves to `::1` first on macOS), and the native bind used to
 * fall back to `0.0.0.0` for any string it could not parse, exposing the server
 * on every interface.
 */
export function normalizeBindHost(
	host: unknown,
): { host: string } | { error: string } {
	if (typeof host !== "string") {
		return { error: "host must be a string IP address" };
	}
	const bare =
		host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (isIP(bare) === 0) {
		return {
			error: `host must be an IPv4 or IPv6 address, got "${host}"; use "127.0.0.1" or "::1" for loopback, "0.0.0.0" for all IPv4 interfaces, or "::" for all interfaces (IPv4 and IPv6)`,
		};
	}
	return { host: bare };
}
