/**
 * The mirror send: one payload, many sessions, one crossing.
 *
 * What is pinned here is everything a caller can observe — the set-not-prefix
 * envelope, owner scoping, duplicates, the cap and its splitting rule, the copy
 * contract, and the metrics. The properties that need a starved governor are
 * driven from the public `limits` options rather than from Rust, because the
 * mirror never parks: a budget that cannot fit the payload is an immediate
 * failure entry, which is exactly what makes it testable from here.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	DATAGRAM_MIRROR_MAX,
	MIRROR_FAILURE_CODES,
} from "../src/datagram-mirror.js";
import {
	createServer,
	E_QUEUE_FULL,
	E_SESSION_CLOSED,
	WebTransportError,
} from "../src/index.js";
import type {
	ClientSession,
	LimitsOptions,
	ServerSession,
	WebTransportServer,
} from "../src/index.js";
import { nextWithTimeout } from "./helpers/harness.js";
import { connectWithRetry, nextPort } from "./helpers/network.js";

const BASE_PORT = 25_600;
const PORT_SPREAD = 400;

type Subscriber = {
	server: ServerSession;
	client: ClientSession;
	toClient: AsyncIterator<Uint8Array>;
};

type Fixture = {
	server: WebTransportServer;
	subscribers: Subscriber[];
	ids: string[];
};

/** A server with `count` connected sessions, torn down whatever the body does. */
async function withSubscribers(
	count: number,
	body: (fixture: Fixture) => Promise<void>,
	limits?: Partial<LimitsOptions>,
): Promise<void> {
	const port = nextPort(BASE_PORT, PORT_SPREAD);
	const accepted: ServerSession[] = [];
	const pending: (((s: ServerSession) => void) | undefined)[] = [];
	const waiters: Promise<ServerSession>[] = [];
	for (let i = 0; i < count; i += 1) {
		const d = Promise.withResolvers<ServerSession>();
		pending.push(d.resolve);
		waiters.push(d.promise);
	}
	const server = createServer({
		port,
		tls: { certPem: "", keyPem: "" },
		...(limits ? { limits } : {}),
		onSession: (s) => {
			const resolve = pending[accepted.length];
			accepted.push(s);
			resolve?.(s);
		},
	});
	const subscribers: Subscriber[] = [];
	try {
		for (let i = 0; i < count; i += 1) {
			const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
			});
			const serverSession = await (waiters[i] as Promise<ServerSession>);
			subscribers.push({
				server: serverSession,
				client,
				toClient: client.incomingDatagrams()[Symbol.asyncIterator](),
			});
		}
		await body({
			server,
			subscribers,
			ids: subscribers.map((s) => s.server.id),
		});
	} finally {
		for (const s of subscribers) {
			await s.toClient.return?.();
			s.client.close();
		}
		await server.close();
	}
}

/** Read `count` datagrams, failing rather than hanging on a short read. */
async function receive(
	iter: AsyncIterator<Uint8Array>,
	count: number,
	label: string,
): Promise<Uint8Array[]> {
	const out: Uint8Array[] = [];
	while (out.length < count) {
		const next = await nextWithTimeout(iter, 5000, label);
		if (next.done || next.value === undefined) break;
		out.push(next.value);
	}
	return out;
}

function payload(marker: number, size = 64): Uint8Array {
	return new Uint8Array(size).fill(marker);
}

describe("mirror send: the envelope", () => {
	it("M-T1: a mirror of one is the single-datagram send — same bytes, same datagramsOut delta", async () => {
		await withSubscribers(1, async ({ server, subscribers, ids }) => {
			const only = subscribers[0] as Subscriber;
			const one = payload(0x11);

			const before = only.server.metricsSnapshot().datagramsOut;
			await only.server.sendDatagram(one);
			const midway = only.server.metricsSnapshot().datagramsOut;
			const viaSingle = await receive(only.toClient, 1, "single");

			const mirrored = server.sendDatagramMirror(ids, one);
			expect(mirrored.sent).toBe(1);
			expect(mirrored.failures).toEqual([]);
			const after = only.server.metricsSnapshot().datagramsOut;
			expect(after - midway).toBe(midway - before);

			const viaMirror = await receive(only.toClient, 1, "mirror-of-1");
			expect(viaMirror[0]).toEqual(viaSingle[0] as Uint8Array);
			expect(viaMirror[0]).toEqual(one);
		});
	}, 20_000);

	it("M-T3: the envelope is a set, not a prefix — a dead target at index 0 does not stop the broadcast", async () => {
		await withSubscribers(3, async ({ server, subscribers, ids }) => {
			const one = payload(0x22);

			const leading = server.sendDatagramMirror(
				["no-such-session", ...ids],
				one,
			);
			expect(leading.sent).toBe(3);
			expect(leading.failures.map((f) => f.index)).toEqual([0]);
			expect(leading.failures[0]?.target).toBe("no-such-session");
			for (const s of subscribers) {
				expect(await receive(s.toClient, 1, "after leading failure")).toEqual([
					one,
				]);
			}

			const two = payload(0x23);
			const trailing = server.sendDatagramMirror(
				[ids[0] as string, "gone-a", "gone-b"],
				two,
			);
			expect(trailing.sent).toBe(1);
			expect(trailing.failures.map((f) => f.index)).toEqual([1, 2]);
			expect(
				await receive(
					subscribers[0]?.toClient as AsyncIterator<Uint8Array>,
					1,
					"survivor",
				),
			).toEqual([two]);
		});
	}, 20_000);

	it("M-T2: every transport condition is a failure entry, never a throw", async () => {
		await withSubscribers(2, async ({ server, subscribers, ids }) => {
			const live = ids[0] as string;

			// Unknown id.
			const unknown = server.sendDatagramMirror([live, "nope"], payload(0x31));
			expect(unknown.sent).toBe(1);
			expect(unknown.failures[0]?.error).toBeInstanceOf(WebTransportError);
			expect(unknown.failures[0]?.error.code).toBe(E_SESSION_CLOSED);
			await receive(
				subscribers[0]?.toClient as AsyncIterator<Uint8Array>,
				1,
				"live",
			);

			// Oversize payload: past maxDatagramSize for every target.
			const oversize = server.sendDatagramMirror(ids, payload(0x32, 4096));
			expect(oversize.sent).toBe(0);
			expect(oversize.failures.map((f) => f.error.code)).toEqual([
				E_QUEUE_FULL,
				E_QUEUE_FULL,
			]);

			// A genuinely closed session, once the registry has reaped it.
			(subscribers[1] as Subscriber).client.close();
			let closed = server.sendDatagramMirror([ids[1] as string], payload(0x33));
			const deadline = Date.now() + 5000;
			while (closed.sent === 1 && Date.now() < deadline) {
				await Bun.sleep(25);
				closed = server.sendDatagramMirror([ids[1] as string], payload(0x33));
			}
			expect(closed.sent).toBe(0);
			expect(closed.failures[0]?.error.code).toBe(E_SESSION_CLOSED);
		});
	}, 20_000);

	it("M-T2: the native failure enum and the TypeScript decode table agree and are exhaustive", () => {
		const rust = readFileSync(
			fileURLToPath(
				new URL(
					"../../../crates/native/src/datagram_mirror.rs",
					import.meta.url,
				),
			),
			"utf8",
		);
		const variants = [...rust.matchAll(/^\s{4}(\w+) = (\d+),$/gm)].map((m) => ({
			name: m[1] as string,
			value: Number(m[2]),
		}));
		expect(variants.map((v) => v.name)).toEqual([
			"SessionClosed",
			"QueueFull",
			"WouldBlock",
			"TooManyTargets",
		]);
		// Every native value decodes, and the table carries nothing native never
		// emits: index 0 is the reserved skew slot and stays undefined.
		expect(MIRROR_FAILURE_CODES.length).toBe(variants.length + 1);
		expect(MIRROR_FAILURE_CODES[0]).toBeUndefined();
		for (const variant of variants) {
			expect(MIRROR_FAILURE_CODES[variant.value]).toBeDefined();
		}
	});

	it("M-T4: the payload is copied before the call returns", async () => {
		await withSubscribers(2, async ({ server, subscribers, ids }) => {
			const buf = payload(0x44);
			const original = new Uint8Array(buf);
			const result = server.sendDatagramMirror(ids, buf);
			buf.fill(0x99);
			expect(result.sent).toBe(2);
			for (const s of subscribers) {
				expect(await receive(s.toClient, 1, "copied payload")).toEqual([
					original,
				]);
			}
		});
	}, 20_000);
});

describe("mirror send: scoping, duplicates and the governor", () => {
	it("M-T6: a target owned by another server is reported closed and receives nothing", async () => {
		await withSubscribers(1, async ({ server: serverA, ids: idsA }) => {
			await withSubscribers(1, async ({ subscribers: subsB, ids: idsB }) => {
				const foreign = idsB[0] as string;
				const result = serverA.sendDatagramMirror(
					[idsA[0] as string, foreign],
					payload(0x55),
				);
				expect(result.sent).toBe(1);
				expect(result.failures.map((f) => f.target)).toEqual([foreign]);
				expect(result.failures[0]?.error.code).toBe(E_SESSION_CLOSED);
				// Nothing was sent to it, not merely nothing received: the
				// foreign session's own send counter is the direct evidence.
				await Bun.sleep(250);
				expect(
					(subsB[0] as Subscriber).server.metricsSnapshot().datagramsOut,
				).toBe(0);
			});
		});
	}, 30_000);

	it("M-T7: the same id twice is delivered to twice", async () => {
		await withSubscribers(1, async ({ server, subscribers, ids }) => {
			const only = subscribers[0] as Subscriber;
			const before = only.server.metricsSnapshot().datagramsOut;
			const one = payload(0x66);
			const result = server.sendDatagramMirror(
				[ids[0] as string, ids[0] as string],
				one,
			);
			expect(result.sent).toBe(2);
			expect(only.server.metricsSnapshot().datagramsOut - before).toBe(2);
			expect(await receive(only.toClient, 2, "duplicate targets")).toEqual([
				one,
				one,
			]);
		});
	}, 20_000);

	it("M-T5: a budget too small to fit one payload fails every target promptly instead of parking", async () => {
		const size = 256;
		await withSubscribers(
			3,
			async ({ server, ids }) => {
				const started = performance.now();
				const result = server.sendDatagramMirror(ids, payload(0x77, size));
				const elapsed = performance.now() - started;
				expect(result.sent).toBe(0);
				expect(result.failures.map((f) => f.error.code)).toEqual([
					E_QUEUE_FULL,
					E_QUEUE_FULL,
					E_QUEUE_FULL,
				]);
				// backpressureTimeoutMs is 5 s below; a parking implementation would
				// have spent it (three times over, serially).
				expect(elapsed).toBeLessThan(1000);
			},
			{
				maxDatagramSize: 1200,
				maxQueuedBytesGlobal: size - 1,
				maxQueuedBytesPerSession: size - 1,
				backpressureTimeoutMs: 5000,
			},
		);
	}, 20_000);

	it("M-T5: peak reservation is one payload, not N — a budget of exactly one payload serves the whole fan-out", async () => {
		const size = 256;
		await withSubscribers(
			3,
			async ({ server, subscribers, ids }) => {
				const one = payload(0x78, size);
				const result = server.sendDatagramMirror(ids, one);
				expect(result.failures).toEqual([]);
				expect(result.sent).toBe(3);
				for (const s of subscribers) {
					expect(await receive(s.toClient, 1, "one-payload budget")).toEqual([
						one,
					]);
				}
			},
			{
				maxDatagramSize: 1200,
				maxQueuedBytesGlobal: size,
				maxQueuedBytesPerSession: size,
				backpressureTimeoutMs: 5000,
			},
		);
	}, 20_000);
});

describe("mirror send: the cap", () => {
	it("M-T8: over the cap throws RangeError synchronously and sends nothing", async () => {
		await withSubscribers(1, async ({ server, subscribers, ids }) => {
			const only = subscribers[0] as Subscriber;
			const before = only.server.metricsSnapshot().datagramsOut;
			const tooMany = new Array<string>(DATAGRAM_MIRROR_MAX + 1).fill(
				ids[0] as string,
			);
			expect(() => server.sendDatagramMirror(tooMany, payload(0x81))).toThrow(
				RangeError,
			);
			expect(only.server.metricsSnapshot().datagramsOut).toBe(before);
			expect(server.metricsSnapshot().datagramMirrorCalls ?? -1).toBe(0);
		});
	}, 20_000);

	it("M-T8: at the cap the call is served, and a split list equals the union", async () => {
		await withSubscribers(2, async ({ server, subscribers, ids }) => {
			// The cap itself, mostly unknown ids: the point is that `cap` targets
			// is accepted, not that they all deliver.
			const atCap = new Array<string>(DATAGRAM_MIRROR_MAX).fill("absent");
			atCap[0] = ids[0] as string;
			const capped = server.sendDatagramMirror(atCap, payload(0x82));
			expect(capped.sent).toBe(1);
			expect(capped.failures.length).toBe(DATAGRAM_MIRROR_MAX - 1);
			await receive(
				subscribers[0]?.toClient as AsyncIterator<Uint8Array>,
				1,
				"at cap",
			);

			const union = payload(0x83);
			const whole = server.sendDatagramMirror(ids, union);
			const first = server.sendDatagramMirror([ids[0] as string], union);
			const second = server.sendDatagramMirror([ids[1] as string], union);
			expect(whole.sent).toBe(first.sent + second.sent);
			expect(whole.failures.length).toBe(
				first.failures.length + second.failures.length,
			);
			for (const s of subscribers) {
				expect(await receive(s.toClient, 2, "split equals union")).toEqual([
					union,
					union,
				]);
			}
		});
	}, 30_000);

	it("M-T8: the cap has exactly one native definition, and TypeScript agrees with it", () => {
		const rust = readFileSync(
			fileURLToPath(
				new URL(
					"../../../crates/native/src/datagram_mirror.rs",
					import.meta.url,
				),
			),
			"utf8",
		);
		const declared = [
			...rust.matchAll(/DATAGRAM_MIRROR_MAX:\s*u32\s*=\s*([\d_]+)/g),
		];
		expect(declared.length).toBe(1);
		expect(Number((declared[0]?.[1] as string).replaceAll("_", ""))).toBe(
			DATAGRAM_MIRROR_MAX,
		);
		for (const file of [
			"session.rs",
			"server_napi.rs",
			"session_registry.rs",
		]) {
			const source = readFileSync(
				fileURLToPath(
					new URL(`../../../crates/native/src/${file}`, import.meta.url),
				),
				"utf8",
			);
			expect(source).not.toMatch(/DATAGRAM_MIRROR_MAX:\s*u32\s*=/);
		}
	});

	it("an empty target list is a no-op that still returns the envelope", async () => {
		await withSubscribers(1, async ({ server }) => {
			expect(server.sendDatagramMirror([], payload(0x84))).toEqual({
				sent: 0,
				failures: [],
			});
			expect(server.metricsSnapshot().datagramMirrorCalls ?? -1).toBe(0);
		});
	}, 20_000);

	it("a malformed argument throws TypeError before anything crosses", async () => {
		await withSubscribers(1, async ({ server, ids }) => {
			expect(() =>
				server.sendDatagramMirror(
					[ids[0] as string, 7 as unknown as string],
					payload(0x85),
				),
			).toThrow(TypeError);
			expect(() =>
				server.sendDatagramMirror(ids, "nope" as unknown as Uint8Array),
			).toThrow(TypeError);
			expect(server.metricsSnapshot().datagramMirrorCalls ?? -1).toBe(0);
		});
	}, 20_000);
});

describe("mirror send: metrics", () => {
	it("M-T9: the mirror counts itself and leaves the host-loop exposure meter alone", async () => {
		await withSubscribers(2, async ({ server, subscribers, ids }) => {
			const before = server.metricsSnapshot();
			expect(before.datagramMirrorCalls).toBe(0);
			expect(before.datagramMirrorTargets).toBe(0);
			const asyncBefore = before.datagramSendsAsync ?? 0;
			const perSessionBefore = subscribers.map(
				(s) => s.server.metricsSnapshot().datagramsOut,
			);

			const one = payload(0x91);
			const result = server.sendDatagramMirror([...ids, "absent"], one);
			expect(result.sent).toBe(2);

			const after = server.metricsSnapshot();
			expect(after.datagramMirrorCalls).toBe(1);
			expect(after.datagramMirrorTargets).toBe(3);
			// No promise was handed to JavaScript, so the meter that names that
			// exposure must not move.
			expect(after.datagramSendsAsync ?? 0).toBe(asyncBefore);

			// A mirrored datagram is indistinguishable from a looped one in the
			// per-session counters, which is what a delivery ratio reads.
			subscribers.forEach((s, i) => {
				expect(s.server.metricsSnapshot().datagramsOut).toBe(
					(perSessionBefore[i] as number) + 1,
				);
			});
			for (const s of subscribers) {
				await receive(s.toClient, 1, "metrics delivery");
			}
		});
	}, 20_000);
});
