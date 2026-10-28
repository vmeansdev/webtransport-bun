/**
 * The one shape check every new options container uses (sink options and
 * framing, egressPacer, quicLb, reusePortSteering, limits, rateLimits).
 *
 * A container must be a plain object: an object literal, or an object whose
 * prototype is `null`. `null`, arrays, functions, boxed primitives and class
 * instances (Map, Date, ...) are rejected, never read as "omitted" or walked
 * for fields. Only `undefined` means "use the default", and callers check that
 * before calling this. Pure: no addon is loaded by importing it.
 */
export function isPlainOptionsObject(
	value: unknown,
): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
