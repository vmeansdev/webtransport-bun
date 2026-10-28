import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	productionWtAdapterOptions,
	type FakeWtClientSession,
	LengthPrefixedFrameReader,
} from "./adapters/wt.ts";
import { createWsRoleTransportConnector } from "./bin/fanout-role.ts";
import {
	buildFanoutCohortFixture,
	createManualRelayClock,
	type FanoutFrameCodec,
	FanoutRelay,
	fanoutPayload,
} from "./scenarios/fanout-relay.ts";
import {
	COHORT_CELL_CARDINALITIES,
	COHORT_CONNECTION_RATE_PER_SECOND,
} from "./cohort-protocol.ts";
import {
	decodeFanoutDelivery,
	FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES,
	FANOUT_DELIVERY_MAGIC,
	fanoutDeliveryUnitBytes,
} from "./scenarios/fanout-wire.ts";
import {
	cohortWtListenerAdmission,
	createRelaySettler,
	serveFanoutRelayOverWebTransport,
} from "./server.ts";

let certPem: string;
let keyPem: string;
let certDir: string;

beforeAll(() => {
	certDir = mkdtempSync(join(tmpdir(), "fanout-transport-tls-"));
	const cert = join(certDir, "cert.pem");
	const key = join(certDir, "key.pem");
	const result = Bun.spawnSync([
		"openssl",
		"req",
		"-x509",
		"-newkey",
		"ec",
		"-pkeyopt",
		"ec_paramgen_curve:prime256v1",
		"-nodes",
		"-days",
		"1",
		"-keyout",
		key,
		"-out",
		cert,
		"-subj",
		"/CN=wt-compare.local",
		"-addext",
		"subjectAltName=DNS:wt-compare.local,IP:127.0.0.1",
		"-addext",
		"basicConstraints=critical,CA:FALSE",
	]);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	certPem = readFileSync(cert, "utf8");
	keyPem = readFileSync(key, "utf8");
});
afterAll(() => {
	if (certDir) rmSync(certDir, { recursive: true, force: true });
});

test("ws role connector translates development TLS opt-out for a real listener", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		tls: { cert: certPem, key: keyPem },
		fetch(request, server) {
			return server.upgrade(request)
				? undefined
				: new Response(null, { status: 400 });
		},
		websocket: { message() {} },
	});
	let session:
		| Awaited<
				ReturnType<ReturnType<typeof createWsRoleTransportConnector>["connect"]>
		  >
		| undefined;
	try {
		session = await createWsRoleTransportConnector({
			insecureSkipVerify: true,
		}).connect({
			role: "publisher",
			roleId: "publisher-000000",
			serverHost: "127.0.0.1",
			serverPort: server.port!,
			tlsServerName: "wt-compare.local",
			messageBytes: 100,
			onFrame() {},
			onDelivery() {},
			onMalformed() {},
		});
		expect(session.roleId).toBe("publisher-000000");
	} finally {
		session?.close();
		server.stop(true);
	}
}, 10_000);

test("ws role connector accepts its staged CA and verifies the named server", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		tls: { cert: certPem, key: keyPem },
		fetch(request, server) {
			return server.upgrade(request)
				? undefined
				: new Response(null, { status: 400 });
		},
		websocket: { message() {} },
	});
	let session:
		| Awaited<
				ReturnType<ReturnType<typeof createWsRoleTransportConnector>["connect"]>
		  >
		| undefined;
	try {
		session = await createWsRoleTransportConnector({ caPem: certPem }).connect({
			role: "publisher",
			roleId: "publisher-000000",
			serverHost: "127.0.0.1",
			serverPort: server.port!,
			tlsServerName: "wt-compare.local",
			messageBytes: 100,
			onFrame() {},
			onDelivery() {},
			onMalformed() {},
		});
		expect(session.roleId).toBe("publisher-000000");
		await expect(
			createWsRoleTransportConnector({ caPem: certPem }).connect({
				role: "publisher",
				roleId: "publisher-000001",
				serverHost: "127.0.0.1",
				serverPort: server.port!,
				tlsServerName: "wrong.invalid",
				messageBytes: 100,
				onFrame() {},
				onDelivery() {},
				onMalformed() {},
			}),
		).rejects.toThrow();
	} finally {
		session?.close();
		server.stop(true);
	}
}, 15_000);

test("wt relay admits the ticker's 101 concurrent sessions from one IP and prefix", async () => {
	const fixture = buildFanoutCohortFixture({
		cohortId: "transport-cap-regression",
		publisherCount: 1,
		subscriberCount: 100,
	});
	const relay = new FanoutRelay({
		transport: "wt",
		cohortId: fixture.cohortId,
		cohortGrantSha256: "a".repeat(64),
		cohortWarmupEpochSha256: "b".repeat(64),
		warmupNonce: "c".repeat(64),
		cohortStartBarrierSha256: "d".repeat(64),
		roleTokenCommitmentRootSha256: fixture.roleTokenCommitmentRootSha256,
		roleTokenCommitmentCount: fixture.roleTokenCommitmentCount,
		publishers: fixture.publishers,
		subscriberShards: fixture.subscriberShards,
		expectedSubscriberIds: fixture.expectedSubscriberIds,
		windowCount: 10,
		messageBytes: 100,
		linuxClockId: "linux-test",
		clock: createManualRelayClock(),
	});
	const peer = await serveFanoutRelayOverWebTransport({
		relay,
		hostname: "127.0.0.1",
		port: 0,
		tls: { certPem, keyPem },
	});
	const { clientFactory } = await productionWtAdapterOptions();
	const clients: FakeWtClientSession[] = [];
	const deadline = Date.now() + 20_000;
	try {
		for (let index = 0; index < 101; index++) {
			if (Date.now() >= deadline)
				throw new Error(`session ramp exceeded deadline at ${index}`);
			const client = await clientFactory(peer.url, {
				tls: { caPem: certPem, serverName: "wt-compare.local" },
			});
			clients.push(client);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					client.ready,
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error(`session ${index} missed ramp deadline`)),
							Math.max(1, deadline - Date.now()),
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		}
		expect(clients).toHaveLength(101);
	} finally {
		for (const client of clients) client.close();
		await peer.stop();
	}
}, 30_000);

test("wt listener admission is derived from the registered cohort, every row included", () => {
	// Every row of the frozen D3 table, not a chosen number: the global cap and
	// both host-scoped caps are the registered session count, and the refill is
	// the registered ramp. Nothing here reads a knob. The client-opened stream
	// bucket follows the same rule, because every role session opens exactly
	// one client bidi (its control stream) as it registers: at the registered
	// 500 sessions a second the package's 200/s + 400 default holds 804 tokens
	// for chat 1k's 1,010 control streams and resets the rest, so the one
	// bucket a cohort actually charges would be the only one not derived from
	// the cohort.
	for (const row of COHORT_CELL_CARDINALITIES) {
		expect(
			cohortWtListenerAdmission({
				publisherCount: row.publisherCount,
				subscriberCount: row.subscriberCount,
			}),
		).toEqual({
			maxSessions: row.sessionCount,
			handshakesPerSec: COHORT_CONNECTION_RATE_PER_SECOND,
			handshakesBurst: row.sessionCount,
			handshakesBurstPerPrefix: row.sessionCount,
			streamsPerSec: COHORT_CONNECTION_RATE_PER_SECOND,
			streamsBurst: row.sessionCount,
		});
	}
	// A cardinality outside the table derives the same way: the rule reads the
	// registered counts, never a row.
	expect(
		cohortWtListenerAdmission({ publisherCount: 10, subscriberCount: 10_000 })
			.maxSessions,
	).toBe(10_010);
	expect(() =>
		cohortWtListenerAdmission({ publisherCount: 0, subscriberCount: 8 }),
	).toThrow(RangeError);
});

test("wt relay refuses the session past the derived per-IP and per-prefix caps", async () => {
	// One publisher and eight subscribers is nine sessions; the tenth from the
	// same loopback address is over the per-IP counter, the per-/24 counter and
	// the global cap alike (all three are the same derived number, and the native
	// server charges the two host-scoped counters before the global one). A
	// second address inside one /24 would separate the prefix counter from the
	// per-IP one; this host has only 127.0.0.1 on lo0, so that split is proved
	// by the limiter's own unit test (crates/native/src/rate_limit.rs:395-397).
	const fixture = buildFanoutCohortFixture({
		cohortId: "transport-cap-plus-one",
		publisherCount: 1,
		subscriberCount: 8,
	});
	const admission = cohortWtListenerAdmission({
		publisherCount: 1,
		subscriberCount: 8,
	});
	expect(admission.maxSessions).toBe(9);
	const relay = new FanoutRelay({
		transport: "wt",
		cohortId: fixture.cohortId,
		cohortGrantSha256: "a".repeat(64),
		cohortWarmupEpochSha256: "b".repeat(64),
		warmupNonce: "c".repeat(64),
		cohortStartBarrierSha256: "d".repeat(64),
		roleTokenCommitmentRootSha256: fixture.roleTokenCommitmentRootSha256,
		roleTokenCommitmentCount: fixture.roleTokenCommitmentCount,
		publishers: fixture.publishers,
		subscriberShards: fixture.subscriberShards,
		expectedSubscriberIds: fixture.expectedSubscriberIds,
		windowCount: 10,
		messageBytes: 100,
		linuxClockId: "linux-test",
		clock: createManualRelayClock(),
	});
	const peer = await serveFanoutRelayOverWebTransport({
		relay,
		hostname: "127.0.0.1",
		port: 0,
		tls: { certPem, keyPem },
	});
	const { clientFactory } = await productionWtAdapterOptions();
	const clients: FakeWtClientSession[] = [];
	try {
		for (let index = 0; index < admission.maxSessions; index++) {
			const client = await clientFactory(peer.url, {
				tls: { caPem: certPem, serverName: "wt-compare.local" },
			});
			clients.push(client);
			await client.ready;
		}
		// The package surfaces the server's refusal either as a rejected connect
		// (E_RATE_LIMITED) or as a session that never becomes ready; both are the
		// cap, and only "ready" would be the cap not holding.
		const outcome = await Promise.race([
			clientFactory(peer.url, {
				tls: { caPem: certPem, serverName: "wt-compare.local" },
			}).then(
				(extra) => {
					clients.push(extra);
					return Promise.race([
						extra.ready.then(
							() => "ready" as const,
							() => "refused" as const,
						),
						extra.closed.then(
							() => "closed" as const,
							() => "closed" as const,
						),
					]);
				},
				(error: unknown) =>
					String((error as { code?: unknown })?.code) === "E_RATE_LIMITED"
						? ("refused" as const)
						: ("other-error" as const),
			),
			new Promise<"timeout">((resolve) =>
				setTimeout(() => resolve("timeout"), 15_000),
			),
		]);
		expect(["refused", "closed"]).toContain(outcome);
	} finally {
		for (const client of clients) client.close();
		await peer.stop();
	}
}, 30_000);

// ---------------------------------------------------------------------------
// The host's settler: one bounded round per turn until the relay is quiescent
// ---------------------------------------------------------------------------

/** A relay whose one round moves at most `perRound` of what is queued. */
function boundedRelay(queued: number, perRound: number) {
	let remaining = queued;
	let rounds = 0;
	let blocked = false;
	return {
		pump: () => {
			rounds += 1;
			if (blocked) return;
			remaining = Math.max(0, remaining - perRound);
		},
		counters: () => ({ queuedItems: remaining }),
		rounds: () => rounds,
		block: () => {
			blocked = true;
		},
		enqueue: (count: number) => {
			remaining += count;
		},
	};
}

const turn = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

test("the settler pumps a wider-than-one-round cohort to quiescence across turns", async () => {
	// 1,000 queued deliveries, 256 per round (`RELAY_MAX_CONCURRENT_WRITES`):
	// four rounds, none of them inside the caller's turn, and no fifth.
	const relay = boundedRelay(1_000, 256);
	const settler = createRelaySettler(relay);
	settler.settle();
	expect(relay.rounds()).toBe(0);
	expect(relay.counters().queuedItems).toBe(1_000);
	for (let i = 0; i < 8 && relay.counters().queuedItems > 0; i += 1) {
		await turn();
	}
	expect(relay.counters().queuedItems).toBe(0);
	expect(relay.rounds()).toBe(4);
	await turn();
	expect(relay.rounds()).toBe(4);
});

test("a round that moves nothing disarms the settler until the host settles again", async () => {
	// Every serviced subscriber would block: the round moves nothing, so the
	// settler stops rather than spin; the transport's drain is what brings it
	// back, by calling `settle` again.
	const relay = boundedRelay(300, 256);
	const settler = createRelaySettler(relay);
	relay.block();
	settler.settle();
	await turn();
	await turn();
	expect(relay.rounds()).toBe(1);
	expect(relay.counters().queuedItems).toBe(300);
	settler.settle();
	settler.settle();
	await turn();
	expect(relay.rounds()).toBe(2);
});

test("settle is idempotent while armed, a quiescent relay arms nothing, and stop ends it", async () => {
	const relay = boundedRelay(0, 256);
	const settler = createRelaySettler(relay);
	settler.settle();
	await turn();
	expect(relay.rounds()).toBe(0);
	// Three settles while a blocked round is armed run one round, not three
	// (a blocked round moves nothing, so nothing re-arms and the count is
	// exact).
	relay.enqueue(600);
	relay.block();
	settler.settle();
	settler.settle();
	settler.settle();
	await turn();
	expect(relay.rounds()).toBe(1);
	expect(relay.counters().queuedItems).toBe(600);
	settler.stop();
	settler.settle();
	await turn();
	await turn();
	expect(relay.rounds()).toBe(1);
});

test("the wt peer decodes the frames it reads and never the ones it writes", async () => {
	// Routing an outbound frame through the inbound codec re-parsed it,
	// re-canonicalised it and byte-compared the result against bytes the engine
	// had encoded itself microseconds earlier -- once for every delivery the
	// relay wrote. Measured on the chat-1k loopback acceptance (2026-09-05):
	// 18 us a frame against 1.1 us for the stream write it chose, which is
	// 180 ms of the WT server child's 271 ms of relay work per second of the
	// measured window and 1,110 ms of its 1,804 ms while the warmup fans out,
	// against the 5,000 ms + 1 s ack grace that fanout has to finish in
	// (plan 2026-08-30-busyMs-attested-fanout.md:1202). Decoding is what the
	// peer does to a peer's bytes, once each; the sink only has to route.
	const fixture = buildFanoutCohortFixture({
		cohortId: "wt-outbound-routing",
		publisherCount: 1,
		subscriberCount: 8,
	});
	const grantSha256 = "a".repeat(64);
	const cohortWarmupEpochSha256 = "b".repeat(64);
	const warmupNonce = "c".repeat(64);
	const relay = new FanoutRelay({
		transport: "wt",
		cohortId: fixture.cohortId,
		cohortGrantSha256: grantSha256,
		cohortWarmupEpochSha256,
		warmupNonce,
		cohortStartBarrierSha256: "d".repeat(64),
		roleTokenCommitmentRootSha256: fixture.roleTokenCommitmentRootSha256,
		roleTokenCommitmentCount: fixture.roleTokenCommitmentCount,
		publishers: fixture.publishers,
		subscriberShards: fixture.subscriberShards,
		expectedSubscriberIds: fixture.expectedSubscriberIds,
		windowCount: 10,
		messageBytes: 100,
		linuxClockId: "linux-test",
		clock: createManualRelayClock(),
	});
	const codec = relay.codec;
	let decodes = 0;
	(relay as { codec: FanoutFrameCodec }).codec = {
		transport: codec.transport,
		encode: (frame) => codec.encode(frame),
		decode: (bytes) => {
			decodes += 1;
			return codec.decode(bytes);
		},
	};

	const peer = await serveFanoutRelayOverWebTransport({
		relay,
		hostname: "127.0.0.1",
		port: 0,
		tls: { certPem, keyPem },
	});
	const { clientFactory } = await productionWtAdapterOptions();
	const clients: FakeWtClientSession[] = [];
	const encode = (frame: unknown): Uint8Array => {
		const encoded = codec.encode(frame as never);
		if (!encoded.ok) throw new Error(`encode: ${encoded.code}`);
		return encoded.value;
	};
	try {
		const connect = async (
			role: "publisher" | "subscriber",
			roleId: string,
		): Promise<{
			readonly inbox: unknown[];
			write(bytes: Uint8Array): void;
		}> => {
			const inbox: unknown[] = [];
			const readInto = (
				stream: {
					on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
				},
				channel: "control" | "delivery",
			): void => {
				const frames = new LengthPrefixedFrameReader(
					FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES,
					channel === "delivery"
						? {
								firstByte: FANOUT_DELIVERY_MAGIC,
								unitBytes: fanoutDeliveryUnitBytes(100),
							}
						: undefined,
				);
				stream.on("data", (chunk: Uint8Array) => {
					for (const bytes of frames.push(chunk)) {
						if (bytes[0] === FANOUT_DELIVERY_MAGIC) {
							const delivery = decodeFanoutDelivery(bytes, 100);
							if (!delivery.ok)
								throw new Error(`peer delivery: ${delivery.code}`);
							inbox.push({ kind: "delivery", channel, ...delivery.value });
							continue;
						}
						const read = codec.decode(bytes);
						if (!read.ok) throw new Error(`peer decode: ${read.code}`);
						inbox.push({ ...read.value, channel });
					}
				});
			};
			const client = await clientFactory(peer.url, {
				tls: { caPem: certPem, serverName: "wt-compare.local" },
			});
			clients.push(client);
			await client.ready;
			const control = (await client.createBidirectionalStream()) as unknown as {
				on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
				write(chunk: Uint8Array): boolean;
			};
			readInto(control, "control");
			void (async () => {
				for await (const uni of client.incomingUnidirectionalStreams()) {
					readInto(
						uni as unknown as {
							on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
						},
						"delivery",
					);
				}
			})().catch(() => {
				// The session ended; whatever it delivered before that stands.
			});
			control.write(
				encode({
					schema: "fanout-wire/v1",
					kind: "register",
					cohortGrantSha256: grantSha256,
					transport: "wt",
					role,
					childId: fixture.childIdByRoleId.get(roleId),
					roleId,
					workerIndex: fixture.workerIndexByRoleId.get(roleId) ?? null,
					tokenBase64: fixture.tokenBase64ByRoleId.get(roleId),
					tokenSha256: fixture.tokenSha256ByRoleId.get(roleId),
					tokenCommitmentIndex: fixture.commitmentIndexByRoleId.get(roleId),
					tokenMerkleProofSha256: [
						...(fixture.proofByRoleId.get(roleId) ?? []),
					],
				}),
			);
			return { inbox, write: (bytes) => void control.write(bytes) };
		};

		const publisherId = fixture.publishers[0]?.publisherId as string;
		const subscriberIds = fixture.expectedSubscriberIds;
		const publisher = await connect("publisher", publisherId);
		const subscribers: (typeof publisher)[] = [];
		for (const subscriberId of subscriberIds) {
			subscribers.push(await connect("subscriber", subscriberId));
		}
		const deadline = Date.now() + 15_000;
		const until = async (ready: () => boolean, what: string): Promise<void> => {
			while (!ready()) {
				if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
				relay.pump();
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		};
		await until(
			() =>
				publisher.inbox.length > 0 &&
				subscribers.every((subscriber) => subscriber.inbox.length > 0),
			"an accept for every role",
		);
		// The relay was constructed with its epoch bound, so registration is the
		// only phase left to close before the warmup wire is legal.
		expect(relay.closeRegistration()).toEqual({ ok: true, value: true });

		const payload = fanoutPayload(100, "warmup:0");
		publisher.write(
			encode({
				schema: "fanout-wire/v1",
				kind: "warmup-data",
				direction: "publisher-to-relay",
				cohortGrantSha256: grantSha256,
				cohortWarmupEpochSha256,
				warmupNonce,
				publisherId,
				publisherSequence: 0,
				subscriberId: null,
				linuxAcceptedOrdinal: null,
				payloadBase64: payload.payloadBase64,
				payloadSha256: payload.payloadSha256,
				payloadBytes: 100,
			}),
		);
		await until(
			() => subscribers.every((subscriber) => subscriber.inbox.length > 2),
			"a warmup delivery on each subscriber's uni stream",
		);

		// The delivery channel carried the warmup context and then the compact
		// frame, both on the uni stream; the accept stayed on the control bidi.
		for (const subscriber of subscribers) {
			const units = subscriber.inbox as { kind: string; channel: string }[];
			expect(units.map((unit) => [unit.kind, unit.channel])).toEqual([
				["accept", "control"],
				["delivery-context", "delivery"],
				["delivery", "delivery"],
			]);
		}
		// Ten frames reached the peer: nine registrations and one warmup record.
		// Nine accepts and eight deliveries left it, and none of them was
		// decoded to be routed.
		expect(decodes).toBe(subscriberIds.length + 2);
	} finally {
		for (const client of clients) client.close();
		await peer.stop();
	}
}, 40_000);
