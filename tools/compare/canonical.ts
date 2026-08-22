import { createHash } from "node:crypto";

export type CanonicalPrimitive = string | number | boolean | null;
export type CanonicalValue =
	| CanonicalPrimitive
	| readonly CanonicalValue[]
	| { readonly [key: string]: CanonicalValue };

function canonicalizeValue(
	value: unknown,
	ancestors: Set<object>,
): CanonicalValue {
	if (value === null) return null;

	switch (typeof value) {
		case "string":
		case "boolean":
			return value;
		case "number":
			if (!Number.isFinite(value)) {
				throw new TypeError("canonical JSON requires finite numbers");
			}
			return value;
		case "undefined":
			throw new TypeError("canonical JSON cannot contain undefined values");
		case "bigint":
		case "function":
		case "symbol":
			throw new TypeError(
				`canonical JSON does not support ${typeof value} values`,
			);
		case "object":
			break;
		default:
			throw new TypeError("canonical JSON encountered an unsupported value");
	}

	if (ancestors.has(value)) {
		throw new TypeError("canonical JSON cannot contain cyclic references");
	}
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const result: CanonicalValue[] = [];
			for (let index = 0; index < value.length; index += 1) {
				if (!(index in value)) {
					throw new TypeError("canonical JSON cannot contain sparse arrays");
				}
				result.push(canonicalizeValue(value[index], ancestors));
			}
			return result;
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError(
				"canonical JSON only supports plain objects and arrays",
			);
		}

		const result: Record<string, CanonicalValue> = Object.create(
			null,
		) as Record<string, CanonicalValue>;
		const record = value as Record<string, unknown>;
		for (const key of Object.keys(record).sort()) {
			result[key] = canonicalizeValue(record[key], ancestors);
		}
		return result;
	} finally {
		ancestors.delete(value);
	}
}

/** Return a deterministic JSON representation with recursively sorted object keys. */
export function canonicalize(value: unknown): CanonicalValue {
	return canonicalizeValue(value, new Set<object>());
}

/** Serialize JSON-compatible data without whitespace or runtime-dependent key order. */
export function canonicalJson(value: unknown): string {
	const encoded = JSON.stringify(canonicalize(value));
	if (encoded === undefined) {
		throw new TypeError("canonical JSON serialization produced no value");
	}
	return encoded;
}

/** Hash the canonical JSON bytes using lowercase SHA-256 hex. */
export function sha256Canonical(value: unknown): string {
	return createHash("sha256")
		.update(canonicalJson(value), "utf8")
		.digest("hex");
}
