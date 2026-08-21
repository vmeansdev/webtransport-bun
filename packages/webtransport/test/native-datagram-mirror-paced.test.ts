/**
 * The paced mirror: `sendDatagramMirrorPaced` and `readMirrorReports`.
 *
 * The pacer knob is read once per process, so this file is written to be run
 * twice. Without `WEBTRANSPORT_PACER_PPS` only the pacer-absent contract runs;
 * with it set (the suite is exercised at
 * `WEBTRANSPORT_PACER_PPS=30000 WEBTRANSPORT_PACER_CLUMP=32`) the scheduled half
 * runs too.
 *
 * What is pinned here is everything the synchronous envelope pins, moved to
 * where a paced call can honestly answer it: admission is a set and not a
 * prefix, transport conditions are reports and never throws, owner scoping and
 * duplicate delivery survive the schedule, the governor's verdict reaches the
 * caller deferred rather than not at all, and the reports ring is bounded and
 * accounts for every failure it was handed.
 *
 * The M1 tests in `native-datagram-mirror.test.ts` are deliberately untouched:
 * `sendDatagramMirror` is not paced, whatever the knob says, and those 15 pass
 * with the knob set — which is the falsifier for that claim.
 */

import { describe, expect, it } from "bun:test";
import { DATAGRAM_MIRROR_MAX } from "../src/datagram-mirror.js";
import {
	createServer,
	E_QUEUE_FULL,
	E_SESSION_CLOSED,
	E_UNSUPPORTED_ARGUMENT,
	WebTransportError,
} from "../src/index.js";
import type {
	ClientSession,
	LimitsOptions,
	MirrorReport,
	ServerSession,
	WebTransportServer,
} from "../src/index.js";
import { nextWithTimeout } from "./helpers/harness.js";
import { connectWithRetry, nextPort } from "./helpers/network.js";

const BASE_PORT = 26_100;
const PORT_SPREAD = 400;

const PACED = (process.env.WEBTRANSPORT_PACER_PPS ?? "") !== "";

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

function payload(marker: number, size = 64): Uint8Array {
	return new Uint8Array(size).fill(marker);
}

/** Pacer counters, or `{}` on an addon/knob that has none. */
function pacerStats(server: WebTransportServer): Record<string, number> {
	const json = server.__pacerStatsJson?.() ?? "{}";
	return (JSON.parse(json).cumulative ?? {}) as Record<string, number>;
}

/**
 * Poll until at least `want` reports have been drained, or the budget runs out.
 *
 * The barrier the paced contract needs and the synchronous one did not: an
 * assertion about outcomes cannot read a counter the schedule has not reached
 * yet, which is precisely what made the knob-on M1 failures rate-dependent.
 */
async function drainReports(
	server: WebTransportServer,
	want: number,
	budgetMs = 5000,
	max?: number,
): Promise<MirrorReport[]> {
	const collected: MirrorReport[] = [];
	const deadline = Date.now() + budgetMs;
	while (collected.length < want && Date.now() < deadline) {
		collected.push(...server.readMirrorReports(max));
		if (collected.length >= want) break;
		await Bun.sleep(10);
	}
	return collected;
}

/** Wait until the schedule has no outstanding work, or the budget runs out. */
async function drainSchedule(
	server: WebTransportServer,
	budgetMs = 5000,
): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		const pending = JSON.parse(server.__pacerStatsJson?.() ?? "{}")
			.pendingTargets as number | undefined;
		if (pending === undefined || pending === 0) return;
		await Bun.sleep(10);
	}
}

describe("paced mirror: without the pacer", () => {
	it.if(!PACED)(
		"P-T0: the paced send refuses with a typed error and the reader stays silent",
		async () => {
			await withSubscribers(1, async ({ server, ids }) => {
				let thrown: unknown;
				try {
					server.sendDatagramMirrorPaced(ids, payload(0xa0));
				} catch (err) {
					thrown = err;
				}
				expect(thrown).toBeInstanceOf(WebTransportError);
				expect((thrown as WebTransportError).code).toBe(E_UNSUPPORTED_ARGUMENT);
				// Refused, not silently served by the inline loop: a caller that
				// asked for the schedule by name must be able to tell it did not
				// get one.
				expect(server.metricsSnapshot().datagramMirrorCalls ?? -1).toBe(0);

				// The reader never throws, whatever the pacer's state.
				expect(server.readMirrorReports()).toEqual([]);
				expect(server.readMirrorReports(8)).toEqual([]);
			});
		},
		20_000,
	);

	it.if(!PACED)(
		"P-T0: argument checks happen before the pacer is ever consulted",
		async () => {
			await withSubscribers(1, async ({ server, ids }) => {
				// TypeError and RangeError, not E_UNSUPPORTED_ARGUMENT: a
				// programming error is a programming error whether or not the
				// schedule exists.
				expect(() =>
					server.sendDatagramMirrorPaced(
						[ids[0] as string, 7 as unknown as string],
						payload(0xa1),
					),
				).toThrow(TypeError);
				expect(() =>
					server.sendDatagramMirrorPaced(ids, "nope" as unknown as Uint8Array),
				).toThrow(TypeError);
				expect(() =>
					server.sendDatagramMirrorPaced(
						new Array<string>(DATAGRAM_MIRROR_MAX + 1).fill(ids[0] as string),
						payload(0xa1),
					),
				).toThrow(RangeError);
				// An empty list is a no-op envelope, not a pacer question.
				expect(server.sendDatagramMirrorPaced([], payload(0xa1))).toEqual({
					admitted: 0,
					refused: [],
				});
			});
		},
		20_000,
	);
});

describe("paced mirror: on the schedule", () => {
	it.if(PACED)(
		"P-T3/P-T2: a bogus id mid-list is admitted like any other and surfaces as a report, never a throw",
		async () => {
			await withSubscribers(3, async ({ server, subscribers, ids }) => {
				server.readMirrorReports();
				const one = payload(0xb1);
				// The bogus id sits in the MIDDLE: the targets after it must
				// travel, which is the set-not-prefix property stated where a
				// paced call can honestly answer it.
				const targets = [
					ids[0] as string,
					"no-such-session",
					ids[1] as string,
					ids[2] as string,
				];
				const admission = server.sendDatagramMirrorPaced(targets, one);
				expect(admission.admitted).toBe(4);
				expect(admission.refused).toEqual([]);
				expect(admission).not.toHaveProperty("sent");

				// Every live subscriber received, including the two after the
				// bogus id.
				for (const s of subscribers) {
					const next = await nextWithTimeout(s.toClient, 5000, "paced set");
					expect(next.value).toEqual(one);
				}

				const reports = await drainReports(server, 1);
				expect(reports.length).toBe(1);
				expect(reports[0]?.target).toBe("no-such-session");
				expect(reports[0]?.error).toBeInstanceOf(WebTransportError);
				expect(reports[0]?.error.code).toBe(E_SESSION_CLOSED);
			});
		},
		30_000,
	);

	it.if(PACED)(
		"P-T6: a target owned by another server receives nothing, and says so out of band",
		async () => {
			await withSubscribers(1, async ({ server: serverA, ids: idsA }) => {
				await withSubscribers(1, async ({ subscribers: subsB, ids: idsB }) => {
					serverA.readMirrorReports();
					const foreign = idsB[0] as string;
					const admission = serverA.sendDatagramMirrorPaced(
						[idsA[0] as string, foreign],
						payload(0xb2),
					);
					expect(admission.admitted).toBe(2);

					const reports = await drainReports(serverA, 1);
					expect(reports.map((r) => r.target)).toEqual([foreign]);
					expect(reports[0]?.error.code).toBe(E_SESSION_CLOSED);

					// The isolation assertion itself is unchanged; only its
					// timing moved behind the drain.
					expect(
						(subsB[0] as Subscriber).server.metricsSnapshot().datagramsOut,
					).toBe(0);
				});
			});
		},
		40_000,
	);

	it.if(PACED)(
		"P-T7: the same id twice is delivered to twice, rate-independently",
		async () => {
			await withSubscribers(1, async ({ server, subscribers, ids }) => {
				server.readMirrorReports();
				const only = subscribers[0] as Subscriber;
				const before = only.server.metricsSnapshot().datagramsOut;
				const one = payload(0xb3);

				const admission = server.sendDatagramMirrorPaced(
					[ids[0] as string, ids[0] as string],
					one,
				);
				expect(admission.admitted).toBe(2);

				// The drain barrier is what makes this rate-independent: the
				// counter is read once the schedule has nothing outstanding,
				// not at whatever instant the call returned.
				await drainSchedule(server);
				expect(only.server.metricsSnapshot().datagramsOut - before).toBe(2);
				expect(server.readMirrorReports()).toEqual([]);

				for (let i = 0; i < 2; i += 1) {
					const next = await nextWithTimeout(
						only.toClient,
						5000,
						"paced duplicate",
					);
					expect(next.value).toEqual(one);
				}
			});
		},
		30_000,
	);

	it.if(PACED)(
		"P-T5: a starved governor is admitted and then reported, every target of it",
		async () => {
			const size = 256;
			await withSubscribers(
				3,
				async ({ server, ids }) => {
					server.readMirrorReports();
					const started = performance.now();
					const admission = server.sendDatagramMirrorPaced(
						ids,
						payload(0xb4, size),
					);
					// Admission is honest about what it knows: it took them.
					// The governor's verdict is not knowable here, and the API
					// no longer pretends otherwise.
					expect(admission.admitted).toBe(3);
					expect(performance.now() - started).toBeLessThan(1000);

					const reports = await drainReports(server, 3);
					expect(reports.length).toBe(3);
					expect(reports.map((r) => r.error.code)).toEqual([
						E_QUEUE_FULL,
						E_QUEUE_FULL,
						E_QUEUE_FULL,
					]);
					// The retry list survives, deferred: these are the ids to
					// feed to `session.sendDatagram()`.
					expect(reports.map((r) => r.target).sort()).toEqual([...ids].sort());
				},
				{
					maxDatagramSize: 1200,
					maxQueuedBytesGlobal: size - 1,
					maxQueuedBytesPerSession: size - 1,
					backpressureTimeoutMs: 5000,
				},
			);
		},
		30_000,
	);

	it.if(PACED)(
		"P-R1: the ring drains oldest-first, respects max, and empties",
		async () => {
			await withSubscribers(1, async ({ server, ids }) => {
				server.readMirrorReports();
				// Three distinguishable dead targets in submission order, with a
				// live one between them so the ordering is of reports and not of
				// the target list.
				const admission = server.sendDatagramMirrorPaced(
					["gone-a", ids[0] as string, "gone-b", "gone-c"],
					payload(0xb5),
				);
				expect(admission.admitted).toBe(4);

				const first = await drainReports(server, 2, 5000, 2);
				expect(first.map((r) => r.target)).toEqual(["gone-a", "gone-b"]);
				const rest = await drainReports(server, 1, 5000, 8);
				expect(rest.map((r) => r.target)).toEqual(["gone-c"]);
				expect(server.readMirrorReports()).toEqual([]);
				expect(server.readMirrorReports(0)).toEqual([]);
			});
		},
		30_000,
	);

	it.if(PACED)(
		"P-R2: overflow drops oldest and counts it, and drained + dropped equals deferredFailures",
		async () => {
			await withSubscribers(1, async ({ server }) => {
				server.readMirrorReports();
				const statsBefore = pacerStats(server);
				const droppedBefore =
					server.metricsSnapshot().mirrorReportsDropped ?? 0;

				// One call, every target dead: the queue bound decides how many
				// are admitted and every admitted one becomes a report, which is
				// the cheapest way to overrun a 4,096-entry ring.
				const targets = Array.from(
					{ length: DATAGRAM_MIRROR_MAX },
					(_, i) => `absent-${i}`,
				);
				const admission = server.sendDatagramMirrorPaced(
					targets,
					payload(0xb6),
				);
				expect(admission.admitted + admission.refused.length).toBe(
					targets.length,
				);
				// Refusal at admission is its own signal, distinct from the
				// E_QUEUE_FULL reports a starved target produces later.
				for (const refusal of admission.refused) {
					expect(refusal.error.code).toBe(E_QUEUE_FULL);
					expect(targets[refusal.index]).toBe(refusal.target);
				}

				await drainSchedule(server, 30_000);
				const drained: MirrorReport[] = [];
				const deadline = Date.now() + 10_000;
				for (;;) {
					const batch = server.readMirrorReports();
					drained.push(...batch);
					const failures =
						(pacerStats(server).deferredFailures ?? 0) -
						(statsBefore.deferredFailures ?? 0);
					const dropped =
						(server.metricsSnapshot().mirrorReportsDropped ?? 0) -
						droppedBefore;
					if (
						drained.length + dropped >= failures &&
						failures >= admission.admitted
					) {
						break;
					}
					if (Date.now() > deadline) break;
					await Bun.sleep(20);
				}

				const failures =
					(pacerStats(server).deferredFailures ?? 0) -
					(statsBefore.deferredFailures ?? 0);
				const dropped =
					(server.metricsSnapshot().mirrorReportsDropped ?? 0) - droppedBefore;
				expect(failures).toBe(admission.admitted);
				expect(dropped).toBeGreaterThan(0);
				// The falsifier for the reporting path: a report that is neither
				// handed over nor counted as lost means the path is lying.
				expect(drained.length + dropped).toBe(failures);
				// Bounded by construction, not by how promptly the caller polled.
				expect(drained.length).toBeLessThanOrEqual(4096);
			});
		},
		90_000,
	);

	it.if(PACED)(
		"P-T9: the paced call counts itself and leaves both neighbouring meters alone",
		async () => {
			await withSubscribers(2, async ({ server, ids }) => {
				server.readMirrorReports();
				const before = server.metricsSnapshot();
				expect(before.datagramMirrorPacedCalls).toBe(0);
				expect(before.datagramMirrorPacedTargets).toBe(0);
				const asyncBefore = before.datagramSendsAsync ?? 0;

				server.sendDatagramMirrorPaced([...ids, "absent"], payload(0xb7));

				const after = server.metricsSnapshot();
				expect(after.datagramMirrorPacedCalls).toBe(1);
				expect(after.datagramMirrorPacedTargets).toBe(3);
				// The synchronous mirror's meter must not move: they are two
				// paths and two counters on purpose.
				expect(after.datagramMirrorCalls).toBe(0);
				expect(after.datagramMirrorTargets).toBe(0);
				// No promise was handed to JavaScript here either.
				expect(after.datagramSendsAsync ?? 0).toBe(asyncBefore);

				await drainReports(server, 1);
			});
		},
		30_000,
	);
});
