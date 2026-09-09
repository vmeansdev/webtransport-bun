/**
 * The relay charges the two bodies it used to do for free.
 *
 * `serveFanoutRelayOverWebTransport` reports one span of relay work through
 * `onRelayWork` for every stretch the loop spends inside the relay, and the
 * Phase-B accumulator sums them. Two stretches on the inbound path were
 * outside every span: the reassembly of whole units out of arbitrary stream
 * reads (`LengthPrefixedFrameReader.push`) and the routing decode that picks
 * the stream a frame's answer goes out on (`relayFrameRoutingFields`). Both
 * are the relay's own work on the relay's own loop, so the figure the campaign
 * publishes was short by them.
 *
 * The two tests below drive the real WebTransport ingest and count spans,
 * which is exact rather than timed: a chunk that does not complete a unit does
 * no relay work at all except the reassembly, so it charges exactly one span,
 * and a chunk that completes one charges the reassembly, the inbound handling
 * and the routing decode. Move either body back outside and a count drops.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FakeWtClientSession,
	LengthPrefixedFrameReader,
	productionWtAdapterOptions,
} from "./adapters/wt.ts";
import {
	buildFanoutCohortFixture,
	createManualRelayClock,
	FanoutRelay,
} from "./scenarios/fanout-relay.ts";
import { FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES } from "./scenarios/fanout-wire.ts";
import { serveFanoutRelayOverWebTransport } from "./server.ts";

let certPem: string;
let keyPem: string;
let certDir: string;

beforeAll(() => {
	certDir = mkdtempSync(join(tmpdir(), "relay-loop-charge-tls-"));
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

const COHORT_ID = "relay-loop-charge";
const GRANT_SHA256 = "a".repeat(64);

interface Harness {
	readonly spans: number[];
	readonly write: (bytes: Uint8Array) => void;
	readonly registerFrame: Uint8Array;
	readonly inboxSize: () => number;
	readonly quiet: (ticks?: number) => Promise<void>;
	readonly spansAtLeast: (count: number) => Promise<void>;
	readonly close: () => Promise<void>;
}

/**
 * One publisher over real QUIC, its control stream open and its register frame
 * encoded but not yet written, so a test decides how the bytes are cut up.
 */
async function openHarness(): Promise<Harness> {
	const fixture = buildFanoutCohortFixture({
		cohortId: COHORT_ID,
		publisherCount: 1,
		subscriberCount: 8,
	});
	const relay = new FanoutRelay({
		transport: "wt",
		cohortId: fixture.cohortId,
		cohortGrantSha256: GRANT_SHA256,
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
	const codec = relay.codec;
	const spans: number[] = [];
	const peer = await serveFanoutRelayOverWebTransport({
		relay,
		hostname: "127.0.0.1",
		port: 0,
		tls: { certPem, keyPem },
		onRelayWork: (elapsedMs) => {
			spans.push(elapsedMs);
		},
	});
	const { clientFactory } = await productionWtAdapterOptions();
	const client: FakeWtClientSession = await clientFactory(peer.url, {
		tls: { caPem: certPem, serverName: "wt-compare.local" },
	});
	await client.ready;
	const control = (await client.createBidirectionalStream()) as unknown as {
		on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
		write(chunk: Uint8Array): boolean;
	};
	const inbox: unknown[] = [];
	const frames = new LengthPrefixedFrameReader(
		FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES,
	);
	control.on("data", (chunk: Uint8Array) => {
		for (const bytes of frames.push(chunk)) {
			const read = codec.decode(bytes);
			if (read.ok) inbox.push(read.value);
		}
	});

	const publisherId = fixture.publishers[0]?.publisherId as string;
	const encoded = codec.encode({
		schema: "fanout-wire/v1",
		kind: "register",
		cohortGrantSha256: GRANT_SHA256,
		transport: "wt",
		role: "publisher",
		childId: fixture.childIdByRoleId.get(publisherId),
		roleId: publisherId,
		workerIndex: fixture.workerIndexByRoleId.get(publisherId) ?? null,
		tokenBase64: fixture.tokenBase64ByRoleId.get(publisherId),
		tokenSha256: fixture.tokenSha256ByRoleId.get(publisherId),
		tokenCommitmentIndex: fixture.commitmentIndexByRoleId.get(publisherId),
		tokenMerkleProofSha256: [...(fixture.proofByRoleId.get(publisherId) ?? [])],
	} as never);
	if (!encoded.ok) throw new Error(`encode: ${encoded.code}`);

	const tick = (): Promise<void> =>
		new Promise((resolve) => setTimeout(resolve, 5));
	return {
		spans,
		registerFrame: encoded.value,
		write: (bytes) => void control.write(bytes),
		inboxSize: () => inbox.length,
		quiet: async (ticks = 6) => {
			for (let index = 0; index < ticks; index++) await tick();
		},
		spansAtLeast: async (count) => {
			const deadline = Date.now() + 10_000;
			while (spans.length < count) {
				if (Date.now() > deadline)
					throw new Error(
						`only ${spans.length} relay spans of ${count} within 10s`,
					);
				await tick();
			}
		},
		close: async () => {
			client.close();
			await peer.stop();
		},
	};
}

test("the relay charges the reassembly of a chunk that completes no frame", async () => {
	const harness = await openHarness();
	try {
		// The session is open and idle: `openSession` has already charged its
		// span and nothing is queued, so the settler stays quiet.
		await harness.quiet();
		harness.spans.length = 0;
		// A length prefix and eight body bytes: the reader buffers them and
		// yields nothing, so the reassembly is the only relay work this chunk
		// causes. Uncharged, this chunk charges no span at all.
		harness.write(harness.registerFrame.subarray(0, 12));
		await harness.spansAtLeast(1);
		await harness.quiet();
		expect(harness.spans).toHaveLength(1);
	} finally {
		await harness.close();
	}
}, 40_000);

test("the relay charges the routing decode of a frame it accepted", async () => {
	const harness = await openHarness();
	try {
		await harness.quiet();
		harness.spans.length = 0;
		harness.write(harness.registerFrame.subarray(0, 12));
		await harness.spansAtLeast(1);
		await harness.quiet();
		// Completing the unit charges three more spans: the reassembly of this
		// chunk, the inbound handling with its pump, and the routing decode
		// that decides which stream the answer goes out on.
		harness.write(harness.registerFrame.subarray(12));
		await harness.spansAtLeast(4);
		await harness.quiet();
		expect(harness.inboxSize()).toBe(1);
		expect(harness.spans).toHaveLength(4);
	} finally {
		await harness.close();
	}
}, 40_000);
