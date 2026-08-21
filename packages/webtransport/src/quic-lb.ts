/**
 * QUIC-LB connection IDs: the TS side of the server option and the pure
 * decoders a balancer needs.
 *
 * Written against **draft-ietf-quic-load-balancers-21**, the same revision the
 * native generator is pinned to (`crates/native/src/quic_lb.rs` carries the
 * layout in full). The keyless configuration (§5.3) writes the server ID into
 * the connection ID in the clear:
 *
 * ```text
 * first octet: 3 config-rotation bits + 5 random bits   (§3.1, §3.3)
 * server ID:   serverIdLen octets, >= 1                 (§5.3)
 * nonce:       nonceLen octets, >= 4, random per CID    (§5.4)
 * ```
 *
 * Total length is `1 + serverIdLen + nonceLen`, between 6 and 20 octets.
 *
 * Nothing in this file touches the native addon: the decoders are here so a
 * balancer, an eBPF loader, or a routing test can read a CID without loading a
 * `.node` binary or opening a socket.
 */

/** §5.3: "The server ID length MUST be at least 1 octet." */
const MIN_SERVER_ID_LEN = 1;
/** §5.3: "The nonce length MUST be at least 4 octets." */
const MIN_NONCE_LEN = 4;
/**
 * §5.3: the server ID and nonce lengths MUST sum to 19 octets or less, because
 * QUIC v1 caps connection IDs at 20 and the first octet takes one of them.
 */
const MAX_PLAINTEXT_BLOCK_LEN = 19;
/** §3.2: the reserved config-rotation codepoint, meaning "unroutable". */
const RESERVED_CONFIG_ROTATION = 0b111;

/**
 * Keyless QUIC-LB connection-ID configuration for one server instance.
 *
 * Every instance behind one balancer shares `nonceLen`, the server-ID *length*
 * and `configRotation`, and each carries a distinct `serverId`. Distinct server
 * IDs of equal length cannot collide in the ID portion, so no two instances
 * claim each other's connection IDs.
 */
export type QuicLbOptions = {
	/**
	 * This instance's server ID, 1 to 18 octets. The balancer reads these bytes
	 * out of the connection ID to pick a backend, so they must match the ID this
	 * instance is configured with on the balancer side, byte for byte.
	 */
	serverId: Uint8Array | readonly number[];
	/**
	 * Nonce length in octets, at least 4, with `serverId.length + nonceLen <= 19`.
	 *
	 * **Required, deliberately undefaulted.** Nothing in the connection ID
	 * encodes this length — a balancer learns it from its own configuration. A
	 * silent default here would let the server write one layout while the
	 * balancer decodes another, and the failure would look like random routing
	 * rather than a misconfiguration.
	 */
	nonceLen: number;
	/**
	 * Config-rotation codepoint (§3.1), 0 to 6, default 0. It labels which
	 * QUIC-LB configuration generation issued the connection ID, so a fleet can
	 * roll to new parameters while old connections stay routable under the old
	 * ones. `7` (0b111) is reserved for unroutable connection IDs and is
	 * rejected.
	 */
	configRotation?: number;
};

/**
 * Reads the server ID out of a QUIC-LB connection ID.
 *
 * `serverIdLen` comes from the caller's configuration, never from the wire —
 * nothing in the connection ID encodes it. Returns `null` when the input is too
 * short to hold a first octet plus that many server-ID octets, which is how a
 * caller tells a QUIC-LB connection ID apart from a random one issued by some
 * other endpoint.
 *
 * Callers that route on the configuration generation must also check
 * {@link decodeQuicLbConfigRotation}: a connection ID whose rotation is `7` is
 * unroutable (§3.2) even though its bytes parse.
 *
 * Pure: no addon, no I/O. The returned array is a copy, not a view.
 */
export function decodeQuicLbServerId(
	cid: Uint8Array,
	serverIdLen: number,
): Uint8Array | null {
	if (!Number.isInteger(serverIdLen) || serverIdLen < 1) return null;
	if (cid.length < 1 + serverIdLen) return null;
	return cid.slice(1, 1 + serverIdLen);
}

/**
 * Reads the config-rotation codepoint (§3.1) — the first octet's top three bits
 * — out of a connection ID. Returns `null` for an empty input.
 *
 * A result of `7` means the reserved "unroutable" codepoint (§3.2), not a
 * routable generation.
 */
export function decodeQuicLbConfigRotation(cid: Uint8Array): number | null {
	const first = cid[0];
	return first === undefined ? null : first >> 5;
}

/**
 * The wire length of every connection ID this configuration issues:
 * `1 + serverIdLen + nonceLen`, from 6 to 20 octets.
 */
export function quicLbCidLength(serverIdLen: number, nonceLen: number): number {
	return 1 + serverIdLen + nonceLen;
}

/**
 * Checks a `quicLb` option against every bound of the draft, mirroring
 * `QuicLbConfig::new` in the native crate so a bad configuration is rejected in
 * JS before the addon is touched. Returns the message to throw, or `null` when
 * the configuration is valid. Nothing is clamped: a silently adjusted length
 * would leave the balancer decoding a layout the server does not write.
 */
export function quicLbOptionsError(value: unknown): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return "quicLb must be an object";
	}
	const opts = value as Partial<QuicLbOptions>;

	const rawId = opts.serverId;
	if (!(rawId instanceof Uint8Array) && !Array.isArray(rawId)) {
		return "quicLb.serverId must be a Uint8Array or an array of octets";
	}
	const serverId = Array.from(rawId as ArrayLike<number>);
	for (let i = 0; i < serverId.length; i++) {
		const octet = serverId[i] as number;
		if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
			return `quicLb.serverId[${i}] must be an integer in 0-255`;
		}
	}
	if (serverId.length < MIN_SERVER_ID_LEN) {
		return `quicLb.serverId must be at least ${MIN_SERVER_ID_LEN} octet (draft-ietf-quic-load-balancers-21 §5.3)`;
	}

	const nonceLen = opts.nonceLen;
	if (nonceLen === undefined) {
		return "quicLb.nonceLen is required: a balancer decodes the nonce by configured length, never from the wire";
	}
	if (!Number.isInteger(nonceLen) || (nonceLen as number) < 0) {
		return "quicLb.nonceLen must be a non-negative integer";
	}
	if ((nonceLen as number) < MIN_NONCE_LEN) {
		return `quicLb.nonceLen must be at least ${MIN_NONCE_LEN} octets, got ${nonceLen} (draft-ietf-quic-load-balancers-21 §5.3)`;
	}
	const block = serverId.length + (nonceLen as number);
	if (block > MAX_PLAINTEXT_BLOCK_LEN) {
		return `quicLb.serverId length + nonceLen must be at most ${MAX_PLAINTEXT_BLOCK_LEN} octets, got ${block} (draft-ietf-quic-load-balancers-21 §5.3)`;
	}

	const rotation = opts.configRotation;
	if (rotation !== undefined) {
		if (!Number.isInteger(rotation) || (rotation as number) < 0) {
			return "quicLb.configRotation must be an integer in 0-6";
		}
		if (rotation === RESERVED_CONFIG_ROTATION) {
			return "quicLb.configRotation must not be 0b111, which is reserved for unroutable connection IDs (draft-ietf-quic-load-balancers-21 §3.1, §3.2)";
		}
		if ((rotation as number) > RESERVED_CONFIG_ROTATION) {
			return `quicLb.configRotation must fit in 3 bits (0-6), got ${rotation} (draft-ietf-quic-load-balancers-21 §3.1)`;
		}
	}

	return null;
}

/**
 * The shape the native side parses out of the server-options JSON blob:
 * `serverId` as a plain number array, because a `Uint8Array` does not survive
 * `JSON.stringify` as one.
 */
export function quicLbOptionsToJson(opts: QuicLbOptions): {
	serverId: number[];
	nonceLen: number;
	configRotation: number;
} {
	return {
		serverId: Array.from(opts.serverId as ArrayLike<number>),
		nonceLen: opts.nonceLen,
		configRotation: opts.configRotation ?? 0,
	};
}
