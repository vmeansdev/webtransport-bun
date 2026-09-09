/**
 * Physical-budget amendment D2: the compact `fanout-delivery/c1` frame, the
 * per-session delivery context, and the first-byte discriminator both
 * transports share. Every vector here is derived from the amendment's table
 * and key sets, never from a codec's own output.
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { canonicalJson } from "./canonical.ts";
import { CAMPAIGN_FAILURE_CODES } from "./cross-supervisor-protocol.ts";
import {
	buildFanoutDeliveryContext,
	cloneFanoutDeliveryForSubscriber,
	contextTagOfDeliveryContextSha256,
	decodeFanoutDelivery,
	decodeFanoutWsMessage,
	decodeFanoutWtStream,
	encodeFanoutDelivery,
	encodeFanoutDeliveryTemplate,
	encodeFanoutWsMessage,
	encodeFanoutWtFrame,
	FANOUT_CHAT_PAYLOAD_BYTES,
	FANOUT_DELIVERY_HEADER_BYTES,
	FANOUT_DELIVERY_MAGIC,
	FANOUT_MAX_WINDOW_COUNT,
	FANOUT_TICKER_PAYLOAD_BYTES,
	FANOUT_WT_LENGTH_PREFIX_BYTES,
	type FanoutDeliveryContextV1,
	fanoutDeliveryUnitBytes,
	fanoutDeliveryUnitKind,
	parseFanoutDeliveryContext,
	parseFanoutWire,
	requireMeasuredFrameBinding,
	requireWarmupFrameBinding,
	resolveDeliveryEpochByTag,
	verifyFanoutDeliveryContext,
} from "./scenarios/fanout-wire.ts";

const GRANT = "01".repeat(32);
const BARRIER = "02".repeat(32);
const WARMUP_EPOCH = "03".repeat(32);
const WARMUP_NONCE = "04".repeat(32);

function sha256Hex(input: string | Uint8Array): string {
	return createHash("sha256").update(input).digest("hex");
}

function u32le(value: number): number[] {
	return [
		value & 0xff,
		(value >>> 8) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 24) & 0xff,
	];
}

function u16le(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff];
}

// --- Vectors written straight from the D2 header table ----------------------

const TICKER_HEADER = {
	windowIndex: 3,
	publisherIndex: 0,
	subscriberIndex: 42,
	publisherSequence: 1234,
	linuxAcceptedOrdinal: 1233,
	contextTag: 0xa1b2c3d4,
	payloadBytes: FANOUT_TICKER_PAYLOAD_BYTES,
} as const;
const TICKER_PAYLOAD = Uint8Array.from({ length: 100 }, (_, i) => i);
const TICKER_VECTOR = Uint8Array.from([
	0xc1,
	0x03,
	...u16le(0),
	...u32le(42),
	...u32le(1234),
	...u32le(1233),
	...u32le(0xa1b2c3d4),
	...u16le(100),
	0x00,
	0x00,
	...TICKER_PAYLOAD,
]);
const TICKER_VECTOR_SHA256 =
	"dbc3df842d46c2f50ab00a62b062e2f411e6a864a59ff89e2b2d4d4d82fe81be";

const CHAT_HEADER = {
	windowIndex: 29,
	publisherIndex: 9,
	subscriberIndex: 999,
	publisherSequence: 0xffffffff,
	linuxAcceptedOrdinal: 300,
	contextTag: 1,
	payloadBytes: FANOUT_CHAT_PAYLOAD_BYTES,
} as const;
const CHAT_PAYLOAD = Uint8Array.from({ length: 128 }, (_, i) => (i * 7) & 0xff);
const CHAT_VECTOR = Uint8Array.from([
	0xc1,
	0x1d,
	...u16le(9),
	...u32le(999),
	...u32le(0xffffffff),
	...u32le(300),
	...u32le(1),
	...u16le(128),
	0x00,
	0x00,
	...CHAT_PAYLOAD,
]);
const CHAT_VECTOR_SHA256 =
	"5e1ffb6d48f99725048e5cf3c6ac454c9fa2d83bb7738e53392a104d475d5fd7";

const MEASURED_FACTS = {
	epoch: "measured",
	cohortGrantSha256: GRANT,
	cohortStartBarrierSha256: BARRIER,
	subscriberId: "subscriber-000042",
	subscriberIndex: 42,
	publisherIds: ["publisher-000000"],
	windowCount: 10,
	messageBytes: 100,
} as const;
const MEASURED_PREIMAGE = `{"cohortGrantSha256":"${GRANT}","cohortStartBarrierSha256":"${BARRIER}","epoch":"measured","kind":"delivery-context","messageBytes":100,"publisherIds":["publisher-000000"],"schema":"fanout-wire/v1","subscriberId":"subscriber-000042","subscriberIndex":42,"windowCount":10}`;
const MEASURED_SHA256 =
	"afc84d402b6fd2ec0a932dc478391ee88c03fa614ddd0665e8e0a72830560895";
const MEASURED_TAG = 0x404dc8af;

const TEN_PUBLISHERS = Array.from(
	{ length: 10 },
	(_, i) => `publisher-${String(i).padStart(6, "0")}`,
);
const WARMUP_FACTS = {
	epoch: "warmup",
	cohortGrantSha256: GRANT,
	cohortWarmupEpochSha256: WARMUP_EPOCH,
	warmupNonce: WARMUP_NONCE,
	subscriberId: "subscriber-000999",
	subscriberIndex: 999,
	publisherIds: TEN_PUBLISHERS,
	windowCount: 30,
	messageBytes: 128,
} as const;
const WARMUP_PREIMAGE = `{"cohortGrantSha256":"${GRANT}","cohortWarmupEpochSha256":"${WARMUP_EPOCH}","epoch":"warmup","kind":"delivery-context","messageBytes":128,"publisherIds":[${TEN_PUBLISHERS.map((id) => `"${id}"`).join(",")}],"schema":"fanout-wire/v1","subscriberId":"subscriber-000999","subscriberIndex":999,"warmupNonce":"${WARMUP_NONCE}","windowCount":30}`;
const WARMUP_SHA256 =
	"e2b63688144f288bf858c4d028072c03d4ddb9c9b456c82efbc06ebeb1881601";
const WARMUP_TAG = 0x8836b6e2;

function mustBuild(facts: Parameters<typeof buildFanoutDeliveryContext>[0]) {
	const built = buildFanoutDeliveryContext(facts);
	if (!built.ok) throw new Error(built.message);
	return built.value;
}

function mustEncode(
	header: Parameters<typeof encodeFanoutDelivery>[0],
	payload: Uint8Array,
): Uint8Array {
	const encoded = encodeFanoutDelivery(header, payload);
	if (!encoded.ok) throw new Error(encoded.message);
	return encoded.value;
}

describe("fanout-delivery/c1 compact frame", () => {
	test("header layout is exactly the D2 table on the 100 and 128 byte cells", () => {
		expect(FANOUT_DELIVERY_MAGIC).toBe(0xc1);
		expect(FANOUT_DELIVERY_HEADER_BYTES).toBe(24);
		expect(fanoutDeliveryUnitBytes(100)).toBe(124);
		expect(fanoutDeliveryUnitBytes(128)).toBe(152);

		const ticker = mustEncode(TICKER_HEADER, TICKER_PAYLOAD);
		expect(ticker.byteLength).toBe(124);
		expect([...ticker]).toEqual([...TICKER_VECTOR]);
		expect(sha256Hex(ticker)).toBe(TICKER_VECTOR_SHA256);

		const chat = mustEncode(CHAT_HEADER, CHAT_PAYLOAD);
		expect(chat.byteLength).toBe(152);
		expect([...chat]).toEqual([...CHAT_VECTOR]);
		expect(sha256Hex(chat)).toBe(CHAT_VECTOR_SHA256);
	});

	test("both vectors decode back to their fields with the payload untouched", () => {
		const ticker = decodeFanoutDelivery(TICKER_VECTOR, 100);
		expect(ticker.ok).toBe(true);
		if (!ticker.ok) throw new Error("unreachable");
		const { payload: tickerPayload, ...tickerHeader } = ticker.value;
		expect(tickerHeader).toEqual(TICKER_HEADER);
		expect([...tickerPayload]).toEqual([...TICKER_PAYLOAD]);

		const chat = decodeFanoutDelivery(CHAT_VECTOR, 128);
		expect(chat.ok).toBe(true);
		if (!chat.ok) throw new Error("unreachable");
		const { payload: chatPayload, ...chatHeader } = chat.value;
		expect(chatHeader).toEqual(CHAT_HEADER);
		expect([...chatPayload]).toEqual([...CHAT_PAYLOAD]);
	});

	test("relay discipline: one template per ingress, a patched clone per subscriber", () => {
		const template = encodeFanoutDeliveryTemplate({
			windowIndex: TICKER_HEADER.windowIndex,
			publisherIndex: TICKER_HEADER.publisherIndex,
			publisherSequence: TICKER_HEADER.publisherSequence,
			linuxAcceptedOrdinal: TICKER_HEADER.linuxAcceptedOrdinal,
			contextTag: TICKER_HEADER.contextTag,
			payload: TICKER_PAYLOAD,
		});
		expect(template.ok).toBe(true);
		if (!template.ok) throw new Error("unreachable");
		expect(template.value.byteLength).toBe(124);

		const forSubscriber42 = cloneFanoutDeliveryForSubscriber(
			template.value,
			42,
		);
		expect([...forSubscriber42]).toEqual([...TICKER_VECTOR]);
		const forSubscriber7 = cloneFanoutDeliveryForSubscriber(template.value, 7);
		// A clone is a distinct buffer: patching one never bleeds into another.
		expect(forSubscriber7.buffer).not.toBe(forSubscriber42.buffer);
		expect(forSubscriber7.buffer).not.toBe(template.value.buffer);
		const decoded = decodeFanoutDelivery(forSubscriber7, 100);
		expect(decoded.ok && decoded.value.subscriberIndex).toBe(7);
		// Only the subscriberIndex field differs between two clones.
		for (let i = 0; i < 124; i += 1) {
			if (i >= 4 && i < 8) continue;
			expect(forSubscriber7[i]).toBe(forSubscriber42[i]);
		}
		expect(() => cloneFanoutDeliveryForSubscriber(template.value, -1)).toThrow(
			RangeError,
		);
		expect(() =>
			cloneFanoutDeliveryForSubscriber(template.value, 0x1_0000_0000),
		).toThrow(RangeError);
		expect(() =>
			cloneFanoutDeliveryForSubscriber(template.value.subarray(1), 1),
		).toThrow(RangeError);
	});

	test("the template refuses every out-of-range field before any byte is written", () => {
		const good = {
			windowIndex: 0,
			publisherIndex: 0,
			publisherSequence: 0,
			linuxAcceptedOrdinal: 0,
			contextTag: 0,
			payload: TICKER_PAYLOAD,
		};
		expect(encodeFanoutDeliveryTemplate(good).ok).toBe(true);
		const bad: Array<Partial<typeof good>> = [
			{ windowIndex: FANOUT_MAX_WINDOW_COUNT },
			{ windowIndex: -1 },
			{ windowIndex: 1.5 },
			{ publisherIndex: 0x1_0000 },
			{ publisherIndex: -1 },
			{ publisherSequence: 0x1_0000_0000 },
			{ linuxAcceptedOrdinal: 0x1_0000_0000 },
			{ contextTag: 0x1_0000_0000 },
			{ contextTag: -1 },
			{ payload: TICKER_PAYLOAD.subarray(0, 99) },
			{ payload: new Uint8Array(129) },
			{ payload: new Uint8Array(0) },
		];
		for (const override of bad) {
			expect(encodeFanoutDeliveryTemplate({ ...good, ...override }).ok).toBe(
				false,
			);
		}
	});

	test("every malformed header field is refused, with the cell constant as the length authority", () => {
		const refuse = (
			mutate: (bytes: Uint8Array) => void,
			messageBytes = 100,
		) => {
			const bytes = Uint8Array.from(TICKER_VECTOR);
			mutate(bytes);
			const decoded = decodeFanoutDelivery(bytes, messageBytes);
			expect(decoded.ok).toBe(false);
			return decoded.ok ? "" : decoded.message;
		};
		expect(decodeFanoutDelivery(TICKER_VECTOR, 100).ok).toBe(true);

		expect(refuse((b) => (b[0] = 0x00))).toContain("magic");
		expect(refuse((b) => (b[0] = 0xc2))).toContain("magic");
		expect(refuse((b) => (b[1] = FANOUT_MAX_WINDOW_COUNT))).toContain(
			"windowIndex",
		);
		expect(refuse((b) => (b[1] = 0xff))).toContain("windowIndex");
		// payloadBytes must equal the cell constant, not merely be self-consistent.
		expect(refuse((b) => (b[20] = 128))).toContain("payloadBytes");
		expect(refuse((b) => (b[20] = 99))).toContain("payloadBytes");
		expect(refuse((b) => (b[22] = 1))).toContain("reserved");
		expect(refuse((b) => (b[23] = 0x80))).toContain("reserved");

		// Exact length: a byte short, a byte long, a header alone, empty.
		expect(decodeFanoutDelivery(TICKER_VECTOR.subarray(0, 123), 100).ok).toBe(
			false,
		);
		const long = new Uint8Array(125);
		long.set(TICKER_VECTOR);
		expect(decodeFanoutDelivery(long, 100).ok).toBe(false);
		expect(decodeFanoutDelivery(TICKER_VECTOR.subarray(0, 24), 100).ok).toBe(
			false,
		);
		expect(decodeFanoutDelivery(new Uint8Array(0), 100).ok).toBe(false);
		// The chat vector against the ticker constant is a length refusal, and
		// the ticker vector against the chat constant likewise.
		expect(decodeFanoutDelivery(CHAT_VECTOR, 100).ok).toBe(false);
		expect(decodeFanoutDelivery(TICKER_VECTOR, 128).ok).toBe(false);
		// A cell constant outside {100, 128} is a caller error, refused too.
		expect(decodeFanoutDelivery(TICKER_VECTOR, 101).ok).toBe(false);
	});
});

describe("delivery context, both epochs", () => {
	test("measured context: exact keys, digest over the frame minus its own key, LE tag", () => {
		const frame = mustBuild(MEASURED_FACTS);
		expect(Object.keys(frame).sort()).toEqual([
			"cohortGrantSha256",
			"cohortStartBarrierSha256",
			"deliveryContextSha256",
			"epoch",
			"kind",
			"messageBytes",
			"publisherIds",
			"schema",
			"subscriberId",
			"subscriberIndex",
			"windowCount",
		]);
		const { deliveryContextSha256, ...preimage } = frame;
		expect(canonicalJson(preimage)).toBe(MEASURED_PREIMAGE);
		expect(sha256Hex(MEASURED_PREIMAGE)).toBe(MEASURED_SHA256);
		expect(deliveryContextSha256).toBe(MEASURED_SHA256);
		expect(contextTagOfDeliveryContextSha256(deliveryContextSha256)).toBe(
			MEASURED_TAG,
		);
		expect(parseFanoutDeliveryContext(frame).ok).toBe(true);
		expect(parseFanoutWire(frame)).toEqual({ ok: true, value: frame });
	});

	test("warmup context: exact keys including the nonce, digest, LE tag", () => {
		const frame = mustBuild(WARMUP_FACTS);
		expect(Object.keys(frame).sort()).toEqual([
			"cohortGrantSha256",
			"cohortWarmupEpochSha256",
			"deliveryContextSha256",
			"epoch",
			"kind",
			"messageBytes",
			"publisherIds",
			"schema",
			"subscriberId",
			"subscriberIndex",
			"warmupNonce",
			"windowCount",
		]);
		const { deliveryContextSha256, ...preimage } = frame;
		expect(canonicalJson(preimage)).toBe(WARMUP_PREIMAGE);
		expect(sha256Hex(WARMUP_PREIMAGE)).toBe(WARMUP_SHA256);
		expect(deliveryContextSha256).toBe(WARMUP_SHA256);
		expect(contextTagOfDeliveryContextSha256(deliveryContextSha256)).toBe(
			WARMUP_TAG,
		);
		expect(parseFanoutWire(frame)).toEqual({ ok: true, value: frame });
	});

	test("the tag is the first four digest bytes read little-endian", () => {
		expect(
			contextTagOfDeliveryContextSha256(`04030201${"00".repeat(28)}`),
		).toBe(0x01020304);
		expect(
			contextTagOfDeliveryContextSha256(`ffffffff${"00".repeat(28)}`),
		).toBe(0xffffffff);
		expect(() => contextTagOfDeliveryContextSha256("0403")).toThrow(RangeError);
	});

	test("the parser keys its forbidden set on epoch and refuses every mixed or wrong field", () => {
		const measured = mustBuild(MEASURED_FACTS);
		const warmup = mustBuild(WARMUP_FACTS);
		const rebuilt = (frame: Record<string, unknown>) => {
			const { deliveryContextSha256: _drop, ...rest } = frame;
			return {
				...rest,
				deliveryContextSha256: sha256Hex(canonicalJson(rest)),
			};
		};
		const refuse = (frame: unknown) => {
			expect(parseFanoutDeliveryContext(frame).ok).toBe(false);
			expect(parseFanoutWire(frame).ok).toBe(false);
		};
		// A warmup field on a measured context and the reverse, even with a
		// digest recomputed over the mixed frame.
		refuse(rebuilt({ ...measured, warmupNonce: WARMUP_NONCE }));
		refuse(rebuilt({ ...measured, cohortWarmupEpochSha256: WARMUP_EPOCH }));
		refuse(rebuilt({ ...warmup, cohortStartBarrierSha256: BARRIER }));
		refuse(rebuilt({ ...warmup, windowIndex: 0 }));
		// The epoch is a closed pair.
		refuse(rebuilt({ ...measured, epoch: "measure" }));
		refuse(rebuilt({ ...measured, epoch: "warmup" }));
		// A stale or forged digest is refused at parse, before the worker's own recompute.
		refuse({ ...measured, deliveryContextSha256: WARMUP_SHA256 });
		refuse({ ...measured, deliveryContextSha256: "00".repeat(32) });
		refuse({
			...measured,
			deliveryContextSha256: MEASURED_SHA256.toUpperCase(),
		});
		// Shape: every scalar and the publisher list.
		refuse(rebuilt({ ...measured, subscriberId: "publisher-000042" }));
		refuse(rebuilt({ ...measured, subscriberId: "subscriber-42" }));
		refuse(rebuilt({ ...measured, subscriberIndex: -1 }));
		refuse(rebuilt({ ...measured, subscriberIndex: 0x1_0000_0000 }));
		refuse(rebuilt({ ...measured, subscriberIndex: 1.5 }));
		refuse(rebuilt({ ...measured, windowCount: 0 }));
		refuse(rebuilt({ ...measured, windowCount: FANOUT_MAX_WINDOW_COUNT + 1 }));
		refuse(rebuilt({ ...measured, messageBytes: 99 }));
		refuse(rebuilt({ ...measured, publisherIds: [] }));
		refuse(rebuilt({ ...measured, publisherIds: ["subscriber-000000"] }));
		refuse(
			rebuilt({
				...measured,
				publisherIds: ["publisher-000001", "publisher-000000"],
			}),
		);
		refuse(
			rebuilt({
				...measured,
				publisherIds: ["publisher-000000", "publisher-000000"],
			}),
		);
		refuse(
			rebuilt({
				...measured,
				publisherIds: [...TEN_PUBLISHERS, "publisher-000010"],
			}),
		);
		refuse(rebuilt({ ...measured, cohortGrantSha256: GRANT.slice(1) }));
		refuse(rebuilt({ ...measured, kind: "data" }));
		refuse(rebuilt({ ...measured, schema: "fanout-wire/v2" }));
		refuse(rebuilt({ ...measured, extra: 1 }));
		const { windowCount: _w, ...missing } = measured;
		refuse(rebuilt(missing));
		refuse(null);
		refuse([]);
	});

	test("the worker recomputes the digest from its own admission facts and refuses on any mismatch", () => {
		const measured = mustBuild(MEASURED_FACTS);
		const verified = verifyFanoutDeliveryContext(measured, MEASURED_FACTS);
		expect(verified.ok).toBe(true);
		if (!verified.ok) throw new Error("unreachable");
		expect(verified.value.contextTag).toBe(MEASURED_TAG);
		expect(verified.value.frame).toEqual(measured);

		const warmup = mustBuild(WARMUP_FACTS);
		const warmupVerified = verifyFanoutDeliveryContext(warmup, WARMUP_FACTS);
		expect(warmupVerified.ok && warmupVerified.value.contextTag).toBe(
			WARMUP_TAG,
		);

		const mismatch = (
			frame: unknown,
			facts: Parameters<typeof verifyFanoutDeliveryContext>[1],
		) => {
			const result = verifyFanoutDeliveryContext(frame, facts);
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("unreachable");
			expect(result.code).toBe("DELIVERY_CONTEXT_MISMATCH");
		};
		// Each admission fact, changed on the worker's side only.
		mismatch(measured, { ...MEASURED_FACTS, cohortGrantSha256: BARRIER });
		mismatch(measured, { ...MEASURED_FACTS, cohortStartBarrierSha256: GRANT });
		mismatch(measured, {
			...MEASURED_FACTS,
			subscriberId: "subscriber-000043",
		});
		mismatch(measured, { ...MEASURED_FACTS, subscriberIndex: 43 });
		mismatch(measured, {
			...MEASURED_FACTS,
			publisherIds: ["publisher-000000", "publisher-000001"],
		});
		mismatch(measured, { ...MEASURED_FACTS, windowCount: 30 });
		mismatch(measured, { ...MEASURED_FACTS, messageBytes: 128 });
		// The other epoch's context against this epoch's facts, and the reverse.
		mismatch(warmup, MEASURED_FACTS);
		mismatch(measured, WARMUP_FACTS);
		mismatch(warmup, { ...WARMUP_FACTS, warmupNonce: WARMUP_EPOCH });
		// A context of another subscriber written down this session's channel.
		const other = mustBuild({
			...MEASURED_FACTS,
			subscriberId: "subscriber-000007",
			subscriberIndex: 7,
		});
		mismatch(other, MEASURED_FACTS);
		// A unit that is not a delivery context at all.
		mismatch({ schema: "fanout-wire/v1", kind: "end" }, MEASURED_FACTS);
		mismatch(new Uint8Array(0), MEASURED_FACTS);
	});

	test("tag mismatch: a compact frame resolves to its epoch only through a context the session holds", () => {
		const tags = { warmup: WARMUP_TAG, measured: MEASURED_TAG };
		expect(resolveDeliveryEpochByTag(MEASURED_TAG, tags)).toEqual({
			ok: true,
			value: "measured",
		});
		expect(resolveDeliveryEpochByTag(WARMUP_TAG, tags)).toEqual({
			ok: true,
			value: "warmup",
		});
		// Before the measured context arrives only the warmup tag is known.
		const warmupOnly = { warmup: WARMUP_TAG, measured: null };
		expect(resolveDeliveryEpochByTag(WARMUP_TAG, warmupOnly).ok).toBe(true);
		const early = resolveDeliveryEpochByTag(MEASURED_TAG, warmupOnly);
		expect(early.ok).toBe(false);
		if (early.ok) throw new Error("unreachable");
		expect(early.code).toBe("DELIVERY_CONTEXT_MISMATCH");
		// No context at all, a foreign tag, and equal tags all refuse.
		expect(
			resolveDeliveryEpochByTag(MEASURED_TAG, { warmup: null, measured: null })
				.ok,
		).toBe(false);
		expect(resolveDeliveryEpochByTag(MEASURED_TAG ^ 1, tags).ok).toBe(false);
		const equal = resolveDeliveryEpochByTag(MEASURED_TAG, {
			warmup: MEASURED_TAG,
			measured: MEASURED_TAG,
		});
		expect(equal.ok).toBe(false);
		if (equal.ok) throw new Error("unreachable");
		expect(equal.code).toBe("DELIVERY_CONTEXT_MISMATCH");
		expect(equal.message).toContain("equal");

		// A compact frame carrying the tag the encoder was given lands on that epoch.
		const frame = mustEncode(
			{ ...TICKER_HEADER, contextTag: WARMUP_TAG },
			TICKER_PAYLOAD,
		);
		const decoded = decodeFanoutDelivery(frame, 100);
		if (!decoded.ok) throw new Error("unreachable");
		expect(resolveDeliveryEpochByTag(decoded.value.contextTag, tags)).toEqual({
			ok: true,
			value: "warmup",
		});
	});

	test("the epoch bindings the relay applies also read a delivery context by its epoch", () => {
		const measured = mustBuild(MEASURED_FACTS);
		const warmup = mustBuild(WARMUP_FACTS);
		const warmupExpected = {
			cohortGrantSha256: GRANT,
			cohortWarmupEpochSha256: WARMUP_EPOCH,
			warmupNonce: WARMUP_NONCE,
		};
		const measuredExpected = {
			cohortGrantSha256: GRANT,
			cohortStartBarrierSha256: BARRIER,
		};
		expect(requireWarmupFrameBinding(warmup, warmupExpected).ok).toBe(true);
		expect(requireMeasuredFrameBinding(measured, measuredExpected).ok).toBe(
			true,
		);
		expect(requireWarmupFrameBinding(measured, warmupExpected).ok).toBe(false);
		expect(requireMeasuredFrameBinding(warmup, measuredExpected).ok).toBe(
			false,
		);
		expect(
			requireWarmupFrameBinding(warmup, {
				...warmupExpected,
				warmupNonce: GRANT,
			}).ok,
		).toBe(false);
		expect(
			requireMeasuredFrameBinding(measured, {
				...measuredExpected,
				cohortStartBarrierSha256: GRANT,
			}).ok,
		).toBe(false);
	});

	test("DELIVERY_CONTEXT_MISMATCH is a member of the closed campaign failure vocabulary", () => {
		expect(CAMPAIGN_FAILURE_CODES).toContain("DELIVERY_CONTEXT_MISMATCH");
	});
});

describe("delivery channel discriminator and cross-transport identity", () => {
	test("the first byte tells a compact unit from a prefixed JSON unit on WT and from a JSON message on WS", () => {
		const compact = mustEncode(TICKER_HEADER, TICKER_PAYLOAD);
		const context: FanoutDeliveryContextV1 = mustBuild(MEASURED_FACTS);
		const wsMessage = encodeFanoutWsMessage(context);
		const wtUnit = encodeFanoutWtFrame(context);
		if (!wsMessage.ok || !wtUnit.ok) throw new Error("unreachable");

		expect(fanoutDeliveryUnitKind(compact, "wt")).toBe("compact");
		expect(fanoutDeliveryUnitKind(compact, "ws")).toBe("compact");
		expect(wtUnit.value[0]).toBe(0x00);
		expect(fanoutDeliveryUnitKind(wtUnit.value, "wt")).toBe("json");
		expect(wsMessage.value[0]).toBe(0x7b);
		expect(fanoutDeliveryUnitKind(wsMessage.value, "ws")).toBe("json");

		// A JSON unit's first byte never reads as the other transport's JSON
		// unit, and never as a compact frame; an empty unit is nothing.
		expect(fanoutDeliveryUnitKind(wsMessage.value, "wt")).toBe(null);
		expect(fanoutDeliveryUnitKind(wtUnit.value, "ws")).toBe(null);
		expect(fanoutDeliveryUnitKind(new Uint8Array(0), "ws")).toBe(null);
		expect(fanoutDeliveryUnitKind(new Uint8Array(0), "wt")).toBe(null);
		expect(fanoutDeliveryUnitKind(Uint8Array.of(0x01), "wt")).toBe(null);
		expect(fanoutDeliveryUnitKind(Uint8Array.of(0x20, 0x7b), "ws")).toBe(null);

		// The JSON path still refuses a compact unit outright on both transports.
		expect(decodeFanoutWsMessage(compact).ok).toBe(false);
		expect(decodeFanoutWtStream(compact).ok).toBe(false);
	});

	test("a compact frame is the same bytes on the WS message and the WT stream unit; the context differs only by the WT prefix", () => {
		const compact = mustEncode(CHAT_HEADER, CHAT_PAYLOAD);
		// No transport adds or removes a byte around a compact unit: the header
		// states the length, so the WS message and the WT stream unit are one array.
		expect(decodeFanoutDelivery(compact, 128).ok).toBe(true);
		expect(compact.byteLength).toBe(fanoutDeliveryUnitBytes(128));

		const context = mustBuild(WARMUP_FACTS);
		const ws = encodeFanoutWsMessage(context);
		const wt = encodeFanoutWtFrame(context);
		if (!ws.ok || !wt.ok) throw new Error("unreachable");
		expect(wt.value.byteLength).toBe(
			ws.value.byteLength + FANOUT_WT_LENGTH_PREFIX_BYTES,
		);
		expect([...wt.value.subarray(FANOUT_WT_LENGTH_PREFIX_BYTES)]).toEqual([
			...ws.value,
		]);
		const fromWs = decodeFanoutWsMessage(ws.value);
		const fromWt = decodeFanoutWtStream(wt.value);
		expect(fromWs.ok && fromWs.value).toEqual(context);
		expect(fromWt.ok && fromWt.value[0]).toEqual(context);
	});
});
