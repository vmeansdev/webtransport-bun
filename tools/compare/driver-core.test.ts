import { describe, expect, test } from "bun:test";
import { R1_FIXTURE_TOOLCHAINS } from "./r1-fixtures.ts";
import { PassThrough } from "node:stream";

// F4 binding: every measured arm in this test file uses the
// frozen R1 toolchain set as the supervisor's per-host reading.
// The artifact's per-host `darwin.sha256` / `linux.sha256` are
// compared against the supervisor's reading, so the test's
// "supervisor's reading" is the fixture's per-host digest.
const SUPERVISOR_TOOLCHAIN_DIGESTS = {
	darwin: R1_FIXTURE_TOOLCHAINS.darwin.sha256,
	linux: R1_FIXTURE_TOOLCHAINS.linux.sha256,
} as const;
import { runInNewContext } from "node:vm";
import type {
	ClientWebSocketLike,
	ServerWebSocketLike,
	TransportClock,
	WebSocketServerRuntime,
	WebSocketServerRuntimeOptions,
} from "./adapters/transport.ts";
import { systemTransportClock } from "./adapters/transport.ts";
import { encodeWebSocketFrame, WebSocketAdapter } from "./adapters/ws.ts";
import { createWebTransportAdapter } from "./adapters/wt.ts";
import { trustContextForArtifact } from "./artifact-builder.ts";
import {
	ByteBoundedQueue,
	type ByteBoundedQueueOptions,
	DEFAULT_MAX_QUEUE_ITEMS,
	type QueueWaitOptions,
} from "./bounded-queue.ts";
import {
	contractMeasurableByDriver,
	DRIVER_SAMPLE_UNIT,
	DRIVER_UNMEASURED_UNIT_SCENARIOS,
	LEG_PLAN_UNDEFINED_SCENARIOS,
	LegPlanUndefinedError,
	legPlanForCell,
	MetricUnitUnmeasuredError,
	runMeasuredLeg,
} from "./client.ts";
import { compareCell } from "./compare.ts";
import {
	type MetricContract,
	metricContractHash,
	PRIMARY_METRIC_CONTRACTS,
	sealRunArtifact,
} from "./evidence.ts";
import { ManualClock, OpenLoopPacer, PacerDeadlineError } from "./pacer.ts";
import {
	buildMeasuredArmArtifact,
	deriveMeasuredVerdictTuple,
	injectedImpairmentOf,
} from "./run-campaign.ts";
import {
	CANONICAL_CAPACITY_PROFILE,
	CANONICAL_SCENARIO_REGISTRY,
} from "./scenario-registry.ts";
import { echoSession } from "./server.ts";
import { SCENARIO_IDS, type ScenarioCell, type ScenarioId } from "./types.ts";
import {
	openMeasurement,
	percentile,
	sampleSummary,
	studentTCritical95,
} from "./stats.ts";
import {
	encodeSupervisorFrame,
	MEASUREMENT_GRANT_SCHEMA,
	type MeasurementGrantV1,
	measurementGrantSha256,
	sha256HexOfBytes,
} from "./supervisor-client.ts";
import {
	ackFor,
	DEFAULT_MAX_WIRE_PAYLOAD_BYTES,
	decodeWireMessage,
	encodeWireMessage,
	isWireMessageExpired,
	MAX_WIRE_PAYLOAD_BYTES,
	MAX_WIRE_TOTAL_BYTES,
	WIRE_FIXED_HEADER_BYTES,
	WIRE_MAGIC,
	WIRE_VERSION,
	WireFormatError,
} from "./wire.ts";

/**
 * A receipt of the shape the supervisor writes, for one admitted arm.
 *
 * These tests stand one up rather than obtaining it, and that is the same seam
 * `grantFor` sits on and for the same reason: the supervisor's half of the
 * frame protocol is on the other side of a pipe, and a unit test has no pipe.
 * What these exercise is the half this process owns -- that an arm carrying no
 * admission is unbuildable, that a receipt naming another execution or another
 * grant is refused, and that a receipt is compared against the numbers the arm
 * actually carries rather than merely being present.
 */
function admissionFor(input: {
	readonly execution: {
		readonly campaignId: string;
		readonly runId: string;
		readonly executionIndex: number;
		readonly transport: string;
	};
	readonly grant: MeasurementGrantV1;
	readonly samples: readonly number[];
	readonly delivered: number;
	readonly firstSampleAtMs: number;
	readonly lastSampleAtMs: number;
	readonly overrides?: Record<string, unknown>;
}): Uint8Array {
	const payload = new TextEncoder().encode(
		`${JSON.stringify({
			schema: "measurement-admission/v1",
			campaignId: input.execution.campaignId,
			delivered: input.delivered,
			executionIndex: input.execution.executionIndex,
			firstSampleAtMs: input.firstSampleAtMs,
			frameAcceptedAtMs: Date.now(),
			grantSha256: measurementGrantSha256(input.grant),
			lastSampleAtMs: input.lastSampleAtMs,
			latencySumMs: input.samples.reduce((total, one) => total + one, 0),
			payloadSha256: sha256HexOfBytes(
				new TextEncoder().encode(JSON.stringify(input.samples)),
			),
			runId: input.execution.runId,
			sampleCount: input.samples.length,
			spanMs: input.lastSampleAtMs - input.firstSampleAtMs,
			transport: input.execution.transport,
			...input.overrides,
		})}\n`,
	);
	const header = new TextEncoder().encode(
		'{"kind":"admission-receipt","schema":"comparison-supervisor-frame/v1"}',
	);
	const framed = encodeSupervisorFrame(header, payload, 65_536);
	if (!framed.ok) throw new Error(`the receipt frame did not encode`);
	return framed.value;
}

/**
 * The grant the supervisor would have issued for one execution.
 *
 * These tests measure real legs over real adapter pairs and then build the
 * official arm from them, and the builder now refuses a measured arm that
 * presents no grant. There is no supervisor in a unit test, so the execution's
 * grant is stated here -- which is the seam the design leaves open on purpose:
 * a controller cannot tell an issued grant from a well-formed invention,
 * because the registry that can is on the other side of the pipe.
 */
let mintedGrants = 0;
function grantFor(execution: {
	readonly campaignId: string;
	readonly runId: string;
	readonly executionIndex: number;
	readonly transport: string;
}): MeasurementGrantV1 {
	mintedGrants += 1;
	const issuedAt = Date.now();
	return {
		schema: MEASUREMENT_GRANT_SCHEMA,
		campaignId: execution.campaignId,
		candidate: "driver-core-candidate",
		declaredMessageBytes: 1_024,
		declaredMessageCount: 4_096,
		executionIndex: execution.executionIndex,
		issuedAt,
		nonceSha256: `${mintedGrants}`.padStart(64, "0"),
		notAfter: issuedAt + 15 * 60 * 1_000,
		runId: execution.runId,
		transport: execution.transport,
	};
}

const message = {
	runId: "run-20260822-a",
	sessionId: "session-17",
	sequence: 42,
	expiresAtMs: 2_000,
	payload: new Uint8Array([0, 1, 2, 253, 254, 255]),
	// A decoded envelope always states what it is, so the round-trip fixture
	// states it too. The wire's flags byte was already required to be zero, and
	// zero is `"message"`, so these bytes are the bytes this codec always wrote.
	kind: "message" as const,
};

describe("shared comparison driver core", () => {
	// The campaign compares tails a few tenths of a millisecond apart. On
	// `Date.now()` — a 1 ms tick — that difference was rounded away by the clock
	// before either transport could produce it, so every sub-millisecond claim
	// the tool has ever made was unresolvable on its own instrument.
	test("reads time finely enough to resolve the differences it reports on", () => {
		const readings = Array.from({ length: 64 }, () =>
			systemTransportClock.nowMs(),
		);
		expect(readings.some((value) => !Number.isInteger(value))).toBe(true);
		expect(readings[0]).toBeGreaterThan(1_600_000_000_000);
		expect(systemTransportClock.method).toBe(
			"performance.timeOrigin+performance.now",
		);
		expect(systemTransportClock.method).not.toBe("Date.now");
	});

	test("round-trips the binary envelope and preserves identity and payload bytes", () => {
		const encoded = encodeWireMessage(message);
		const decoded = decodeWireMessage(encoded);

		expect(decoded).toEqual(message);
		expect(encoded).toBeInstanceOf(Uint8Array);
		expect(encoded.byteLength).toBeGreaterThan(message.payload.byteLength);
	});

	test("decodes only the selected byte-view range", () => {
		const encoded = encodeWireMessage(message);
		const wrapped = new Uint8Array(encoded.byteLength + 4);
		wrapped.fill(0xa5);
		wrapped.set(encoded, 2);

		expect(
			decodeWireMessage(new DataView(wrapped.buffer, 2, encoded.byteLength)),
		).toEqual(message);
	});

	test("marks an envelope expired at its deadline without mutating the message", () => {
		expect(isWireMessageExpired(message, 1_999)).toBe(false);
		expect(isWireMessageExpired(message, 2_000)).toBe(true);
		expect(() =>
			decodeWireMessage(encodeWireMessage(message), {
				nowMs: 2_000,
				rejectExpired: true,
			}),
		).toThrow(WireFormatError);
		expect(decodeWireMessage(encodeWireMessage(message))).toEqual(message);
	});

	test("requires own wire fields and snapshots message and codec getters once", () => {
		const reads = new Map<string, number>();
		const read = (name: string, value: unknown) => {
			reads.set(name, (reads.get(name) ?? 0) + 1);
			return value;
		};
		const snapshotMessage = {} as Record<string, unknown>;
		Object.defineProperties(snapshotMessage, {
			runId: { enumerable: true, get: () => read("runId", message.runId) },
			sessionId: {
				enumerable: true,
				get: () => read("sessionId", message.sessionId),
			},
			sequence: {
				enumerable: true,
				get: () => read("sequence", message.sequence),
			},
			expiresAtMs: {
				enumerable: true,
				get: () => read("expiresAtMs", message.expiresAtMs),
			},
			payload: {
				enumerable: true,
				get: () => read("payload", message.payload),
			},
		});

		const encoded = encodeWireMessage(
			snapshotMessage as unknown as typeof message,
		);
		expect(decodeWireMessage(encoded)).toEqual(message);
		for (const name of [
			"runId",
			"sessionId",
			"sequence",
			"expiresAtMs",
			"payload",
		]) {
			expect(reads.get(name)).toBe(1);
		}

		const inherited = Object.create(message) as typeof message;
		expect(() => encodeWireMessage(inherited)).toThrow(/own/i);

		let nowReads = 0;
		const options = {
			rejectExpired: true,
			get nowMs() {
				nowReads += 1;
				return message.expiresAtMs;
			},
		};
		expect(() => decodeWireMessage(encoded, options)).toThrow(/expired/i);
		expect(nowReads).toBe(1);
	});

	test("snapshots payload and input bytes through intrinsic view accessors", () => {
		const payload = new Uint8Array([7, 8, 9]);
		Object.defineProperties(payload, {
			buffer: { configurable: true, value: new ArrayBuffer(1) },
			byteOffset: { configurable: true, value: 0 },
			byteLength: { configurable: true, value: 1 },
		});
		const encoded = encodeWireMessage({ ...message, payload });
		expect(decodeWireMessage(encoded).payload).toEqual(
			new Uint8Array([7, 8, 9]),
		);

		const input = new Uint8Array(encoded);
		Object.defineProperties(input, {
			buffer: { configurable: true, value: new ArrayBuffer(1) },
			byteOffset: { configurable: true, value: 0 },
			byteLength: { configurable: true, value: 1 },
		});
		expect(decodeWireMessage(input)).toEqual({
			...message,
			payload: new Uint8Array([7, 8, 9]),
		});
	});

	test("recognizes cross-realm fixed and resizable binary brands", () => {
		const crossRealmBuffer = runInNewContext(
			"new ArrayBuffer(8)",
		) as ArrayBuffer;
		const crossRealmView = runInNewContext(
			"Uint8Array.from([0, 1, 2, 253, 254, 255])",
		) as Uint8Array;
		const encoded = encodeWireMessage(message);
		const crossRealmInput = runInNewContext("Uint8Array.from(bytes)", {
			bytes: encoded,
		}) as Uint8Array;
		const crossRealmDataView = runInNewContext(
			"new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)",
			{ bytes: encoded },
		) as DataView;
		const queue = new ByteBoundedQueue<unknown>({ maxBytes: 32 });
		expect(queue.tryPush(crossRealmBuffer)).toBe(true);
		expect(queue.bytes).toBe(8);
		expect(queue.tryPush(crossRealmView)).toBe(true);
		expect(decodeWireMessage(crossRealmInput)).toEqual(message);
		expect(decodeWireMessage(crossRealmDataView)).toEqual(message);
		const crossRealmResizable = runInNewContext(
			"new ArrayBuffer(8, { maxByteLength: 16 })",
		) as ArrayBuffer;
		expect(() => queue.tryPush(crossRealmResizable)).toThrow(/resizable/i);
	});

	test("preflights oversized binary spans before allocating snapshots", () => {
		const encoded = encodeWireMessage(message);
		const originalUint8Array = Uint8Array;
		const guardedConstructor = function GuardedUint8Array(
			..._args: ConstructorParameters<typeof Uint8Array>
		): Uint8Array {
			throw new Error("unexpected binary snapshot allocation");
		} as unknown as typeof Uint8Array;
		Object.defineProperty(guardedConstructor, "prototype", {
			value: originalUint8Array.prototype,
		});
		const previous = Object.getOwnPropertyDescriptor(globalThis, "Uint8Array");
		try {
			Object.defineProperty(globalThis, "Uint8Array", {
				configurable: true,
				writable: true,
				value: guardedConstructor,
			});
			expect(() =>
				encodeWireMessage(
					{ ...message, payload: new originalUint8Array(9) },
					{ maxPayloadBytes: 8 },
				),
			).toThrow(/payload|maximum|oversized/i);
			expect(() =>
				decodeWireMessage(encoded, {
					maxWireBytes: WIRE_FIXED_HEADER_BYTES + 2,
				}),
			).toThrow(/wire|maximum|oversized/i);
		} finally {
			if (previous) Object.defineProperty(globalThis, "Uint8Array", previous);
			else Reflect.deleteProperty(globalThis, "Uint8Array");
		}
	});

	test("requires own finite nowMs when rejecting expired envelopes", () => {
		const encoded = encodeWireMessage(message);
		expect(() => decodeWireMessage(encoded, { rejectExpired: true })).toThrow(
			/nowMs/i,
		);
		expect(() =>
			decodeWireMessage(encoded, { nowMs: Number.NaN, rejectExpired: true }),
		).toThrow(/nowMs/i);
		const inherited = Object.create({ nowMs: 1_000 }) as {
			rejectExpired: true;
		};
		inherited.rejectExpired = true;
		expect(() => decodeWireMessage(encoded, inherited)).toThrow(/own/i);
	});

	test("rejects polluted descriptor maps and descriptor fields", () => {
		const previousRunId = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"runId",
		);
		const previousNowMs = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"nowMs",
		);
		const previousValue = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"value",
		);
		try {
			Object.defineProperty(Object.prototype, "runId", {
				configurable: true,
				value: { value: message.runId },
			});
			const missingRunId = {
				sessionId: message.sessionId,
				sequence: message.sequence,
				expiresAtMs: message.expiresAtMs,
				payload: message.payload,
			};
			expect(() => encodeWireMessage(missingRunId as never)).toThrow(/own/i);

			Object.defineProperty(Object.prototype, "nowMs", {
				configurable: true,
				value: { value: 2_000 },
			});
			expect(() =>
				decodeWireMessage(encodeWireMessage(message), {
					rejectExpired: true,
				}),
			).toThrow(/own|nowMs/i);

			Object.defineProperty(Object.prototype, "value", {
				configurable: true,
				value: "polluted",
			});
			let getterReads = 0;
			const getterMessage = {
				get runId() {
					getterReads += 1;
					return message.runId;
				},
				sessionId: message.sessionId,
				sequence: message.sequence,
				expiresAtMs: message.expiresAtMs,
				payload: message.payload,
			};
			expect(decodeWireMessage(encodeWireMessage(getterMessage))).toEqual(
				message,
			);
			expect(getterReads).toBe(1);
			const unknown = Symbol("unknown");
			expect(() =>
				encodeWireMessage({ ...message, [unknown]: true } as never),
			).toThrow(/unknown/i);
			expect(() =>
				decodeWireMessage(encodeWireMessage(message), {
					[unknown]: true,
				} as never),
			).toThrow(/unknown/i);
		} finally {
			if (previousRunId) {
				Object.defineProperty(Object.prototype, "runId", previousRunId);
			} else {
				Reflect.deleteProperty(Object.prototype, "runId");
			}
			if (previousNowMs) {
				Object.defineProperty(Object.prototype, "nowMs", previousNowMs);
			} else {
				Reflect.deleteProperty(Object.prototype, "nowMs");
			}
			if (previousValue) {
				Object.defineProperty(Object.prototype, "value", previousValue);
			} else {
				Reflect.deleteProperty(Object.prototype, "value");
			}
		}
	});

	test("rejects a non-boolean rejectExpired option", () => {
		const encoded = encodeWireMessage(message);
		expect(() =>
			decodeWireMessage(encoded, { rejectExpired: 1 as never }),
		).toThrow(/boolean|rejectExpired/i);
		expect(() =>
			decodeWireMessage(encoded, { rejectExpired: undefined as never }),
		).toThrow(/boolean|rejectExpired/i);
	});

	test("rejects truncated input before reading the fixed header", () => {
		expect(() => decodeWireMessage(new Uint8Array([0x57]))).toThrow(
			WireFormatError,
		);
	});

	test.each([
		[
			"wrong magic",
			(view: DataView) => view.setUint16(0, WIRE_MAGIC ^ 1, false),
		],
		[
			"unsupported version",
			(view: DataView) => view.setUint8(2, WIRE_VERSION + 1),
		],
	] as const)("rejects a full-length fixture with %s", (_label, mutate) => {
		const encoded = encodeWireMessage(message);
		mutate(
			new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength),
		);
		let thrown: unknown;
		try {
			decodeWireMessage(encoded);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(WireFormatError);
		expect((thrown as WireFormatError).code).toBe("malformed");
	});

	test.each([
		["runId", 6],
		["sessionId", 8],
	] as const)("rejects a zero %s length symmetrically with the encoder", (_label, offset) => {
		const encoded = encodeWireMessage(message);
		const view = new DataView(
			encoded.buffer,
			encoded.byteOffset,
			encoded.byteLength,
		);
		view.setUint16(offset, 0, false);
		let thrown: unknown;
		try {
			decodeWireMessage(encoded);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(WireFormatError);
		expect((thrown as WireFormatError).message).toContain(`${_label} length`);
	});

	test("rejects payloads over the configured and default caps", () => {
		const oversizedPayload = new Uint8Array(9);
		expect(() =>
			encodeWireMessage(
				{ ...message, payload: oversizedPayload },
				{
					maxPayloadBytes: 8,
				},
			),
		).toThrow(/payload/i);
		expect(DEFAULT_MAX_WIRE_PAYLOAD_BYTES).toBeGreaterThan(0);
	});

	test("rejects malformed UTF-8 and trailing bytes", () => {
		const encoded = encodeWireMessage(message);
		const withTrailing = new Uint8Array(encoded.byteLength + 1);
		withTrailing.set(encoded);
		withTrailing[withTrailing.length - 1] = 0xff;
		expect(() => decodeWireMessage(withTrailing)).toThrow(WireFormatError);

		const malformedId = encodeWireMessage({ ...message, runId: "run" });
		const idOffset = 38;
		malformedId[idOffset] = 0xff;
		expect(() => decodeWireMessage(malformedId)).toThrow(WireFormatError);
	});

	test("rejects unpaired UTF-16 surrogates and round-trips valid pairs", () => {
		const unicodeMessage = {
			...message,
			runId: "run-🚀",
			sessionId: "session-🧪",
		};
		expect(decodeWireMessage(encodeWireMessage(unicodeMessage))).toEqual(
			unicodeMessage,
		);
		expect(() =>
			encodeWireMessage({ ...message, runId: "bad-\ud800" }),
		).toThrow(/surrogate/i);
		expect(() =>
			encodeWireMessage({ ...message, sessionId: "bad-\udfff" }),
		).toThrow(/surrogate/i);
	});

	test("enforces uint32 payload and compatible total wire limits", () => {
		expect(MAX_WIRE_PAYLOAD_BYTES).toBe(0xffff_ffff);
		expect(MAX_WIRE_TOTAL_BYTES).toBeGreaterThan(MAX_WIRE_PAYLOAD_BYTES);
		expect(() =>
			encodeWireMessage(message, {
				maxPayloadBytes: MAX_WIRE_PAYLOAD_BYTES + 1,
			}),
		).toThrow(/uint32/i);
		expect(() =>
			decodeWireMessage(encodeWireMessage(message), {
				maxPayloadBytes: MAX_WIRE_PAYLOAD_BYTES + 1,
			}),
		).toThrow(/uint32/i);
		expect(() =>
			encodeWireMessage(message, { maxWireBytes: MAX_WIRE_TOTAL_BYTES + 1 }),
		).toThrow(/wire|maximum|uint/i);
	});

	test("enforces byte capacity and exposes high/low watermark transitions", () => {
		const queue = new ByteBoundedQueue<Uint8Array>({
			maxBytes: 10,
			highWaterMark: 8,
			lowWaterMark: 3,
		});

		expect(queue.tryPush(new Uint8Array(5))).toBe(true);
		expect(queue.bytes).toBe(5);
		expect(queue.aboveHighWaterMark).toBe(false);
		expect(queue.tryPush(new Uint8Array(3))).toBe(true);
		expect(queue.aboveHighWaterMark).toBe(true);
		expect(queue.tryPush(new Uint8Array(3))).toBe(false);
		expect(queue.bytes).toBe(8);
		expect(queue.shift()?.byteLength).toBe(5);
		expect(queue.belowLowWaterMark).toBe(true);
	});

	test("bounds item metadata separately from bytes and rejects zero-byte entries", () => {
		expect(Number.isSafeInteger(DEFAULT_MAX_QUEUE_ITEMS)).toBe(true);
		expect(DEFAULT_MAX_QUEUE_ITEMS).toBeGreaterThan(0);
		const queue = new ByteBoundedQueue<Uint8Array>({
			maxBytes: 100,
			maxItems: 2,
		});
		expect(queue.tryPush(new Uint8Array([1]))).toBe(true);
		expect(queue.tryPush(new Uint8Array([2]))).toBe(true);
		expect(queue.tryPush(new Uint8Array([3]))).toBe(false);
		expect(() => queue.tryPush(new Uint8Array(0))).toThrow(/zero|positive/i);
		expect(
			() => new ByteBoundedQueue<Uint8Array>({ maxBytes: 10, maxItems: 0 }),
		).toThrow(/maxItems/i);
	});

	test("rejects resizable ArrayBuffer backing and untrusted byteLength objects", () => {
		const resizable = new ArrayBuffer(8, { maxByteLength: 16 });
		const queue = new ByteBoundedQueue<unknown>({ maxBytes: 32 });
		expect(() => queue.tryPush(resizable)).toThrow(/resizable/i);
		expect(() => queue.tryPush(new Uint8Array(resizable))).toThrow(
			/resizable/i,
		);
		expect(() => queue.tryPush({ byteLength: 1 })).toThrow(/sizeOf/i);
	});

	test("uses intrinsic binary sizes and validates fixed backing before custom sizing", () => {
		const fixed = new ArrayBuffer(8);
		Object.defineProperty(fixed, "byteLength", {
			configurable: true,
			value: 1,
		});
		const fixedQueue = new ByteBoundedQueue<ArrayBuffer>({ maxBytes: 8 });
		expect(fixedQueue.tryPush(fixed)).toBe(true);
		expect(fixedQueue.bytes).toBe(8);

		const resizable = new ArrayBuffer(8, { maxByteLength: 16 });
		Object.defineProperties(resizable, {
			resizable: { configurable: true, value: false },
			maxByteLength: { configurable: true, value: 8 },
		});
		const customQueue = new ByteBoundedQueue<ArrayBuffer>({
			maxBytes: 8,
			sizeOf: () => 1,
		});
		expect(() => customQueue.tryPush(resizable)).toThrow(/resizable/i);
	});

	test("snapshots queue constructor options once and rejects polluted options", () => {
		const reads = new Map<string, number>();
		const read = <T>(name: string, value: T): T => {
			reads.set(name, (reads.get(name) ?? 0) + 1);
			return value;
		};
		let maxBytes = 8;
		const options = {} as ByteBoundedQueueOptions<number>;
		Object.defineProperties(options, {
			maxBytes: {
				configurable: true,
				get: () => read("maxBytes", maxBytes),
			},
			highWaterMark: {
				configurable: true,
				get: () => read("highWaterMark", 6),
			},
			lowWaterMark: {
				configurable: true,
				get: () => read("lowWaterMark", 2),
			},
			sizeOf: {
				configurable: true,
				get: () => read("sizeOf", (_value: number) => 1),
			},
		});
		const queue = new ByteBoundedQueue(options);
		maxBytes = 1;
		expect(queue.maxBytes).toBe(8);
		expect(queue.highWaterMark).toBe(6);
		expect(queue.lowWaterMark).toBe(2);
		expect(queue.tryPush(1)).toBe(true);
		for (const name of [
			"maxBytes",
			"highWaterMark",
			"lowWaterMark",
			"sizeOf",
		]) {
			expect(reads.get(name)).toBe(1);
		}

		const unknown = Symbol("unknown");
		expect(
			() => new ByteBoundedQueue({ maxBytes: 8, [unknown]: true } as never),
		).toThrow(/unknown|unsupported/i);

		const previous = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"maxBytes",
		);
		try {
			Object.defineProperty(Object.prototype, "maxBytes", {
				configurable: true,
				value: 8,
			});
			expect(() => new ByteBoundedQueue({ sizeOf: () => 1 } as never)).toThrow(
				/own|maxBytes/i,
			);
		} finally {
			if (previous)
				Object.defineProperty(Object.prototype, "maxBytes", previous);
			else Reflect.deleteProperty(Object.prototype, "maxBytes");
		}
	});

	test("rejects malformed queue wait arguments before consuming waiter capacity", () => {
		const queue = new ByteBoundedQueue<number>({
			maxBytes: 8,
			maxWaiters: 1,
			sizeOf: () => 1,
		});
		expect(() => queue.waitForItem({ aborted: false } as never)).toThrow(
			/signal|AbortSignal|unknown/i,
		);
		expect(() =>
			queue.waitForItem({ signal: { aborted: false } } as never),
		).toThrow(/signal|AbortSignal/i);
		expect(queue.pendingWaiters).toBe(0);
	});

	test("accepts empty wait options and rejects inherited signal pollution", async () => {
		const queue = new ByteBoundedQueue<number>({
			maxBytes: 8,
			maxWaiters: 2,
			sizeOf: () => 1,
		});
		queue.tryPush(1);
		expect(await queue.waitForItem({})).toEqual({ done: false, value: 1 });
		queue.tryPush(2);
		const nullPrototypeOptions = Object.create(null) as { signal?: undefined };
		expect(await queue.waitForItem(nullPrototypeOptions)).toEqual({
			done: false,
			value: 2,
		});

		const inheritedController = new AbortController();
		const inheritedOptions = Object.create({
			signal: inheritedController.signal,
		}) as QueueWaitOptions;
		expect(() => queue.waitForItem(inheritedOptions)).toThrow(/plain|option/i);
		expect(queue.pendingItemWaiters).toBe(0);
		inheritedController.abort("must be rejected");

		const watermarkQueue = new ByteBoundedQueue<Uint8Array>({
			maxBytes: 4,
			highWaterMark: 1,
			lowWaterMark: 0,
		});
		watermarkQueue.tryPush(new Uint8Array([1]));
		const watermarkWait = watermarkQueue.waitForLowWaterMark({});
		watermarkQueue.shift();
		expect(await watermarkWait).toBe("low");
		watermarkQueue.tryPush(new Uint8Array([2]));
		const nullPrototypeWatermark = watermarkQueue.waitForLowWaterMark(
			Object.create(null),
		);
		watermarkQueue.shift();
		expect(await nullPrototypeWatermark).toBe("low");
		const inheritedWatermark = Object.create({
			signal: new AbortController().signal,
		});
		expect(() =>
			watermarkQueue.waitForLowWaterMark(inheritedWatermark),
		).toThrow(/plain|option/i);

		expect(() => queue.waitForItem({ unknown: true } as never)).toThrow(
			/unknown|unsupported/i,
		);
		expect(() =>
			watermarkQueue.waitForLowWaterMark({ signal: {} } as never),
		).toThrow(/AbortSignal/i);
	});

	test("rejects an inherited Object.prototype signal without retaining waiters", () => {
		const queue = new ByteBoundedQueue<number>({
			maxBytes: 8,
			sizeOf: () => 1,
		});
		const controller = new AbortController();
		const previous = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"signal",
		);
		try {
			Object.defineProperty(Object.prototype, "signal", {
				configurable: true,
				enumerable: false,
				writable: true,
				value: controller.signal,
			});
			expect(() => queue.waitForItem({})).toThrow(/inherited|polluted|signal/i);
			expect(queue.pendingWaiters).toBe(0);
			expect(() => queue.waitForLowWaterMark({})).toThrow(
				/inherited|polluted|signal/i,
			);
			expect(queue.pendingWaiters).toBe(0);
		} finally {
			if (previous) Object.defineProperty(Object.prototype, "signal", previous);
			else Reflect.deleteProperty(Object.prototype, "signal");
		}
	});

	test("closes deterministically, drains existing items, and rejects later pushes", async () => {
		const queue = new ByteBoundedQueue<number>({
			maxBytes: 16,
			sizeOf: () => 4,
		});
		const pending = queue.waitForItem();
		queue.close("finished");
		expect(await pending).toEqual({ done: true, reason: "finished" });
		expect(queue.tryPush(1)).toBe(false);
		expect(queue.shift()).toBeUndefined();
		expect(queue.closed).toBe(true);
		expect(queue.closeReason).toBe("finished");

		const drainable = new ByteBoundedQueue<number>({
			maxBytes: 16,
			sizeOf: () => 4,
		});
		drainable.tryPush(7);
		drainable.close();
		expect(drainable.shift()).toBe(7);
		expect(drainable.shift()).toBeUndefined();
	});

	test("re-checks close after reentrant sizeOf before reader delivery or enqueue", async () => {
		let queue!: ByteBoundedQueue<number>;
		queue = new ByteBoundedQueue<number>({
			maxBytes: 8,
			sizeOf: () => {
				queue.close("sizeOf closed");
				return 1;
			},
		});
		const pending = queue.waitForItem();

		expect(queue.tryPush(7)).toBe(false);
		expect(queue.closed).toBe(true);
		expect(queue.bytes).toBe(0);
		expect(queue.length).toBe(0);
		expect(queue.drain()).toEqual([]);
		expect(await pending).toEqual({ done: true, reason: "sizeOf closed" });
		expect(await queue.waitForItem()).toEqual({
			done: true,
			reason: "sizeOf closed",
		});
	});

	test("aborted item waits are removed and waiter capacity is reusable", async () => {
		const queue = new ByteBoundedQueue<number>({
			maxBytes: 16,
			maxItems: 4,
			sizeOf: () => 1,
			maxWaiters: 1,
		});
		const controller = new AbortController();
		const pending = queue.waitForItem({ signal: controller.signal });
		expect(queue.pendingItemWaiters).toBe(1);
		controller.abort("cancelled");
		await pending.catch((reason) => expect(reason).toBe("cancelled"));
		expect(queue.pendingItemWaiters).toBe(0);
		const reusable = queue.waitForItem();
		expect(queue.pendingItemWaiters).toBe(1);
		queue.close("done");
		expect(await reusable).toEqual({ done: true, reason: "done" });
		expect(queue.pendingItemWaiters).toBe(0);
	});

	test("aborted watermark waits are removed and do not consume the total cap", async () => {
		const queue = new ByteBoundedQueue<Uint8Array>({
			maxBytes: 10,
			highWaterMark: 5,
			lowWaterMark: 1,
			maxWaiters: 1,
		});
		queue.tryPush(new Uint8Array([1, 2, 3, 4, 5]));
		const controller = new AbortController();
		const pending = queue.waitForLowWaterMark({ signal: controller.signal });
		expect(queue.pendingWatermarkWaiters).toBe(1);
		controller.abort("cancelled");
		await pending.catch((reason) => expect(reason).toBe("cancelled"));
		expect(queue.pendingWatermarkWaiters).toBe(0);
		const reusable = queue.waitForLowWaterMark();
		queue.shift();
		expect(await reusable).toBe("low");
	});

	test("pacing is open-loop from one epoch and does not drift or catch up implicitly", () => {
		let nowMs = 1_000;
		const pacer = new OpenLoopPacer({
			ratePerSecond: 10,
			now: () => nowMs,
			catchUp: "none",
		});

		expect(pacer.nextSlot()).toMatchObject({
			sequence: 0,
			scheduledAtMs: 1_000,
			latenessMs: 0,
			skippedSlots: 0,
		});
		nowMs = 1_250;
		expect(pacer.nextSlot()).toMatchObject({
			sequence: 1,
			scheduledAtMs: 1_100,
			latenessMs: 150,
			skippedSlots: 0,
		});
		expect(pacer.nextSlot()).toMatchObject({
			sequence: 2,
			scheduledAtMs: 1_200,
			latenessMs: 50,
			skippedSlots: 0,
		});
	});

	test("skip mode records missed slots and never emits a catch-up burst", () => {
		let nowMs = 1_000;
		const pacer = new OpenLoopPacer({
			ratePerSecond: 10,
			now: () => nowMs,
		});
		expect(pacer.catchUp).toBe("skip");
		pacer.nextSlot();
		nowMs = 1_250;
		expect(pacer.nextSlot()).toMatchObject({
			sequence: 2,
			skippedSlots: 1,
			latenessMs: 50,
		});
		expect(pacer.nextSlot()).toMatchObject({
			sequence: 3,
			skippedSlots: 0,
			delayMs: 50,
		});
	});

	test("validates catch-up policy at runtime and bounds a hung sleeper by deadline", async () => {
		for (const catchUp of ["repay", null, 0] as unknown[]) {
			expect(
				() =>
					new OpenLoopPacer({
						ratePerSecond: 10,
						catchUp: catchUp as never,
					}),
			).toThrow(/catchUp/i);
		}

		let receivedSignal: AbortSignal | undefined;
		const pacer = new OpenLoopPacer({
			ratePerSecond: 1,
			now: () => 0,
			sleep: ((_: number, signal?: AbortSignal) => {
				receivedSignal = signal;
				return new Promise<void>(() => {});
			}) as (milliseconds: number) => Promise<void>,
		});
		pacer.nextSlot();
		await expect(pacer.waitNext(10)).rejects.toBeInstanceOf(PacerDeadlineError);
		expect(receivedSignal).toBeInstanceOf(AbortSignal);
		expect(receivedSignal?.aborted).toBe(true);
	});

	test("rejects a finite deadline remainder above the native timer maximum before sleeping", async () => {
		let sleepCalls = 0;
		const pacer = new OpenLoopPacer({
			ratePerSecond: 1,
			now: () => 0,
			sleep: async () => {
				sleepCalls += 1;
			},
		});
		pacer.nextSlot();
		await expect(pacer.waitNext(3_000_000_000)).rejects.toThrow(
			/timer|deadline|maximum/i,
		);
		expect(sleepCalls).toBe(0);
	});

	test("rejects an infinite-deadline delay above the native timer maximum before sleeping", async () => {
		let sleepCalls = 0;
		const pacer = new OpenLoopPacer({
			ratePerSecond: 1e-7,
			now: () => 0,
			sleep: async () => {
				sleepCalls += 1;
			},
		});
		pacer.nextSlot();
		await expect(pacer.waitNext()).rejects.toThrow(/timer|delay|maximum/i);
		expect(sleepCalls).toBe(0);
	});

	test("freezes skip as the safe default open-loop policy", () => {
		const pacer = new OpenLoopPacer({ ratePerSecond: 10, now: () => 0 });
		expect(pacer.catchUp).toBe("skip");
	});

	test("uses a monotonic default clock and snapshots pacer options", () => {
		const previousDateNow = Object.getOwnPropertyDescriptor(Date, "now");
		let dateNow = 1_000;
		try {
			Object.defineProperty(Date, "now", {
				configurable: true,
				writable: true,
				value: () => dateNow,
			});
			const defaultClockPacer = new OpenLoopPacer({ ratePerSecond: 10 });
			const first = defaultClockPacer.nextSlot();
			dateNow = 900;
			const second = defaultClockPacer.nextSlot();
			expect(second.emittedAtMs).toBeGreaterThanOrEqual(first.emittedAtMs);
		} finally {
			if (previousDateNow) Object.defineProperty(Date, "now", previousDateNow);
			else Reflect.deleteProperty(Date, "now");
		}

		const previousRate = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"ratePerSecond",
		);
		const previousValue = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"value",
		);
		try {
			Object.defineProperty(Object.prototype, "ratePerSecond", {
				configurable: true,
				value: { value: 10 },
			});
			expect(() => new OpenLoopPacer({ now: () => 0 } as never)).toThrow(
				/own|rate/i,
			);
			Object.defineProperty(Object.prototype, "value", {
				configurable: true,
				value: 9,
			});
			let rateReads = 0;
			const options = {
				get ratePerSecond() {
					rateReads += 1;
					return 10;
				},
			};
			const pacer = new OpenLoopPacer(options);
			expect(pacer.ratePerSecond).toBe(10);
			expect(rateReads).toBe(1);
			const unknown = Symbol("unknown");
			expect(
				() =>
					new OpenLoopPacer({ ratePerSecond: 10, [unknown]: true } as never),
			).toThrow(/unknown|unsupported/i);
		} finally {
			if (previousRate) {
				Object.defineProperty(Object.prototype, "ratePerSecond", previousRate);
			} else {
				Reflect.deleteProperty(Object.prototype, "ratePerSecond");
			}
			if (previousValue) {
				Object.defineProperty(Object.prototype, "value", previousValue);
			} else {
				Reflect.deleteProperty(Object.prototype, "value");
			}
		}
	});

	test("rejects backward injected clock observations across pacer operations", async () => {
		let nowMs = 100;
		const pacer = new OpenLoopPacer({
			ratePerSecond: 10,
			now: () => nowMs,
			catchUp: "none",
		});
		pacer.start();
		nowMs = 99;
		expect(() => pacer.nextSlot()).toThrow(/backward|monotonic/i);

		let resetNowMs = 100;
		const resettable = new OpenLoopPacer({
			ratePerSecond: 10,
			now: () => resetNowMs,
		});
		resettable.start();
		resetNowMs = 99;
		expect(() => resettable.reset()).toThrow(/backward|monotonic/i);

		let waitNowMs = 100;
		const waitPacer = new OpenLoopPacer({
			ratePerSecond: 10,
			now: () => waitNowMs,
			sleep: async () => {},
		});
		waitPacer.nextSlot();
		waitNowMs = 99;
		await expect(waitPacer.waitNext(200)).rejects.toThrow(
			/backward|monotonic/i,
		);
	});

	test("rejects nonrepresentable rates, epochs, derived slots, and clock overflow", () => {
		expect(
			() => new OpenLoopPacer({ ratePerSecond: Number.MIN_VALUE }),
		).toThrow(/interval|rate/i);
		expect(() => new OpenLoopPacer({ ratePerSecond: 1e20 })).toThrow(
			/interval|rate/i,
		);
		expect(() =>
			new OpenLoopPacer({
				ratePerSecond: 1,
				now: () => Number.MAX_VALUE,
			}).nextSlot(),
		).toThrow(/epoch|safe|representable/i);
		const pacer = new OpenLoopPacer({
			ratePerSecond: 1,
			now: () => Number.MAX_SAFE_INTEGER - 1_000,
			catchUp: "none",
		});
		pacer.nextSlot();
		expect(() => pacer.nextSlot()).toThrow(/slot|safe|representable/i);
		const clock = new ManualClock(Number.MAX_SAFE_INTEGER - 1);
		expect(() => clock.advance(2)).toThrow(/overflow|safe/i);
	});

	test("rejects intervals that collapse at the selected epoch", () => {
		const epochMs = 1_000_000_000;
		const pacer = new OpenLoopPacer({
			ratePerSecond: 1e12,
			now: () => epochMs,
			catchUp: "none",
		});
		expect(() => pacer.start()).toThrow(/monotonic|precision|representable/i);

		const resettable = new OpenLoopPacer({
			ratePerSecond: 1e12,
			now: () => 0,
			catchUp: "none",
		});
		resettable.nextSlot();
		expect(() => resettable.reset(epochMs)).toThrow(
			/monotonic|precision|representable/i,
		);
	});

	test("rejects sequence slots that collapse after a large offset", () => {
		const pacer = new OpenLoopPacer({
			ratePerSecond: 100_000,
			now: () => 0,
			catchUp: "none",
		});
		expect(() => pacer.dueAt(Number.MAX_SAFE_INTEGER - 1)).toThrow(
			/increasing|monotonic|precision|representable/i,
		);
	});

	test("rejects an unsafe manual-clock duration before adding it", () => {
		const clock = new ManualClock(-1);
		expect(() => clock.advance(Number.MAX_SAFE_INTEGER + 1)).toThrow(
			/duration|safe|representable/i,
		);
	});

	test("reset starts a new warmup epoch and sequence", () => {
		let nowMs = 10;
		const pacer = new OpenLoopPacer({ ratePerSecond: 2, now: () => nowMs });
		pacer.nextSlot();
		nowMs = 2_000;
		pacer.reset();
		expect(pacer.nextSlot()).toMatchObject({
			sequence: 0,
			scheduledAtMs: 2_000,
			latenessMs: 0,
		});
	});

	test("orders percentiles without mutating input and rejects non-finite samples", () => {
		const values = [9, 1, 4, 2, 8, 3, 7, 5, 6];
		expect(percentile(values, 50)).toBe(5);
		expect(percentile(values, 95)).toBeGreaterThanOrEqual(
			percentile(values, 50),
		);
		expect(percentile(values, 99)).toBeGreaterThanOrEqual(
			percentile(values, 95),
		);
		expect(values).toEqual([9, 1, 4, 2, 8, 3, 7, 5, 6]);
		expect(() => percentile([], 50)).toThrow(/empty/i);
		expect(() => percentile([1, Number.NaN], 50)).toThrow(/finite/i);
		expect(() => percentile(new Array(2), 50)).toThrow(/finite|number/i);

		const source = [1, 3];
		let firstRead = true;
		const mutating = new Proxy(source, {
			get(target, property, receiver) {
				if (property === "0") {
					const value = firstRead ? 1 : 100;
					firstRead = false;
					return value;
				}
				return Reflect.get(target, property, receiver);
			},
		}) as unknown as readonly number[];
		expect(percentile(mutating, 50)).toBe(2);
	});

	test("requires an own finite expiry timestamp", () => {
		const inherited = Object.create({
			expiresAtMs: message.expiresAtMs,
		}) as typeof message;
		expect(() => isWireMessageExpired(inherited, 2_000)).toThrow(
			/own|expires/i,
		);
		expect(() =>
			isWireMessageExpired({ ...message, expiresAtMs: Number.NaN }, 0),
		).toThrow(/expires/i);
		expect(() =>
			isWireMessageExpired(
				{ ...message, expiresAtMs: Number.POSITIVE_INFINITY },
				0,
			),
		).toThrow(/expires/i);
	});

	test("summarizes finite samples with a Student-t 95% confidence interval", () => {
		const summary = sampleSummary([1, 2, 3, 4, 5]);
		expect(summary.count).toBe(5);
		expect(summary.mean).toBe(3);
		expect(summary.stddev).toBeCloseTo(Math.sqrt(2.5));
		expect(summary.ci95Low).toBeLessThan(3);
		expect(summary.ci95High).toBeGreaterThan(3);
		expect(summary.ci95Low).toBeLessThanOrEqual(1.04);
		expect(summary.ci95High).toBeGreaterThanOrEqual(4.96);
		expect(studentTCritical95(5)).toBeCloseTo(2.776, 3);
		expect(() => sampleSummary([])).toThrow(/empty/i);
		expect(() => sampleSummary([1, Number.POSITIVE_INFINITY])).toThrow(
			/finite/i,
		);
	});

	test("fails closed for invalid Student-t sample counts", () => {
		for (const sampleCount of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			-1,
			0,
			1,
			1.5,
		]) {
			expect(() => studentTCritical95(sampleCount)).toThrow(/sample count/i);
		}
		expect(sampleSummary([7]).ci95Low).toBe(7);
		expect(studentTCritical95(1e15)).toBeCloseTo(1.959964, 5);
	});

	test("keeps extreme finite summaries finite or rejects unrepresentable results", () => {
		const repeatedMaximum = sampleSummary([Number.MAX_VALUE, Number.MAX_VALUE]);
		for (const value of [
			repeatedMaximum.mean,
			repeatedMaximum.stddev,
			repeatedMaximum.ci95Low,
			repeatedMaximum.ci95High,
			repeatedMaximum.p50,
			repeatedMaximum.p95,
			repeatedMaximum.p99,
		]) {
			expect(Number.isFinite(value)).toBe(true);
		}
		expect(() => sampleSummary([Number.MAX_VALUE, -Number.MAX_VALUE])).toThrow(
			/finite|overflow/i,
		);
	});
});

// ---------------------------------------------------------------------------
// The measurement driver, exercised end to end without a cable.
//
// These are the tests that stand where `measureCellArm` used to. That function
// needed no fixture at all — it read `transport === "wt"` and returned a
// number — so nothing in the suite could tell a measured latency from an
// authored one. Everything below drives the real `WebSocketAdapter` over two
// cross-wired fake sockets: the client's frames reach the server's handler and
// the server's reach the client's listener, so a sample is a genuine round trip
// through the adapter, the wire codec, and the echo peer.
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

class LoopClientSocket implements ClientWebSocketLike {
	readonly listeners = new Map<string, Set<Listener>>();
	readyState = 0;
	bufferedAmount = 0;
	binaryType = "uint8array" as const;
	onSend: (bytes: Uint8Array) => void = () => {};

	send(data: string | ArrayBuffer | ArrayBufferView): void {
		if (typeof data === "string") return;
		const bytes =
			data instanceof ArrayBuffer
				? new Uint8Array(data)
				: new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		this.onSend(bytes.slice());
	}

	close(code?: number, reason?: string): void {
		this.readyState = 3;
		this.emit("close", { code: code ?? 1000, reason: reason ?? "" });
	}

	addEventListener(type: string, listener: EventListener): void {
		const set = this.listeners.get(type) ?? new Set<Listener>();
		set.add(listener as unknown as Listener);
		this.listeners.set(type, set);
	}

	removeEventListener(type: string, listener: EventListener): void {
		this.listeners.get(type)?.delete(listener as unknown as Listener);
	}

	emit(type: string, ...args: unknown[]): void {
		for (const listener of [...(this.listeners.get(type) ?? [])])
			listener(...args);
	}

	open(): void {
		this.readyState = 1;
		this.emit("open", {});
	}

	receive(data: Uint8Array): void {
		this.emit("message", { data });
	}
}

class LoopServerSocket implements ServerWebSocketLike {
	readonly listeners = new Map<string, Set<Listener>>();
	readonly remoteAddress = "10.99.0.1";
	readyState = 1 as const;
	data: { readonly role?: string } = {};
	onSend: (bytes: Uint8Array) => void = () => {};

	send(data: string | ArrayBuffer | ArrayBufferView): number {
		if (typeof data === "string") return data.length;
		const bytes =
			data instanceof ArrayBuffer
				? new Uint8Array(data).slice()
				: new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
		this.onSend(bytes);
		return bytes.byteLength;
	}

	close(): void {
		this.readyState = 3 as 1;
		this.emit("close", 1000, "");
	}

	addEventListener(type: string, listener: EventListener): void {
		const set = this.listeners.get(type) ?? new Set<Listener>();
		set.add(listener as unknown as Listener);
		this.listeners.set(type, set);
	}

	removeEventListener(type: string, listener: EventListener): void {
		this.listeners.get(type)?.delete(listener as unknown as Listener);
	}

	emit(type: string, ...args: unknown[]): void {
		for (const listener of [...(this.listeners.get(type) ?? [])])
			listener(...args);
	}
}

class LoopServerRuntime implements WebSocketServerRuntime {
	readonly options: WebSocketServerRuntimeOptions;
	stopped = false;

	constructor(options: WebSocketServerRuntimeOptions) {
		this.options = options;
	}

	stop(): void {
		this.stopped = true;
	}

	open(socket: LoopServerSocket): void {
		this.options.websocket.open?.(socket);
	}

	receive(socket: LoopServerSocket, data: Uint8Array): void {
		this.options.websocket.message(socket, data);
	}
}

const LOOP_CLIENT_TLS = Object.freeze({
	ca: "CA",
	serverName: "wt-compare.local",
	rejectUnauthorized: true,
});

/**
 * A client session and the peer that answers it, wired socket to socket.
 *
 * Neither side is told which transport it is: the driver gets a `Session` and
 * the peer gets a `ServerHandle`, and every method they call is on the shared
 * `TransportAdapter` interface.
 */
async function connectedWebSocketPair(clock: TransportClock) {
	const clientSocket = new LoopClientSocket();
	const serverSocket = new LoopServerSocket();
	let runtime: LoopServerRuntime | undefined;

	const serverAdapter = new WebSocketAdapter({
		clock,
		serverFactory: (options) => {
			runtime = new LoopServerRuntime(options);
			return runtime;
		},
	});
	const server = await serverAdapter.startServer({
		port: 4433,
		role: "publisher",
		tls: { cert: "cert", key: "key", serverName: "wt-compare.local" },
	});
	if (!runtime) throw new Error("server runtime was not created");
	const openRuntime = runtime;
	openRuntime.open(serverSocket);

	// Delivery is a microtask in each direction rather than a synchronous call.
	// Re-entering the peer's handler from inside `send` would let a reply land
	// before the sender had finished attaching its own message listener, which
	// no socket does and which loses the handshake acknowledgement.
	clientSocket.onSend = (bytes) =>
		queueMicrotask(() => openRuntime.receive(serverSocket, bytes));
	serverSocket.onSend = (bytes) =>
		queueMicrotask(() => clientSocket.receive(bytes));

	const clientAdapter = new WebSocketAdapter({
		clock,
		clientFactory: () => {
			queueMicrotask(() => clientSocket.open());
			return clientSocket;
		},
	});
	const [clientSession, serverSession] = await Promise.all([
		clientAdapter.connect({
			url: "wss://wt-compare.local:4433/compare",
			role: "publisher",
			tls: LOOP_CLIENT_TLS,
			deadlineMs: clock.nowMs() + 1_000,
		}),
		server.acceptSession(clock.nowMs() + 1_000),
	]);
	return { clientSession, serverSession, server };
}

/**
 * A WT client session and the peer that answers it, stream to stream.
 *
 * The WS pair above proves nothing about the arm the campaign is actually
 * comparing WS *against*, and until this existed nothing exercised the WT
 * adapter's receive path against its own send path at all -- which is how a
 * funnel stage that no WT code could ever write survived in the artifact.
 * Every byte here goes through the same envelope, the same persistent stream
 * and the same counters the production adapter uses; only the QUIC underneath
 * is a pipe.
 */
function asyncHandoff<T>() {
	const items: T[] = [];
	const waiters: ((value: T) => void)[] = [];
	return {
		push(value: T): void {
			const waiter = waiters.shift();
			if (waiter) waiter(value);
			else items.push(value);
		},
		take(): Promise<T> {
			const ready = items.shift();
			if (ready !== undefined) return Promise.resolve(ready);
			return new Promise<T>((resolve) => waiters.push(resolve));
		},
	};
}

async function connectedWebTransportPair(clock: TransportClock) {
	let liveClientUni = 0;
	let clientLimits: Record<string, number> | undefined;
	const submittedUniLimit = () =>
		clientLimits?.["maxStreamsPerSessionUni"] ?? Number.POSITIVE_INFINITY;
	const toServerStreams = asyncHandoff<PassThrough>();
	const toClientStreams = asyncHandoff<PassThrough>();
	const toServerDatagrams = asyncHandoff<Uint8Array>();
	const toClientDatagrams = asyncHandoff<Uint8Array>();
	const idle = () => new Promise<never>(() => {});

	const clientNative = {
		id: "loop-client",
		peer: { ip: "10.99.0.1", port: 12345 },
		has0Rtt: false,
		accepted0Rtt: false,
		handshakeConfirmed: true,
		ready: Promise.resolve(),
		closed: idle(),
		draining: idle(),
		close: () => {},
		drain: () => {},
		sendDatagram: async (bytes: Uint8Array) => {
			toServerDatagrams.push(bytes);
		},
		incomingDatagrams: async function* () {
			for (;;) yield await toClientDatagrams.take();
		},
		// The fake enforces the uni-stream limit the adapter actually submitted,
		// because a fake that enforces the number the test picked would prove
		// something about the test.
		createUnidirectionalStream: async () => {
			if (liveClientUni >= submittedUniLimit()) {
				throw new Error(
					`E_LIMIT_EXCEEDED: maxStreamsPerSessionUni ${submittedUniLimit()} exhausted`,
				);
			}
			liveClientUni += 1;
			const pipe = new PassThrough();
			toServerStreams.push(pipe);
			return pipe;
		},
		incomingUnidirectionalStreams: async function* () {
			for (;;) yield await toClientStreams.take();
		},
		createBidirectionalStream: async () => {
			throw new Error("the message path uses unidirectional streams only");
		},
		incomingBidirectionalStreams: async function* () {
			await idle();
		},
		metricsSnapshot: () => ({}),
	};

	const serverNative = {
		id: "loop-server",
		peer: { ip: "10.99.0.2", port: 4433 },
		has0Rtt: false,
		accepted0Rtt: false,
		handshakeConfirmed: true,
		ready: Promise.resolve(),
		closed: idle(),
		draining: idle(),
		close: () => {},
		drain: () => {},
		sendDatagram: async (bytes: Uint8Array) => {
			toClientDatagrams.push(bytes);
		},
		incomingDatagrams: async function* () {
			for (;;) yield await toServerDatagrams.take();
		},
		createUnidirectionalStream: async () => {
			const pipe = new PassThrough();
			toClientStreams.push(pipe);
			return pipe;
		},
		incomingUnidirectionalStreams: new ReadableStream<PassThrough>({
			async pull(controller) {
				controller.enqueue(await toServerStreams.take());
			},
		}),
		incomingBidirectionalStreams: new ReadableStream({
			async pull() {
				await idle();
			},
		}),
		metricsSnapshot: () => ({}),
		goAway: () => {},
	};

	const adapter = createWebTransportAdapter({
		serverFactory: (() => ({
			address: { host: "10.99.0.2", port: 4433 },
			close: async () => {},
			metricsSnapshot: () => ({}),
			goAway: () => {},
			onSession(deliver: (session: unknown) => void) {
				deliver(serverNative);
			},
		})) as never,
		clientFactory: (async (_url: string, options: Record<string, unknown>) => {
			clientLimits = options["limits"] as Record<string, number>;
			return clientNative;
		}) as never,
		clock,
	});
	const server = await adapter.startServer({
		port: 4433,
		tls: { cert: "cert", key: "key" },
	} as never);
	const [clientSession, serverSession] = await Promise.all([
		adapter.connect({
			url: "https://10.99.0.2:4433",
			role: "publisher",
			deadlineMs: clock.nowMs() + 1_000,
		} as never),
		server.acceptSession(clock.nowMs() + 1_000),
	]);
	return { clientSession, serverSession, server };
}

/**
 * The clock the driver is handed, wrapped so the test can count its reads.
 *
 * It reads real sub-millisecond time rather than a canned sequence, so a
 * latency the driver reports is a real interval; the counter is what lets the
 * test show the driver took every timestamp from this clock and none from
 * anywhere else.
 */
function countingClock(): TransportClock & { readonly reads: number } {
	let reads = 0;
	return {
		get reads() {
			return reads;
		},
		nowMs() {
			reads++;
			return performance.timeOrigin + performance.now();
		},
		sleep: (milliseconds: number) =>
			new Promise<void>((resolve) => {
				setTimeout(resolve, Math.max(0, milliseconds));
			}),
		method: "test.performance",
	};
}

describe("the measurement driver produces samples it observed", () => {
	// A latency cell, and it has to be one. These tests run real legs and
	// publish some of them, and the driver's samples are per-message round trips
	// in milliseconds -- so the only contract they can honestly be sealed under
	// is one that names ms. This block used to run every leg against
	// `chat-fanout`, whose contract publishes delivered-messages-per-second: the
	// tests passed, and what they were proving was that milliseconds could be
	// stamped as a rate without anything objecting.
	const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
		(candidate) => candidate.cellId === "handshake-matrix/physical-cold",
	)!;
	const latencyContract = PRIMARY_METRIC_CONTRACTS[
		"handshake-matrix"
	] as MetricContract;

	// The funnel's middle stage used to be zero on every arm of every
	// comparison, because `acknowledged` counted a receipt no encoder anywhere
	// produced. Both arms are asserted in one test on purpose: a signal that
	// only one transport can carry is the asymmetry this whole exercise is
	// about, so the property is "both arms count the same receipts for the same
	// messages", not "WS has an ack".
	test.each([
		["ws", connectedWebSocketPair],
		["wt", connectedWebTransportPair],
	] as const)("the %s arm acknowledges every message it admits, on the shared envelope", async (_arm, connect) => {
		const clock = countingClock();
		const { clientSession, serverSession } = await connect(clock);
		const plan = {
			deliveryKind: "reliable-message",
			messageCount: 5,
			messageBytes: 64,
		} as const;

		const peer = echoSession({
			session: serverSession,
			deliveryKind: plan.deliveryKind,
			messageLimit: plan.messageCount,
			clock,
			perMessageTimeoutMs: 2_000,
		});
		const leg = await runMeasuredLeg({
			session: clientSession,
			plan,
			driverRunId: "driver-ack",
			runId: "run-ack",
			sessionId: "session-ack",
			clock,
			perMessageTimeoutMs: 2_000,
			contract: latencyContract,
		});
		await peer;

		// Five messages out, five echoes back, five receipts for the echoes
		// this arm admitted -- and, on the peer's side, five receipts for the
		// five it admitted. None of these five numbers could be non-zero
		// before, and `delivered` was clamped to the zero above it.
		expect(leg.samples).toHaveLength(5);
		expect(leg.ledger.attempted).toBe(5);
		expect(leg.ledger.queued).toBe(5);
		expect(leg.ledger.delivered).toBe(5);
		expect(leg.ledger.acknowledged).toBe(5);
		expect(leg.ledger.serverObserved).toBe(5);
		// The peer is asserted exactly as hard as the client, and that is the
		// point of asserting it at all. It used to be asserted more weakly
		// (`acknowledged >= 4`), with the gap explained as peer-side timing on
		// the unmeasured side of the leg. It was not timing. WS counted a
		// receipt when the socket handed it over and WT counted one only while
		// somebody was inside `receiveMessage`, so the trailing receipt -- and
		// there is always a trailing receipt -- was counted on one arm and not
		// on the other, with no loss anywhere. The one counter introduced to
		// make the arms comparable was the one counter the arms computed
		// differently, so equality is proved on an honest run here rather than
		// asserted in prose.
		const peerLedger = serverSession.snapshot();
		expect(peerLedger.delivered).toBe(5);
		expect(peerLedger.serverObserved).toBe(5);
		expect(peerLedger.acknowledged).toBe(5);

		// And the peer's own ledger has to be buildable. This is the shape the
		// single chain refused: the peer's counters are the same five stages in
		// the same object, and ordering `delivered` under `acknowledged` made
		// an honest zero-loss run unbuildable on WT. The samples are the client
		// leg's, because the peer took none; the ledger under test is the
		// peer's.
		const peerExecution = {
			campaignId: "peer-ledger",
			runId: "run-ack-peer",
			executionIndex: 1,
			transport: "ws",
		};
		const peerGrant = grantFor(peerExecution);
		const peerArtifact = buildMeasuredArmArtifact({
			cell,
			comparisonId: "peer-ledger",
			runId: "run-ack-peer",
			executionIndex: 1,
			transport: "ws",
			armKind: "primary",
			measurement: {
				// What the samples are in, from the leg that took them, rather
				// than from what this cell would like them to be.
				sampleUnit: leg.sampleUnit,
				toolchains: R1_FIXTURE_TOOLCHAINS,
				samples: leg.samples,
				percentiles: leg.percentiles,
				ledger: {
					attempted: peerLedger.attempted,
					queued: peerLedger.queued,
					serverObserved: peerLedger.serverObserved,
					acknowledged: peerLedger.acknowledged,
					delivered: peerLedger.delivered,
					dropped: peerLedger.dropped,
					expired: peerLedger.timedOut,
				},
				admissionCounters: leg.admissionCounters,
				telemetry: {
					mac: { cpuPercent: 15, rssBytes: 120 * 1024 * 1024 },
					linux: { cpuPercent: 18, rssBytes: 220 * 1024 * 1024 },
				},
				provenance: leg.provenance,
				grant: peerGrant,
				admission: admissionFor({
					execution: peerExecution,
					grant: peerGrant,
					samples: leg.samples,
					delivered: peerLedger.delivered,
					firstSampleAtMs: leg.provenance.firstSampleAtMs,
					lastSampleAtMs: leg.provenance.lastSampleAtMs,
				}),
			},
			supervisorToolchainDigests: SUPERVISOR_TOOLCHAIN_DIGESTS,
		});
		expect(peerArtifact.ledger.acknowledged).toBe(peerLedger.acknowledged);
		expect(peerArtifact.ledger.delivered).toBe(peerLedger.delivered);

		// The receipt's bytes are charged on both arms, and the arms do not
		// charge the same amount. "Neither arm pays for the receipt in header
		// bytes" was true of the envelope's flags byte -- a data envelope is
		// byte-identical to what the codec wrote before the kind existed -- and
		// false of the WS frame the receipt rides in. WS wraps every envelope,
		// receipts included, in a 13-byte frame this arm does not pay, so the
		// per-message gap the receipt created is 13 more bytes on top of the 13
		// the message already cost: 26 per application message, and 11.3% of
		// the smallest cell's wire bytes rather than the 8.8% a data-only table
		// reported.
		const template = {
			runId: "run-ack",
			sessionId: "session-ack",
			sequence: 1,
			expiresAtMs: 1_000_000,
			payload: new Uint8Array(plan.messageBytes),
		};
		const dataEnvelope = encodeWireMessage(template).byteLength;
		const ackEnvelope = encodeWireMessage(ackFor(template)).byteLength;
		const wtOverhead =
			plan.messageCount * (dataEnvelope - plan.messageBytes) +
			plan.messageCount * ackEnvelope;
		const wsFrameBytes =
			encodeWebSocketFrame({
				kind: "message",
				payload: new Uint8Array(dataEnvelope),
				deliveryKind: plan.deliveryKind,
			}).byteLength - dataEnvelope;
		expect(leg.ledger.harnessOverheadBytes).toBe(
			_arm === "wt"
				? wtOverhead
				: wtOverhead + wsFrameBytes * plan.messageCount * 2,
		);
		expect(wsFrameBytes).toBe(13);
	});

	// A receipt is harness traffic. Charging it to `attempted` would double
	// every arm's message count and make the funnel describe a run twice the
	// size of the one the scenario asked for.
	test("does not charge a receipt to the application's send funnel", async () => {
		const clock = countingClock();
		const { clientSession, serverSession } =
			await connectedWebSocketPair(clock);
		const peer = echoSession({
			session: serverSession,
			deliveryKind: "reliable-message",
			messageLimit: 3,
			clock,
			perMessageTimeoutMs: 2_000,
		});
		const leg = await runMeasuredLeg({
			session: clientSession,
			plan: {
				deliveryKind: "reliable-message",
				messageCount: 3,
				messageBytes: 32,
			},
			driverRunId: "driver-ack-2",
			runId: "run-ack-2",
			sessionId: "session-ack-2",
			clock,
			perMessageTimeoutMs: 2_000,
			contract: latencyContract,
		});
		await peer;
		expect(leg.ledger.attempted).toBe(3);
		expect(serverSession.snapshot().attempted).toBe(3);
	});

	test("records one round trip per message over a real adapter pair", async () => {
		const clock = countingClock();
		const { clientSession, serverSession } =
			await connectedWebSocketPair(clock);
		// Stated inline: `cell` names a scenario the registry does not yet
		// define a leg for, and the point under test is what the driver does
		// with a plan, not where the plan came from.
		const plan = {
			deliveryKind: "reliable-message",
			messageCount: 6,
			messageBytes: 64,
		} as const;

		const peer = echoSession({
			session: serverSession,
			deliveryKind: plan.deliveryKind,
			messageLimit: plan.messageCount,
			clock,
			perMessageTimeoutMs: 1_000,
		});
		const leg = await runMeasuredLeg({
			session: clientSession,
			plan,
			driverRunId: "driver-loopback-1",
			runId: "run-loopback",
			sessionId: "session-loopback",
			clock,
			perMessageTimeoutMs: 1_000,
			contract: latencyContract,
		});
		await peer;

		expect(leg.samples).toHaveLength(6);
		expect(leg.roundTrips.map((sample) => sample.sequence)).toEqual([
			1, 2, 3, 4, 5, 6,
		]);
		// Every latency is the difference of two readings this test's clock
		// handed out, so no sample can have come from anywhere but the loop.
		for (const sample of leg.roundTrips) {
			expect(sample.receivedAtMs).toBeGreaterThanOrEqual(sample.sentAtMs);
			expect(sample.latencyMs).toBeCloseTo(
				sample.receivedAtMs - sample.sentAtMs,
				10,
			);
		}
		expect(leg.provenance).toMatchObject({
			driverRunId: "driver-loopback-1",
			clockMethod: "test.performance",
			sampleCount: 6,
		});
		expect(leg.provenance.firstSampleAtMs).toBe(leg.roundTrips[0]!.sentAtMs);
		expect(leg.provenance.lastSampleAtMs).toBe(leg.roundTrips[5]!.receivedAtMs);
		expect(leg.ledger.attempted).toBeGreaterThanOrEqual(6);
	});

	// R4 reduced WT's stream tax from one per message to one per session, and
	// one is not zero. WS's `sendMessage` takes no stream-admission token -- it
	// reserves bytes on the socket it already holds -- so a session that opened
	// its whole uni budget could still send a reliable message on WS and got
	// `E_LIMIT_EXCEEDED` on WT. That is a difference in the harness, on the one
	// axis the harness is supposed to be neutral about.
	test.each([
		["ws", connectedWebSocketPair],
		["wt", connectedWebTransportPair],
	] as const)("lets the %s arm's application open its whole uni budget and still send", async (_arm, connect) => {
		const clock = countingClock();
		const { clientSession } = await connect(clock);
		const budget = CANONICAL_CAPACITY_PROFILE.maxStreamsPerSessionUni;

		for (let index = 0; index < budget; index += 1) {
			await clientSession.openUni(clock.nowMs() + 1_000);
		}
		const sent = await clientSession.sendMessage(
			"reliable-message",
			{
				runId: "run-budget",
				sessionId: "session-budget",
				sequence: 1,
				expiresAtMs: Math.ceil(clock.nowMs()) + 60_000,
				payload: new Uint8Array([1, 2, 3, 4]),
			},
			clock.nowMs() + 1_000,
		);
		expect(sent.queued).toBe(true);
	});

	// The honest chain, end to end, which is the thing that had never been run:
	// a real leg over a real adapter pair, through the official arm builder, to
	// the ledger the artifact records. The audit ran exactly this and got
	// `delivered: 0` out of `attempted: 6`, stamped PASS. Every stage the driver
	// counted has to survive into the artifact, and the verdict has to be the
	// one that ledger earns.
	test("carries a measured leg's funnel into the artifact it is judged on", async () => {
		const clock = countingClock();
		const { clientSession, serverSession } =
			await connectedWebSocketPair(clock);
		// Stated inline: `cell` names a scenario the registry does not yet
		// define a leg for, and the point under test is what the driver does
		// with a plan, not where the plan came from.
		const plan = {
			deliveryKind: "reliable-message",
			messageCount: 6,
			messageBytes: 64,
		} as const;
		const peer = echoSession({
			session: serverSession,
			deliveryKind: plan.deliveryKind,
			messageLimit: plan.messageCount,
			clock,
			perMessageTimeoutMs: 2_000,
		});
		const leg = await runMeasuredLeg({
			session: clientSession,
			plan,
			driverRunId: "driver-chain",
			runId: "run-chain",
			sessionId: "session-chain",
			clock,
			perMessageTimeoutMs: 2_000,
			contract: latencyContract,
		});
		await peer;

		const chainExecution = {
			campaignId: "chain",
			runId: "run-chain",
			executionIndex: 1,
			transport: "ws",
		};
		const chainGrant = grantFor(chainExecution);
		const artifact = buildMeasuredArmArtifact({
			cell,
			comparisonId: "chain",
			runId: "run-chain",
			executionIndex: 1,
			transport: "ws",
			armKind: "primary",
			measurement: {
				// What the samples are in, from the leg that took them, rather
				// than from what this cell would like them to be.
				sampleUnit: leg.sampleUnit,
				toolchains: R1_FIXTURE_TOOLCHAINS,
				samples: leg.samples,
				percentiles: leg.percentiles,
				ledger: leg.ledger,
				admissionCounters: leg.admissionCounters,
				telemetry: {
					mac: { cpuPercent: 15, rssBytes: 120 * 1024 * 1024 },
					linux: { cpuPercent: 18, rssBytes: 220 * 1024 * 1024 },
				},
				provenance: leg.provenance,
				grant: chainGrant,
				admission: admissionFor({
					execution: chainExecution,
					grant: chainGrant,
					samples: leg.samples,
					delivered: leg.ledger.delivered,
					firstSampleAtMs: leg.provenance.firstSampleAtMs,
					lastSampleAtMs: leg.provenance.lastSampleAtMs,
				}),
			},
			supervisorToolchainDigests: SUPERVISOR_TOOLCHAIN_DIGESTS,
		});

		expect(leg.ledger.delivered).toBe(6);
		// `harnessOverheadBytes` was hard-wired to zero in the builder and zero
		// was false on both arms. The arm the campaign builds records what its
		// adapter counted.
		expect(leg.ledger.harnessOverheadBytes).toBeGreaterThan(0);
		expect(artifact.ledger.harnessOverheadBytes).toBe(
			leg.ledger.harnessOverheadBytes,
		);
		expect({
			attempted: artifact.ledger.attempted,
			queued: artifact.ledger.queued,
			serverObserved: artifact.ledger.serverObserved,
			acknowledged: artifact.ledger.acknowledged,
			delivered: artifact.ledger.delivered,
		}).toEqual({
			attempted: leg.ledger.attempted,
			queued: leg.ledger.queued,
			serverObserved: leg.ledger.serverObserved,
			acknowledged: leg.ledger.acknowledged,
			delivered: leg.ledger.delivered,
		});
		expect({
			evidenceStatus: artifact.evidenceStatus,
			scenarioVerdict: artifact.scenarioVerdict,
		}).toEqual(
			deriveMeasuredVerdictTuple(
				{ samples: artifact.metrics.samples, ledger: artifact.ledger },
				injectedImpairmentOf(cell),
			),
		);
	});

	// The driver stamps a message's arrival after `receiveMessage` resolves, so
	// a receipt the receive awaits is harness work inside the number the
	// campaign ranks on -- two of them per round trip, the peer's for the
	// outbound message and this side's for the echo. And it is not the same
	// work on both arms: WS encodes a frame, reserves against
	// `maxQueuedBytesPerSession` and waits on flow control that can block to
	// the deadline, where WT writes to a stream.
	//
	// Executed on both real adapter pairs with a 50 ms cost inside the receipt
	// send and nothing else changed: awaited, the samples were
	// ws [108,106,103,104,105] and wt [107,105,104,106,106]; un-awaited they
	// are ws [1,0,0,0,0] and wt [3,0,0,0,0], which is the no-cost baseline
	// exactly. This is the standing guard against the await coming back.
	test("keeps the receipt's own send out of the measured round trip", async () => {
		const ws = await Bun.file(
			new URL("./adapters/ws.ts", import.meta.url),
		).text();
		const wt = await Bun.file(
			new URL("./adapters/wt.ts", import.meta.url),
		).text();
		expect(ws).toContain("void this.sendAck(");
		expect(ws).not.toContain("await this.sendAck(");
		expect(wt).toContain("void sendReceipt(");
		expect(wt).not.toContain("await sendReceipt(");
	});

	// The defect the deleted model embodied was not "the numbers were wrong", it
	// was "the numbers were a function of `transport`". This is the assertion
	// that the replacement is not: the same driver, the same plan, and the same
	// peer produce a leg whose shape does not depend on which arm is running,
	// because the driver is never told.
	test("runs the same leg without consulting which transport it is on", async () => {
		const source = await Bun.file(
			new URL("./client.ts", import.meta.url),
		).text();
		const driverStart = source.indexOf("export async function runMeasuredLeg");
		const driverEnd = source.indexOf(
			"export async function measureLegOverAdapter",
		);
		expect(driverStart).toBeGreaterThan(0);
		expect(driverEnd).toBeGreaterThan(driverStart);
		const driverBody = source.slice(driverStart, driverEnd);
		// `TransportClock` and `TransportMetrics` legitimately contain the word,
		// so the assertion is about the arm being *read*, not about the string.
		expect(driverBody).not.toMatch(/["']wt["']|["']ws["']/u);
		expect(driverBody).not.toMatch(/\btransport\s*===|\bisWt\b|\bisWs\b/u);
		expect(driverBody).not.toMatch(/\binput\.transport\b|\bplan\.transport\b/u);
	});

	test("refuses a cell whose two arms are not defined to run the same leg", () => {
		for (const scenarioId of LEG_PLAN_UNDEFINED_SCENARIOS) {
			const undefinedCell = CANONICAL_SCENARIO_REGISTRY.cells.find(
				(candidate) => candidate.scenarioId === scenarioId,
			);
			expect(undefinedCell).toBeDefined();
			expect(() => legPlanForCell(undefinedCell!)).toThrow(
				LegPlanUndefinedError,
			);
		}
		// The cells that clear this gate are refused by the other one: every
		// scenario the registry defines a leg for publishes a rate, a
		// throughput or a percentage, and the driver measures none of those.
		// Asserted here so the two refusals are not read as one.
		const legDefined = CANONICAL_SCENARIO_REGISTRY.cells.filter(
			(candidate) =>
				!LEG_PLAN_UNDEFINED_SCENARIOS.includes(candidate.scenarioId),
		);
		expect(legDefined.length).toBeGreaterThan(0);
		for (const candidate of legDefined) {
			expect(() => legPlanForCell(candidate)).toThrow(
				MetricUnitUnmeasuredError,
			);
		}
	});

	test("reads a latest-state cell onto the datagram path for both arms alike", () => {
		// Both halves of the plan are exercised on cells amended the way closing
		// the registry gap would amend them: a latency scenario given the
		// `delivery` its parameters do not state. The amendment is stated here
		// rather than measured, and it is deliberately the *only* thing added --
		// so this proves the planner maps delivery to the wire the same way for
		// both arms, and it starts covering the real registry the moment a
		// maintainer defines a leg for a latency cell.
		const amended = (scenarioId: ScenarioId, delivery: string) => {
			const source = CANONICAL_SCENARIO_REGISTRY.cells.find(
				(candidate) => candidate.scenarioId === scenarioId,
			)!;
			return {
				...source,
				parameters: {
					...(source.parameters as Record<string, unknown>),
					delivery,
					messageBytes: 64,
				},
			} as unknown as ScenarioCell;
		};
		expect(
			legPlanForCell(amended("ai-token-stream", "latest-state")).deliveryKind,
		).toBe("datagram");
		expect(
			legPlanForCell(amended("handshake-matrix", "reliable")).deliveryKind,
		).toBe("reliable-message");
	});

	test("the echo peer sends a message back on the kind it arrived on", async () => {
		const clock = countingClock();
		const { clientSession, serverSession } =
			await connectedWebSocketPair(clock);
		const peer = echoSession({
			session: serverSession,
			deliveryKind: "reliable-message",
			messageLimit: 2,
			clock,
			perMessageTimeoutMs: 1_000,
		});
		const leg = await runMeasuredLeg({
			session: clientSession,
			plan: {
				deliveryKind: "reliable-message",
				messageCount: 2,
				messageBytes: 32,
			},
			driverRunId: "driver-loopback-2",
			runId: "run-loopback-2",
			sessionId: "session-loopback-2",
			clock,
			perMessageTimeoutMs: 1_000,
			contract: latencyContract,
		});
		expect(await peer).toEqual({ echoed: 2, stopped: "limit-reached" });
		expect(leg.samples).toHaveLength(2);
		expect(leg.ledger.delivered).toBeGreaterThanOrEqual(2);
	});
});

describe("the campaign's honest chain, and the forgery it now refuses", () => {
	const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
		(candidate) => candidate.cellId === "handshake-matrix/physical-cold",
	)!;
	const runId = "run-admitted-chain";

	/**
	 * One arm measured over a real adapter pair, presented, admitted, and
	 * assembled from the admission.
	 *
	 * A thousand messages because that is the primary contract's sample floor,
	 * and a published delta is the thing under test: an arm below the floor is
	 * refused for its sample count long before anything about admission
	 * matters, which would make this test pass for the wrong reason.
	 */
	async function admittedArm(
		transport: "ws" | "wt",
		connect: (
			clock: TransportClock,
		) => Promise<{ clientSession: never; serverSession: never }>,
		executionIndex: number,
	) {
		const clock = countingClock();
		const { clientSession, serverSession } = await connect(clock);
		const plan = {
			deliveryKind: "reliable-message",
			messageCount: 1_000,
			messageBytes: 64,
		} as const;
		const peer = echoSession({
			session: serverSession,
			deliveryKind: plan.deliveryKind,
			messageLimit: plan.messageCount,
			clock,
			perMessageTimeoutMs: 2_000,
		});
		const leg = await runMeasuredLeg({
			session: clientSession,
			plan,
			driverRunId: `admitted-${transport}`,
			runId,
			sessionId: `session-${transport}`,
			clock,
			perMessageTimeoutMs: 2_000,
			contract: PRIMARY_METRIC_CONTRACTS["handshake-matrix"] as MetricContract,
		});
		await peer;
		const execution = {
			campaignId: "admitted-chain",
			runId,
			executionIndex,
			transport,
		};
		const grant = grantFor(execution);
		const artifact = buildMeasuredArmArtifact({
			cell,
			comparisonId: "admitted-chain",
			runId,
			executionIndex,
			transport,
			armKind: "primary",
			measurement: {
				// What the samples are in, from the leg that took them, rather
				// than from what this cell would like them to be.
				sampleUnit: leg.sampleUnit,
				toolchains: R1_FIXTURE_TOOLCHAINS,
				samples: leg.samples,
				percentiles: leg.percentiles,
				// The histogram rides along from the leg now. It used to be
				// written here, one bucket holding every sample, because the
				// driver produced none and the comparator refuses an arm whose
				// counts do not sum to its samples -- so the honest chain's own
				// test carried the fabrication it exists to rule out.
				ledger: leg.ledger,
				admissionCounters: leg.admissionCounters,
				telemetry: {
					mac: { cpuPercent: 15, rssBytes: 120 * 1024 * 1024 },
					linux: { cpuPercent: 18, rssBytes: 220 * 1024 * 1024 },
				},
				provenance: leg.provenance,
				grant,
				admission: admissionFor({
					execution,
					grant,
					samples: leg.samples,
					delivered: leg.ledger.delivered,
					firstSampleAtMs: leg.provenance.firstSampleAtMs,
					lastSampleAtMs: leg.provenance.lastSampleAtMs,
				}),
			},
			supervisorToolchainDigests: SUPERVISOR_TOOLCHAIN_DIGESTS,
		});
		return {
			armTransport: transport,
			input: sealRunArtifact(artifact),
			trust: trustContextForArtifact(artifact),
		};
	}

	// The half of the gate that is easy to lose while closing the other half.
	// A campaign that refuses everything is not a campaign, so the honest chain
	// is asserted all the way to the published delta -- two real adapter pairs,
	// a thousand messages each, through the builder, the sealer and the
	// comparator.
	test("an honest leg over both real adapter pairs still publishes a delta", async () => {
		const arms = [
			await admittedArm("ws", connectedWebSocketPair as never, 1),
			await admittedArm("wt", connectedWebTransportPair as never, 2),
		];
		const compared = compareCell(cell.cellId, arms);
		expect(compared.rejections).toEqual([]);
		const result = compared.rankedComparisons[0]?.result;
		expect(result?.evidenceStatus).toBe("PASS");
		expect(result?.ranking).not.toBe("not computed");
		const delta = result?.delta as { readonly metric?: string };
		expect(delta?.metric).toBe("first-message-latency-ms");
	}, 60_000);

	// And the forgery, in the same chain, unchanged: the deleted executor's
	// literals on a stepping clock the caller stood up, a thousand samples, a
	// ledger that agrees with them, and a grant the caller minted for itself.
	// It never becomes an artifact, so it never reaches the sealer, so the
	// comparator is never offered it.
	test("the audit's forged arm never reaches the comparator", () => {
		let nowMs = 1_000;
		const recorder = openMeasurement({
			driverRunId: "forged-wt",
			clock: { nowMs: () => nowMs, method: "performance.now" },
			histogramBoundaries: (
				PRIMARY_METRIC_CONTRACTS["handshake-matrix"] as MetricContract
			).histogramBoundaries,
		});
		for (let index = 0; index < 1_000; index += 1) {
			recorder.markSent();
			nowMs += 3.2;
			recorder.markReceived(index + 1);
		}
		const measured = recorder.seal();
		const execution = {
			campaignId: "admitted-chain",
			runId: "run-forged",
			executionIndex: 3,
			transport: "wt",
		};
		expect(() =>
			buildMeasuredArmArtifact({
				cell,
				comparisonId: "admitted-chain",
				runId: "run-forged",
				executionIndex: 3,
				transport: "wt",
				armKind: "primary",
				measurement: {
					samples: measured.samples,
					percentiles: measured.percentiles,
					ledger: {
						attempted: 1_000,
						queued: 1_000,
						serverObserved: 1_000,
						acknowledged: 1_000,
						delivered: 1_000,
						dropped: 0,
						expired: 0,
					},
					admissionCounters: {
						schemaVersion: "v1",
						handshakes: {
							attempted: 1,
							accepted: 1,
							rejected: 0,
							rateLimited: 0,
						},
						sessions: {
							attempted: 1,
							accepted: 1,
							rejected: 0,
							activePeak: 1,
						},
						streams: { attempted: 0, accepted: 0, rejected: 0, rateLimited: 0 },
						datagrams: {
							attempted: 1_000,
							accepted: 1_000,
							rejected: 0,
							rateLimited: 0,
						},
					},
					telemetry: {
						mac: { cpuPercent: 15, rssBytes: 120 * 1024 * 1024 },
						linux: { cpuPercent: 18, rssBytes: 220 * 1024 * 1024 },
					},
					provenance: measured.provenance,
					grant: grantFor(execution),
				} as never,
			}),
		).toThrow("MEASUREMENT_UNADMITTED");
	});
});

describe("the driver produces the histogram the comparator refuses without", () => {
	const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
		(candidate) => candidate.cellId === "handshake-matrix/physical-cold",
	)!;

	// The boundaries have to come from somewhere both arms read the same way.
	// Anything derived from an arm's own samples differs between the two by
	// construction, and `compare.ts` refuses a pair whose boundaries differ --
	// so the contract is where they live, and the contract's hash is what stops
	// a run from retuning its own buckets.
	test("every canonical contract declares an ordered ladder from its own minimum", () => {
		for (const [scenarioId, contract] of Object.entries(
			PRIMARY_METRIC_CONTRACTS,
		)) {
			const boundaries = contract.histogramBoundaries;
			expect(boundaries.length, scenarioId).toBeGreaterThan(0);
			expect(boundaries[0], scenarioId).toBe(contract.minimum);
			for (let index = 1; index < boundaries.length; index += 1) {
				expect(Number.isFinite(boundaries[index]), scenarioId).toBe(true);
				expect(
					boundaries[index] as number,
					`${scenarioId} boundary ${index}`,
				).toBeGreaterThan(boundaries[index - 1] as number);
			}
			if (contract.maximum !== undefined)
				expect(
					boundaries[boundaries.length - 1] as number,
					scenarioId,
				).toBeLessThanOrEqual(contract.maximum);
		}
	});

	test("perturbing one boundary moves the metric contract hash", () => {
		const original = PRIMARY_METRIC_CONTRACTS[
			"handshake-matrix"
		] as MetricContract;
		const perturbed = {
			...original,
			histogramBoundaries: [...original.histogramBoundaries, 4096],
		};
		expect(metricContractHash(perturbed)).not.toBe(
			metricContractHash(original),
		);
	});

	// The count is taken as each round trip lands, not derived from the sealed
	// series afterwards. Deriving it would make `histogramCountsMatchSamples`
	// compare a number against itself; accumulating it separately is what keeps
	// that check able to fail.
	test("the recorder counts each round trip into a bucket as it lands", () => {
		let nowMs = 1_000;
		const recorder = openMeasurement({
			driverRunId: "bucketing",
			clock: { nowMs: () => nowMs, method: "test.stepping" },
			histogramBoundaries: [0, 2, 8],
		});
		for (const latency of [0.5, 1.5, 3, 5, 9, 100]) {
			recorder.markSent();
			nowMs += latency;
			recorder.markReceived(1);
		}
		const sealed = recorder.seal();
		expect(sealed.histogram.boundaries).toEqual([0, 2, 8]);
		expect(sealed.histogram.counts).toEqual([2, 2, 2]);
		expect(sealed.histogram.counts.reduce((sum, count) => sum + count, 0)).toBe(
			sealed.samples.length,
		);
	});

	// The gap the previous commit recorded on `ArmMeasurement.ledger.histogram`:
	// a measured arm that does not report one is sealed and then refused at
	// comparison for the fabricated default, at every sample count except one.
	test("a measured leg carries a histogram the builder does not have to invent", async () => {
		const clock = countingClock();
		const { clientSession, serverSession } = (await connectedWebSocketPair(
			clock,
		)) as never as {
			clientSession: never;
			serverSession: never;
		};
		const plan = {
			deliveryKind: "reliable-message",
			messageCount: 8,
			messageBytes: 64,
		} as const;
		const peer = echoSession({
			session: serverSession,
			deliveryKind: plan.deliveryKind,
			messageLimit: plan.messageCount,
			clock,
			perMessageTimeoutMs: 2_000,
		});
		const leg = await runMeasuredLeg({
			session: clientSession,
			plan,
			driverRunId: "histogram-leg",
			runId: "run-histogram",
			sessionId: "session-histogram",
			clock,
			perMessageTimeoutMs: 2_000,
			contract: PRIMARY_METRIC_CONTRACTS["handshake-matrix"] as MetricContract,
		});
		await peer;
		const histogram = leg.ledger.histogram;
		expect(histogram.unit).toBe("ms");
		expect(histogram.boundaries).toEqual(
			(PRIMARY_METRIC_CONTRACTS["handshake-matrix"] as MetricContract)
				.histogramBoundaries,
		);
		expect(histogram.counts.reduce((sum, count) => sum + count, 0)).toBe(
			leg.samples.length,
		);
		expect(cell.scenarioId).toBe("handshake-matrix");
	}, 30_000);
});

/**
 * The defect this block exists to keep closed.
 *
 * `runMeasuredLeg` produces one kind of number for every scenario and both
 * arms: the difference between two readings of its own clock, in milliseconds.
 * `buildRunArtifact` labels whatever series it is handed with the cell's
 * primary metric contract -- `unit: contract.unit` -- and never asks what the
 * series is in. The five scenarios the driver could plan all publish something
 * else (Mbps, a delivery percentage, three kinds of per-second rate), so an
 * honest leg on any of them sealed round-trip milliseconds under a rate's name,
 * and nothing downstream could tell: `verify-artifact.ts` only confines each
 * sample to `[contract.minimum, contract.maximum]`, which is `[0, ∞)` on every
 * one of them.
 *
 * The test that was supposed to cover this ran a `handshake-matrix` cell --
 * the one scenario family whose contract is in milliseconds -- and stated its
 * plan inline rather than deriving it from the cell, so the single path
 * exercised end to end was the single combination where the units agree.
 * These run every cell and every contract.
 */
describe("a driver sample is published in the unit it was measured in", () => {
	const contractFor = (scenarioId: ScenarioId) =>
		PRIMARY_METRIC_CONTRACTS[scenarioId] as MetricContract;

	test("every cell the driver plans publishes the unit the driver measures", () => {
		const planned: string[] = [];
		const refusedUnit: string[] = [];
		const refusedLeg: string[] = [];
		for (const candidate of CANONICAL_SCENARIO_REGISTRY.cells) {
			let plan: ReturnType<typeof legPlanForCell> | undefined;
			try {
				plan = legPlanForCell(candidate);
			} catch (error) {
				if (error instanceof MetricUnitUnmeasuredError)
					refusedUnit.push(candidate.cellId);
				else if (error instanceof LegPlanUndefinedError)
					refusedLeg.push(candidate.cellId);
				else throw error;
				continue;
			}
			planned.push(candidate.cellId);
			expect(plan.messageCount).toBeGreaterThan(0);
			// The assertion the whole exercise is for, over every cell that
			// reaches the driver rather than over one hand-picked one.
			expect(contractFor(candidate.scenarioId).unit).toBe(DRIVER_SAMPLE_UNIT);
		}
		// Every cell is accounted for by exactly one of the three outcomes, so a
		// cell cannot slip past by being neither planned nor refused.
		expect(planned.length + refusedUnit.length + refusedLeg.length).toBe(
			CANONICAL_SCENARIO_REGISTRY.cells.length,
		);
		// And both refusals are live. Today the two sets partition the registry
		// and `planned` is empty: the five scenarios with a defined leg publish
		// a unit the driver does not measure, and the four that publish
		// milliseconds have no leg both arms are defined to run
		// (`connection-memory`, the fifth without a leg, publishes bytes and is
		// refused by both gates). That is the honest state of the driver, and
		// it is what the rate and throughput scenarios getting their own
		// measurement will change.
		expect(refusedUnit.length).toBeGreaterThan(0);
		expect(refusedLeg.length).toBeGreaterThan(0);
	});

	test("the unmeasured set is derived from the contracts, not written down", () => {
		expect([...DRIVER_UNMEASURED_UNIT_SCENARIOS].sort()).toEqual(
			SCENARIO_IDS.filter(
				(scenarioId) => contractFor(scenarioId).unit !== DRIVER_SAMPLE_UNIT,
			)
				.slice()
				.sort(),
		);
		for (const scenarioId of DRIVER_UNMEASURED_UNIT_SCENARIOS) {
			expect(() => contractMeasurableByDriver(scenarioId)).toThrow(
				MetricUnitUnmeasuredError,
			);
		}
	});

	// Every scenario, over a real adapter pair, through the driver itself --
	// because the check that matters is not what a contract says but what the
	// loop does when handed one. A caller may state its own plan, which is
	// exactly how the previous end-to-end test bypassed `legPlanForCell`, so
	// the refusal has to hold on that path too.
	test.each([
		...SCENARIO_IDS,
	])("a %s leg is either measured in its contract's unit or refused", async (scenarioId: ScenarioId) => {
		const contract = contractFor(scenarioId);
		const clock = countingClock();
		const { clientSession, serverSession } =
			await connectedWebSocketPair(clock);
		const plan = {
			deliveryKind: "reliable-message",
			messageCount: 2,
			messageBytes: 32,
		} as const;
		const run = () =>
			runMeasuredLeg({
				session: clientSession,
				plan,
				driverRunId: `driver-unit-${scenarioId}`,
				runId: `run-unit-${scenarioId}`,
				sessionId: `session-unit-${scenarioId}`,
				clock,
				perMessageTimeoutMs: 1_000,
				contract,
			});

		if (contract.unit !== DRIVER_SAMPLE_UNIT) {
			expect(run()).rejects.toThrow(MetricUnitUnmeasuredError);
			await clientSession.close(clock.nowMs() + 1_000);
			await serverSession.close(clock.nowMs() + 1_000);
			return;
		}

		const peer = echoSession({
			session: serverSession,
			deliveryKind: plan.deliveryKind,
			messageLimit: plan.messageCount,
			clock,
			perMessageTimeoutMs: 1_000,
		});
		const leg = await run();
		await peer;
		expect(leg.samples).toHaveLength(plan.messageCount);
		expect(leg.sampleUnit).toBe(contract.unit);
		expect(leg.ledger.histogram.unit).toBe(leg.sampleUnit);
	}, 30_000);

	// The other end of the same fact. The driver refuses to measure a leg it
	// cannot publish; the builder refuses to publish a series that was not
	// measured in the unit it is about to be labelled with. Either guard alone
	// leaves the other path open -- a producer that is not this driver can
	// reach the builder, and a plan can be stated without a cell.
	test("the arm builder refuses a series measured in another unit", async () => {
		const latencyCell = CANONICAL_SCENARIO_REGISTRY.cells.find(
			(candidate) => candidate.cellId === "handshake-matrix/physical-cold",
		)!;
		const rateCell = CANONICAL_SCENARIO_REGISTRY.cells.find(
			(candidate) => candidate.scenarioId === "chat-fanout",
		)!;

		/**
		 * One honest leg, measured over a real pair.
		 *
		 * Taken twice rather than published twice: a sealed record is spent by
		 * the first arm that names it, so reusing one leg for both builds would
		 * be refused for the attestation long before anything about units was
		 * reached.
		 */
		const honestLeg = async (label: string) => {
			const clock = countingClock();
			const { clientSession, serverSession } =
				await connectedWebSocketPair(clock);
			const plan = {
				deliveryKind: "reliable-message",
				messageCount: 4,
				messageBytes: 32,
			} as const;
			const peer = echoSession({
				session: serverSession,
				deliveryKind: plan.deliveryKind,
				messageLimit: plan.messageCount,
				clock,
				perMessageTimeoutMs: 1_000,
			});
			const leg = await runMeasuredLeg({
				session: clientSession,
				plan,
				driverRunId: `driver-unit-${label}`,
				runId: `run-unit-${label}`,
				sessionId: `session-unit-${label}`,
				clock,
				perMessageTimeoutMs: 1_000,
				contract: PRIMARY_METRIC_CONTRACTS[
					"handshake-matrix"
				] as MetricContract,
			});
			await peer;
			return { leg, label };
		};

		const armOn = (
			cell: ScenarioCell,
			measured: Awaited<ReturnType<typeof honestLeg>>,
			executionIndex: number,
		) => {
			const leg = measured.leg;
			const execution = {
				campaignId: "unit-publish",
				runId: `run-unit-${measured.label}`,
				executionIndex,
				transport: "ws",
			};
			const grant = grantFor(execution);
			return buildMeasuredArmArtifact({
				cell,
				comparisonId: "unit-publish",
				runId: execution.runId,
				executionIndex,
				transport: "ws",
				armKind: "primary",
				measurement: {
					sampleUnit: leg.sampleUnit,
					toolchains: R1_FIXTURE_TOOLCHAINS,
					samples: leg.samples,
					percentiles: leg.percentiles,
					ledger: leg.ledger,
					admissionCounters: leg.admissionCounters,
					telemetry: {
						mac: { cpuPercent: 15, rssBytes: 120 * 1024 * 1024 },
						linux: { cpuPercent: 18, rssBytes: 220 * 1024 * 1024 },
					},
					provenance: leg.provenance,
					grant,
					admission: admissionFor({
						execution,
						grant,
						samples: leg.samples,
						delivered: leg.ledger.delivered,
						firstSampleAtMs: leg.provenance.firstSampleAtMs,
						lastSampleAtMs: leg.provenance.lastSampleAtMs,
					}),
				},
				supervisorToolchainDigests: SUPERVISOR_TOOLCHAIN_DIGESTS,
			});
		};

		// Two legs of the same kind, and the only difference between the two
		// builds is the cell they are published against. That is the whole
		// defect: milliseconds under a per-second rate's label, with a ledger
		// that agrees and a range check that passes.
		const artifact = armOn(latencyCell, await honestLeg("latency"), 8_101);
		expect(artifact.metrics.unit).toBe(DRIVER_SAMPLE_UNIT);

		let refusal = "none";
		try {
			armOn(rateCell, await honestLeg("rate"), 8_102);
		} catch (error) {
			refusal = (error as { code?: string }).code ?? "unknown";
		}
		expect(refusal).toBe("CAMPAIGN_METRIC_UNIT_MISMATCH");
	}, 30_000);
});
