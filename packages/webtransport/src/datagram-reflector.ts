/**
 * The per-server datagram reflector's rule: what a datagram must look like
 * to be answered in native, and how the answer is built from its bytes.
 *
 * Everything here is the TypeScript half of a double validation. Native
 * re-checks the same bounds, so a raw-addon caller cannot hand the hot path an
 * unchecked offset; this half exists so a programming error throws with a
 * useful message before anything crosses N-API.
 */

export const REFLECTOR_MAX_REPLY_LENGTH = 1200;
export const REFLECTOR_MAX_MATCHES = 8;
export const REFLECTOR_MAX_OPS = 16;

export type ReflectorMatch = { offset: number; bytes: Uint8Array };

export type ReflectorOp =
	| { op: "copy"; from: number; to: number; length: number }
	| { op: "nowNs"; at: number }
	| { op: "holdNs"; at: number }
	| { op: "zero"; at: number; length: number }
	| { op: "set"; at: number; value: number };

export type DatagramReflectorRule = {
	/** Datagrams shorter than this never match. */
	minLength: number;
	/** The reply is the datagram's first `replyLength` bytes, then the ops. */
	replyLength: number;
	/** Every range must equal for the datagram to match. */
	match: readonly ReflectorMatch[];
	/** Applied in order to the reply buffer. All integers little-endian. */
	rewrite: readonly ReflectorOp[];
};

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requireRange(
	label: string,
	start: number,
	length: number,
	bound: number,
): void {
	if (!isNonNegativeInteger(start) || !isNonNegativeInteger(length)) {
		throw new TypeError(
			`setDatagramReflector: ${label} offsets must be non-negative integers`,
		);
	}
	if (length < 1)
		throw new RangeError(
			`setDatagramReflector: ${label} length must be at least 1`,
		);
	if (start + length > bound) {
		throw new RangeError(
			`setDatagramReflector: ${label} range ${start}..${start + length} exceeds ${bound}`,
		);
	}
}

/** Validate a rule; throws TypeError (shape) or RangeError (bounds). */
export function validateDatagramReflectorRule(
	rule: DatagramReflectorRule,
): void {
	if (typeof rule !== "object" || rule === null) {
		throw new TypeError("setDatagramReflector expects a rule object or null");
	}
	if (
		!isNonNegativeInteger(rule.minLength) ||
		!isNonNegativeInteger(rule.replyLength)
	) {
		throw new TypeError(
			"setDatagramReflector: minLength and replyLength must be non-negative integers",
		);
	}
	if (rule.replyLength < 1)
		throw new RangeError(
			"setDatagramReflector: replyLength must be at least 1",
		);
	if (rule.replyLength > rule.minLength) {
		throw new RangeError(
			"setDatagramReflector: replyLength must not exceed minLength",
		);
	}
	if (rule.minLength > REFLECTOR_MAX_REPLY_LENGTH) {
		throw new RangeError(
			`setDatagramReflector: minLength must not exceed ${REFLECTOR_MAX_REPLY_LENGTH}`,
		);
	}
	if (
		!Array.isArray(rule.match) ||
		rule.match.length < 1 ||
		rule.match.length > REFLECTOR_MAX_MATCHES
	) {
		throw new TypeError(
			`setDatagramReflector: match needs 1..${REFLECTOR_MAX_MATCHES} entries`,
		);
	}
	for (const m of rule.match) {
		if (!ArrayBuffer.isView(m?.bytes))
			throw new TypeError(
				"setDatagramReflector: match.bytes must be a Uint8Array",
			);
		requireRange("match", m.offset, m.bytes.byteLength, rule.minLength);
	}
	if (!Array.isArray(rule.rewrite) || rule.rewrite.length > REFLECTOR_MAX_OPS) {
		throw new TypeError(
			`setDatagramReflector: rewrite allows at most ${REFLECTOR_MAX_OPS} ops`,
		);
	}
	for (const op of rule.rewrite) {
		switch (op?.op) {
			case "copy":
				requireRange("copy.from", op.from, op.length, rule.replyLength);
				requireRange("copy.to", op.to, op.length, rule.replyLength);
				break;
			case "nowNs":
			case "holdNs":
				requireRange(op.op, op.at, 8, rule.replyLength);
				break;
			case "zero":
				requireRange("zero", op.at, op.length, rule.replyLength);
				break;
			case "set":
				if (!isNonNegativeInteger(op.value))
					throw new TypeError(
						"setDatagramReflector: set.value must be an integer",
					);
				if (op.value > 255)
					throw new RangeError(
						"setDatagramReflector: set.value must be 0..255",
					);
				requireRange("set", op.at, 1, rule.replyLength);
				break;
			default:
				throw new TypeError(
					`setDatagramReflector: unknown op ${String((op as { op?: unknown })?.op)}`,
				);
		}
	}
}

/** The object shape the native `setDatagramReflector` binding takes. */
export function toNativeReflectorRule(rule: DatagramReflectorRule): unknown {
	return {
		minLength: rule.minLength,
		replyLength: rule.replyLength,
		matches: rule.match.map((m) => ({
			offset: m.offset,
			bytes: Array.from(m.bytes),
		})),
		rewrite: rule.rewrite.map((op) => ({
			op: op.op,
			at: "at" in op ? op.at : undefined,
			from: "from" in op ? op.from : undefined,
			to: "to" in op ? op.to : undefined,
			length: "length" in op ? op.length : undefined,
			value: "value" in op ? op.value : undefined,
		})),
	};
}

/** Native raises its re-validation as a message-prefixed error; restore the constructor. */
export function mapReflectorError(error: unknown): unknown {
	const message = error instanceof Error ? error.message : String(error);
	const range = message.indexOf("RangeError: ");
	if (range !== -1) return new RangeError(message.slice(range + 12));
	const type = message.indexOf("TypeError: ");
	if (type !== -1) return new TypeError(message.slice(type + 11));
	return error;
}

/** Validate, convert, and install. `null` clears. Never throws for a transport condition. */
export function datagramReflectorRuleChecked(
	install: (native: unknown) => void,
	rule: DatagramReflectorRule | null,
): void {
	if (rule === null) {
		install(null);
		return;
	}
	validateDatagramReflectorRule(rule);
	try {
		install(toNativeReflectorRule(rule));
	} catch (error) {
		throw mapReflectorError(error);
	}
}

/**
 * Reference semantics of the native hot path, in TypeScript. Used by tests
 * and by harnesses that want to know what a rule would produce; it is not on
 * any send or receive path.
 */
export function applyDatagramReflectorRule(
	datagram: Uint8Array,
	rule: DatagramReflectorRule,
	nowNs: bigint,
	holdNs: bigint,
): Uint8Array | null {
	if (datagram.byteLength < rule.minLength) return null;
	for (const m of rule.match) {
		for (let i = 0; i < m.bytes.byteLength; i += 1) {
			if (datagram[m.offset + i] !== m.bytes[i]) return null;
		}
	}
	const reply = datagram.slice(0, rule.replyLength);
	const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
	for (const op of rule.rewrite) {
		switch (op.op) {
			case "copy":
				reply.copyWithin(op.to, op.from, op.from + op.length);
				break;
			case "nowNs":
				view.setBigUint64(op.at, nowNs, true);
				break;
			case "holdNs":
				view.setBigUint64(op.at, holdNs, true);
				break;
			case "zero":
				reply.fill(0, op.at, op.at + op.length);
				break;
			case "set":
				reply[op.at] = op.value;
				break;
		}
	}
	return reply;
}
