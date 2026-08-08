// Endpoint-level client pool for the wasm backend (docs/SPEC.md "Pooling
// Semantics (allowPooling)"). Pools `WasmTransportManager` instances (UDP
// socket + TLS config) keyed by compatibility dimensions; each connect still
// opens its own QUIC connection (Endpoint pooling, not connection/session
// pooling).

import type { WasmTransportManager } from "./backend.js";

/** Dimensions that must match for two connects to share a pooled endpoint. */
export type WasmPoolKeyInput = {
	scheme: string;
	host: string;
	port: number;
	serverName?: string;
	requireUnreliable?: boolean;
	congestionControl?: "default" | "throughput" | "low-latency";
	/** e.g. `"accept-any"` or the pinned `certHashBase64`. */
	tlsFingerprint: string;
};

/** SHA-256 identity for a custom CA bundle, used as a pool trust-domain key. */
export async function wasmCaFingerprint(caPem: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(caPem),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Stable string key for {@link WasmPoolKeyInput}, safe as a Map key. */
export function wasmPoolKey(input: WasmPoolKeyInput): string {
	return [
		input.scheme,
		input.host,
		input.port,
		input.serverName ?? input.host,
		input.requireUnreliable === true,
		input.congestionControl ?? "default",
		input.tlsFingerprint,
	].join("|");
}

export type WasmPoolMetrics = {
	hits: number;
	misses: number;
	evictions: number;
	/** Number of endpoints currently resident in the pool. */
	size: number;
};

const MAX_POOL_SIZE = 32;

const pool = new Map<string, WasmTransportManager>();
let hits = 0;
let misses = 0;
let evictions = 0;

/**
 * Look up the pooled endpoint for `key`. On a hit, moves it to
 * most-recently-used (Map insertion order backs the LRU eviction in
 * {@link wasmPoolPut}). Records a hit/miss either way.
 */
export function wasmPoolTake(key: string): WasmTransportManager | undefined {
	const mgr = pool.get(key);
	if (mgr === undefined) {
		misses++;
		return undefined;
	}
	hits++;
	pool.delete(key);
	pool.set(key, mgr);
	return mgr;
}

/**
 * Insert a freshly created endpoint into the pool (call only after a
 * {@link wasmPoolTake} miss). Evicts the least-recently-used entry once the
 * pool exceeds {@link MAX_POOL_SIZE}.
 */
export function wasmPoolPut(key: string, manager: WasmTransportManager): void {
	pool.set(key, manager);
	while (pool.size > MAX_POOL_SIZE) {
		const oldestKey = pool.keys().next().value;
		if (oldestKey === undefined) break;
		const oldest = pool.get(oldestKey);
		pool.delete(oldestKey);
		evictions++;
		try {
			void oldest?.close();
		} catch {
			/* best-effort */
		}
	}
}

/** Client pool metrics (hits, misses, evictions). Mirrors native `clientPoolMetricsSnapshot`. */
export function wasmClientPoolMetricsSnapshot(): WasmPoolMetrics {
	return { hits, misses, evictions, size: pool.size };
}

/** Test-only: close every pooled endpoint and reset counters to a clean slate. */
export function __resetWasmClientPoolForTests(): void {
	for (const mgr of pool.values()) {
		try {
			void mgr.close();
		} catch {
			/* best-effort */
		}
	}
	pool.clear();
	hits = 0;
	misses = 0;
	evictions = 0;
}
