import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	productionWtAdapterOptions,
	type FakeWtClientSession,
} from "./adapters/wt.ts";
import { createWsRoleTransportConnector } from "./bin/fanout-role.ts";
import {
	buildFanoutCohortFixture,
	createManualRelayClock,
	FanoutRelay,
} from "./scenarios/fanout-relay.ts";
import {
	COHORT_CELL_CARDINALITIES,
	COHORT_CONNECTION_RATE_PER_SECOND,
} from "./cohort-protocol.ts";
import {
	cohortWtListenerAdmission,
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
			onFrame() {},
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
			onFrame() {},
		});
		expect(session.roleId).toBe("publisher-000000");
		await expect(
			createWsRoleTransportConnector({ caPem: certPem }).connect({
				role: "publisher",
				roleId: "publisher-000001",
				serverHost: "127.0.0.1",
				serverPort: server.port!,
				tlsServerName: "wrong.invalid",
				onFrame() {},
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

test("wt listener admission is derived from the registered cohort, chat 10k included", () => {
	// Every row of the frozen §4.5 table, not a chosen number: the global cap and
	// both host-scoped caps are the registered session count, and the refill is
	// the registered ramp. Nothing here reads a knob.
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
		});
	}
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
