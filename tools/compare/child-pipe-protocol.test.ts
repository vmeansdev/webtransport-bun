/**
 * S1 — the §3.4 server-child lifecycle codecs (design §2.12, §1.3).
 *
 * Byte authority is plan §3.4 lines 985-1193. The hex vectors below are this
 * slice's product: they are the frames the Rust rig (S5-RIG) and the server
 * child (S6) assert against, and neither re-derives the bytes.
 */
import { describe, expect, test } from "bun:test";
import {
	buildChildPipeRefusal,
	buildServerBindExecution,
	buildServerCaptureAck,
	buildServerMeasureStart,
	buildServerMeasureStartAck,
	buildServerPresentStartBarrier,
	buildServerReady,
	buildServerStartBarrierAccepted,
	buildServerStopAndCapture,
	buildServerStopped,
	buildServerTeardown,
	buildServerWarmupDrainAndReset,
	buildServerWarmupDrained,
	buildServerWarmupReady,
	buildServerWarmupStart,
	CHILD_PIPE_CONTROL_MAX_BYTES,
	CHILD_PIPE_RIG_SERVER_MAX_FRAMES_PER_DIRECTION,
	createServerChildLifecycle,
	decodeServerChildFrame,
	encodeServerChildFrame,
	isServerChildSchema,
	PHASE_A_CHILD_SCHEMAS,
	parseServerChildPayload,
	SERVER_CHILD_CHILD_TO_RIG_ORDER,
	SERVER_CHILD_KEY_SETS,
	SERVER_CHILD_LIFECYCLE_SCHEMAS,
	SERVER_CHILD_RIG_TO_CHILD_ORDER,
	type ServerChildSchema,
	serverChildFrameBoundForSchema,
	stepServerChildLifecycle,
} from "./child-pipe-protocol.ts";

const EXECUTION = "e1".repeat(32);
const ACCEPTANCE = "a2".repeat(32);
const NONCE = "c3".repeat(32);
const GRANT_SHA = "60".repeat(32);
const EPOCH_SHA = "77".repeat(32);
const MANIFEST_SHA = "88".repeat(32);
const BARRIER_SHA = "b5".repeat(32);
const WARMUP_COMPLETE_SHA = "9c".repeat(32);

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/**
 * One canonical body per §2.12 schema, in the exact shape the builders must
 * produce. These are the inputs the hex vectors were cut from.
 */
const BODIES: Readonly<Record<ServerChildSchema, Record<string, unknown>>> = {
	"child-pipe-refusal/v1": {
		schema: "child-pipe-refusal/v1",
		sequence: 3,
		executionSha256: EXECUTION,
		code: "STATE_INVALID",
		terminal: true,
	},
	"server-bind-execution/v1": {
		schema: "server-bind-execution/v1",
		sequence: 0,
		executionSha256: EXECUTION,
		rigExecutionAcceptanceSha256: ACCEPTANCE,
		cohortGrantBase64: b64("cohort-grant"),
		cohortGrantSignatureBase64: b64("mac-receipt-sig"),
	},
	"server-ready/v1": {
		schema: "server-ready/v1",
		sequence: 0,
		executionSha256: EXECUTION,
		childPid: 4242,
		childPgid: 4242,
		childInstanceNonce: NONCE,
		cohortGrantSha256: GRANT_SHA,
		listeningAddress: "127.0.0.1:44443",
	},
	"server-warmup-start/v1": {
		schema: "server-warmup-start/v1",
		sequence: 1,
		executionSha256: EXECUTION,
		cohortWarmupEpochBase64: b64("cohort-warmup-epoch"),
		cohortWarmupEpochSignatureBase64: b64("epoch-sig"),
	},
	"server-warmup-ready/v1": {
		schema: "server-warmup-ready/v1",
		sequence: 1,
		executionSha256: EXECUTION,
		cohortWarmupEpochSha256: EPOCH_SHA,
		warmupCountersZero: true,
	},
	"server-warmup-drain-and-reset/v1": {
		schema: "server-warmup-drain-and-reset/v1",
		sequence: 2,
		executionSha256: EXECUTION,
		cohortWarmupEpochSha256: EPOCH_SHA,
		roleWarmupCompletionManifestSha256: MANIFEST_SHA,
	},
	"server-warmup-drained/v1": {
		schema: "server-warmup-drained/v1",
		sequence: 2,
		executionSha256: EXECUTION,
		cohortWarmupEpochSha256: EPOCH_SHA,
		roleWarmupCompletionManifestSha256: MANIFEST_SHA,
		warmupIngress: 5000,
		warmupDeliveries: 5000000,
		publisherWarmupEndCount: 1,
		subscriberWarmupEndCount: 1000,
		warmupQueuesEmpty: true,
		measuredCountersZero: true,
		drainedAtLinuxNs: "123456789012345",
		linuxClockId: "CLOCK_MONOTONIC",
	},
	"server-measure-start/v1": {
		schema: "server-measure-start/v1",
		sequence: 3,
		executionSha256: EXECUTION,
		warmupCompleteSha256: WARMUP_COMPLETE_SHA,
	},
	"server-measure-start-ack/v1": {
		schema: "server-measure-start-ack/v1",
		sequence: 3,
		executionSha256: EXECUTION,
		baselineBusyMs: 1234,
		baselineAtLinuxNs: "123456789012400",
		linuxClockId: "CLOCK_MONOTONIC",
	},
	"server-present-start-barrier/v1": {
		schema: "server-present-start-barrier/v1",
		sequence: 4,
		executionSha256: EXECUTION,
		cohortStartBarrierBase64: b64("cohort-start-barrier"),
		cohortStartBarrierSignatureBase64: b64("barrier-sig"),
	},
	"server-start-barrier-accepted/v1": {
		schema: "server-start-barrier-accepted/v1",
		sequence: 4,
		executionSha256: EXECUTION,
		cohortStartBarrierSha256: BARRIER_SHA,
		acceptedAtLinuxNs: "123456789012500",
		linuxClockId: "CLOCK_MONOTONIC",
		measuredTrafficAllowed: true,
	},
	"server-stop-and-capture/v1": {
		schema: "server-stop-and-capture/v1",
		sequence: 5,
		executionSha256: EXECUTION,
		cohortStartBarrierSha256: BARRIER_SHA,
		drainDeadlineMs: 30000,
	},
	"server-capture-ack/v1": {
		schema: "server-capture-ack/v1",
		sequence: 5,
		executionSha256: EXECUTION,
		snapshotFrameBase64: b64("server-loop-utilization-frame"),
		linuxRelayObservationBase64: b64("linux-relay-observation"),
	},
	"server-teardown/v1": {
		schema: "server-teardown/v1",
		sequence: 6,
		executionSha256: EXECUTION,
	},
	"server-stopped/v1": {
		schema: "server-stopped/v1",
		sequence: 6,
		executionSha256: EXECUTION,
		exitCode: 0,
		allSessionsClosed: true,
	},
};

/** The exact §3.4 key set of each schema, sorted, as the parsers enforce it. */
const KEY_SETS: Readonly<Record<ServerChildSchema, readonly string[]>> = {
	"child-pipe-refusal/v1": [
		"code",
		"executionSha256",
		"schema",
		"sequence",
		"terminal",
	],
	"server-bind-execution/v1": [
		"cohortGrantBase64",
		"cohortGrantSignatureBase64",
		"executionSha256",
		"rigExecutionAcceptanceSha256",
		"schema",
		"sequence",
	],
	"server-ready/v1": [
		"childInstanceNonce",
		"childPgid",
		"childPid",
		"cohortGrantSha256",
		"executionSha256",
		"listeningAddress",
		"schema",
		"sequence",
	],
	"server-warmup-start/v1": [
		"cohortWarmupEpochBase64",
		"cohortWarmupEpochSignatureBase64",
		"executionSha256",
		"schema",
		"sequence",
	],
	"server-warmup-ready/v1": [
		"cohortWarmupEpochSha256",
		"executionSha256",
		"schema",
		"sequence",
		"warmupCountersZero",
	],
	"server-warmup-drain-and-reset/v1": [
		"cohortWarmupEpochSha256",
		"executionSha256",
		"roleWarmupCompletionManifestSha256",
		"schema",
		"sequence",
	],
	"server-warmup-drained/v1": [
		"cohortWarmupEpochSha256",
		"drainedAtLinuxNs",
		"executionSha256",
		"linuxClockId",
		"measuredCountersZero",
		"publisherWarmupEndCount",
		"roleWarmupCompletionManifestSha256",
		"schema",
		"sequence",
		"subscriberWarmupEndCount",
		"warmupDeliveries",
		"warmupIngress",
		"warmupQueuesEmpty",
	],
	"server-measure-start/v1": [
		"executionSha256",
		"schema",
		"sequence",
		"warmupCompleteSha256",
	],
	"server-measure-start-ack/v1": [
		"baselineAtLinuxNs",
		"baselineBusyMs",
		"executionSha256",
		"linuxClockId",
		"schema",
		"sequence",
	],
	"server-present-start-barrier/v1": [
		"cohortStartBarrierBase64",
		"cohortStartBarrierSignatureBase64",
		"executionSha256",
		"schema",
		"sequence",
	],
	"server-start-barrier-accepted/v1": [
		"acceptedAtLinuxNs",
		"cohortStartBarrierSha256",
		"executionSha256",
		"linuxClockId",
		"measuredTrafficAllowed",
		"schema",
		"sequence",
	],
	"server-stop-and-capture/v1": [
		"cohortStartBarrierSha256",
		"drainDeadlineMs",
		"executionSha256",
		"schema",
		"sequence",
	],
	"server-capture-ack/v1": [
		"executionSha256",
		"linuxRelayObservationBase64",
		"schema",
		"sequence",
		"snapshotFrameBase64",
	],
	"server-teardown/v1": ["executionSha256", "schema", "sequence"],
	"server-stopped/v1": [
		"allSessionsClosed",
		"executionSha256",
		"exitCode",
		"schema",
		"sequence",
	],
};

/**
 * S1's hex conformance vectors: `u32be payloadLength || canonical JSON || \n`
 * for each schema's fixture body. Cut with `canonicalRecordBytes`
 * (`secure-fs.ts:17`) before any codec below existed, so a builder that agrees
 * with them agrees with the canonical encoder and not with itself.
 */
const HEX_VECTORS: Readonly<Record<ServerChildSchema, string>> = {
	"child-pipe-refusal/v1":
		"000000ac7b22636f6465223a2253544154455f494e56414c4944222c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c22736368656d61223a226368696c642d706970652d7265667573616c2f7631222c2273657175656e6365223a332c227465726d696e616c223a747275657d0a",
	"server-bind-execution/v1":
		"000001457b22636f686f72744772616e74426173653634223a225932396f62334a304c57647959573530222c22636f686f72744772616e745369676e6174757265426173653634223a226257466a4c584a6c593256706348517463326c6e222c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c22726967457865637574696f6e416363657074616e6365536861323536223a2261326132613261326132613261326132613261326132613261326132613261326132613261326132613261326132613261326132613261326132613261326132222c22736368656d61223a227365727665722d62696e642d657865637574696f6e2f7631222c2273657175656e6365223a307d0a",
	"server-ready/v1":
		"000001747b226368696c64496e7374616e63654e6f6e6365223a2263336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333222c226368696c6450676964223a343234322c226368696c64506964223a343234322c22636f686f72744772616e74536861323536223a2236303630363036303630363036303630363036303630363036303630363036303630363036303630363036303630363036303630363036303630363036303630222c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c226c697374656e696e6741646472657373223a223132372e302e302e313a3434343433222c22736368656d61223a227365727665722d72656164792f7631222c2273657175656e6365223a307d0a",
	"server-warmup-start/v1":
		"000000f17b22636f686f72745761726d757045706f6368426173653634223a225932396f62334a304c586468636d31316343316c6347396a61413d3d222c22636f686f72745761726d757045706f63685369676e6174757265426173653634223a225a5842765932677463326c6e222c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c22736368656d61223a227365727665722d7761726d75702d73746172742f7631222c2273657175656e6365223a317d0a",
	// The one schema that already had both halves at HEAD (§2.12 row 5). Pinned
	// here with the other fourteen so the whole lifecycle has one vector set.
	"server-warmup-ready/v1":
		"000000fd7b22636f686f72745761726d757045706f6368536861323536223a2237373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737222c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c22736368656d61223a227365727665722d7761726d75702d72656164792f7631222c2273657175656e6365223a312c227761726d7570436f756e746572735a65726f223a747275657d0a",
	"server-warmup-drain-and-reset/v1":
		"000001557b22636f686f72745761726d757045706f6368536861323536223a2237373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737222c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c22726f6c655761726d7570436f6d706c6574696f6e4d616e6966657374536861323536223a2238383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838222c22736368656d61223a227365727665722d7761726d75702d647261696e2d616e642d72657365742f7631222c2273657175656e6365223a327d0a",
	"server-warmup-drained/v1":
		"000002347b22636f686f72745761726d757045706f6368536861323536223a2237373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737222c22647261696e656441744c696e75784e73223a22313233343536373839303132333435222c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c226c696e7578436c6f636b4964223a22434c4f434b5f4d4f4e4f544f4e4943222c226d65617375726564436f756e746572735a65726f223a747275652c227075626c69736865725761726d7570456e64436f756e74223a312c22726f6c655761726d7570436f6d706c6574696f6e4d616e6966657374536861323536223a2238383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838222c22736368656d61223a227365727665722d7761726d75702d647261696e65642f7631222c2273657175656e6365223a322c22737562736372696265725761726d7570456e64436f756e74223a313030302c227761726d757044656c69766572696573223a353030303030302c227761726d7570496e6772657373223a353030302c227761726d7570517565756573456d707479223a747275657d0a",
	"server-measure-start/v1":
		"000000e17b22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c22736368656d61223a227365727665722d6d6561737572652d73746172742f7631222c2273657175656e6365223a332c227761726d7570436f6d706c657465536861323536223a2239633963396339633963396339633963396339633963396339633963396339633963396339633963396339633963396339633963396339633963396339633963227d0a",
	"server-measure-start-ack/v1":
		"000000e87b22626173656c696e6541744c696e75784e73223a22313233343536373839303132343030222c22626173656c696e65427573794d73223a313233342c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c226c696e7578436c6f636b4964223a22434c4f434b5f4d4f4e4f544f4e4943222c22736368656d61223a227365727665722d6d6561737572652d73746172742d61636b2f7631222c2273657175656e6365223a337d0a",
	"server-present-start-barrier/v1":
		"000001007b22636f686f7274537461727442617272696572426173653634223a225932396f62334a304c584e3059584a304c574a68636e4a705a58493d222c22636f686f72745374617274426172726965725369676e6174757265426173653634223a22596d4679636d6c6c6369317a6157633d222c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c22736368656d61223a227365727665722d70726573656e742d73746172742d626172726965722f7631222c2273657175656e6365223a347d0a",
	"server-start-barrier-accepted/v1":
		"000001537b22616363657074656441744c696e75784e73223a22313233343536373839303132353030222c22636f686f7274537461727442617272696572536861323536223a2262356235623562356235623562356235623562356235623562356235623562356235623562356235623562356235623562356235623562356235623562356235222c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c226c696e7578436c6f636b4964223a22434c4f434b5f4d4f4e4f544f4e4943222c226d6561737572656454726166666963416c6c6f776564223a747275652c22736368656d61223a227365727665722d73746172742d626172726965722d61636365707465642f7631222c2273657175656e6365223a347d0a",
	"server-stop-and-capture/v1":
		"000001007b22636f686f7274537461727442617272696572536861323536223a2262356235623562356235623562356235623562356235623562356235623562356235623562356235623562356235623562356235623562356235623562356235222c22647261696e446561646c696e654d73223a33303030302c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c22736368656d61223a227365727665722d73746f702d616e642d636170747572652f7631222c2273657175656e6365223a357d0a",
	"server-capture-ack/v1":
		"000001077b22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c226c696e757852656c61794f62736572766174696f6e426173653634223a2262476c7564586774636d567359586b7462324a7a5a584a32595852706232343d222c22736368656d61223a227365727665722d636170747572652d61636b2f7631222c2273657175656e6365223a352c22736e617073686f744672616d65426173653634223a2263325679646d56794c577876623341746458527062476c3659585270623234745a6e4a686257553d227d0a",
	"server-teardown/v1":
		"000000827b22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c22736368656d61223a227365727665722d74656172646f776e2f7631222c2273657175656e6365223a367d0a",
	"server-stopped/v1":
		"000000a77b22616c6c53657373696f6e73436c6f736564223a747275652c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c2265786974436f6465223a302c22736368656d61223a227365727665722d73746f707065642f7631222c2273657175656e6365223a367d0a",
};

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function buildFixture(schema: ServerChildSchema): Record<string, unknown> {
	const built = (() => {
		switch (schema) {
			case "child-pipe-refusal/v1":
				return buildChildPipeRefusal({
					sequence: 3,
					executionSha256: EXECUTION,
					code: "STATE_INVALID",
				});
			case "server-bind-execution/v1":
				return buildServerBindExecution({
					sequence: 0,
					executionSha256: EXECUTION,
					rigExecutionAcceptanceSha256: ACCEPTANCE,
					cohortGrantBase64: b64("cohort-grant"),
					cohortGrantSignatureBase64: b64("mac-receipt-sig"),
				});
			case "server-ready/v1":
				return buildServerReady({
					sequence: 0,
					executionSha256: EXECUTION,
					childPid: 4242,
					childPgid: 4242,
					childInstanceNonce: NONCE,
					cohortGrantSha256: GRANT_SHA,
					listeningAddress: "127.0.0.1:44443",
				});
			case "server-warmup-start/v1":
				return buildServerWarmupStart({
					sequence: 1,
					executionSha256: EXECUTION,
					cohortWarmupEpochBase64: b64("cohort-warmup-epoch"),
					cohortWarmupEpochSignatureBase64: b64("epoch-sig"),
				});
			case "server-warmup-ready/v1":
				return buildServerWarmupReady({
					sequence: 1,
					executionSha256: EXECUTION,
					cohortWarmupEpochSha256: EPOCH_SHA,
				});
			case "server-warmup-drain-and-reset/v1":
				return buildServerWarmupDrainAndReset({
					sequence: 2,
					executionSha256: EXECUTION,
					cohortWarmupEpochSha256: EPOCH_SHA,
					roleWarmupCompletionManifestSha256: MANIFEST_SHA,
				});
			case "server-warmup-drained/v1":
				return buildServerWarmupDrained({
					sequence: 2,
					executionSha256: EXECUTION,
					cohortWarmupEpochSha256: EPOCH_SHA,
					roleWarmupCompletionManifestSha256: MANIFEST_SHA,
					warmupIngress: 5000,
					warmupDeliveries: 5000000,
					publisherWarmupEndCount: 1,
					subscriberWarmupEndCount: 1000,
					drainedAtLinuxNs: "123456789012345",
					linuxClockId: "CLOCK_MONOTONIC",
				});
			case "server-measure-start/v1":
				return buildServerMeasureStart({
					sequence: 3,
					executionSha256: EXECUTION,
					warmupCompleteSha256: WARMUP_COMPLETE_SHA,
				});
			case "server-measure-start-ack/v1":
				return buildServerMeasureStartAck({
					sequence: 3,
					executionSha256: EXECUTION,
					baselineBusyMs: 1234,
					baselineAtLinuxNs: "123456789012400",
					linuxClockId: "CLOCK_MONOTONIC",
				});
			case "server-present-start-barrier/v1":
				return buildServerPresentStartBarrier({
					sequence: 4,
					executionSha256: EXECUTION,
					cohortStartBarrierBase64: b64("cohort-start-barrier"),
					cohortStartBarrierSignatureBase64: b64("barrier-sig"),
				});
			case "server-start-barrier-accepted/v1":
				return buildServerStartBarrierAccepted({
					sequence: 4,
					executionSha256: EXECUTION,
					cohortStartBarrierSha256: BARRIER_SHA,
					acceptedAtLinuxNs: "123456789012500",
					linuxClockId: "CLOCK_MONOTONIC",
				});
			case "server-stop-and-capture/v1":
				return buildServerStopAndCapture({
					sequence: 5,
					executionSha256: EXECUTION,
					cohortStartBarrierSha256: BARRIER_SHA,
					drainDeadlineMs: 30000,
				});
			case "server-capture-ack/v1":
				return buildServerCaptureAck({
					sequence: 5,
					executionSha256: EXECUTION,
					snapshotFrameBase64: b64("server-loop-utilization-frame"),
					linuxRelayObservationBase64: b64("linux-relay-observation"),
				});
			case "server-teardown/v1":
				return buildServerTeardown({
					sequence: 6,
					executionSha256: EXECUTION,
				});
			case "server-stopped/v1":
				return buildServerStopped({
					sequence: 6,
					executionSha256: EXECUTION,
					exitCode: 0,
				});
			default:
				throw new Error(`no builder for ${schema}`);
		}
	})();
	if (!built.ok) throw new Error(`builder refused ${schema}: ${built.code}`);
	return built.value as unknown as Record<string, unknown>;
}

describe("S1 — §2.12 server-child lifecycle schemas", () => {
	test("the_registry_lists_every_lifecycle_schema_once", () => {
		expect([...SERVER_CHILD_LIFECYCLE_SCHEMAS]).toEqual(
			Object.keys(KEY_SETS) as ServerChildSchema[],
		);
		expect(new Set(SERVER_CHILD_LIFECYCLE_SCHEMAS).size).toBe(15);
		for (const schema of SERVER_CHILD_LIFECYCLE_SCHEMAS) {
			expect(isServerChildSchema(schema)).toBe(true);
			expect(serverChildFrameBoundForSchema(schema)).toBe(
				CHILD_PIPE_CONTROL_MAX_BYTES,
			);
		}
		expect(isServerChildSchema("role-ready/v1")).toBe(false);
		expect(serverChildFrameBoundForSchema("role-ready/v1")).toBeNull();

		// §2.12: `PHASE_A_CHILD_SCHEMAS` is 18 entries -- the 15 lifecycle
		// schemas plus three non-lifecycle records that travel the same pipe and
		// are built elsewhere. The two lists are pinned so a schema cannot be
		// added to one without the other.
		expect(PHASE_A_CHILD_SCHEMAS.length).toBe(18);
		expect(PHASE_A_CHILD_SCHEMAS.slice(0, 15)).toEqual([
			...SERVER_CHILD_LIFECYCLE_SCHEMAS,
		]);
		expect(PHASE_A_CHILD_SCHEMAS.slice(15)).toEqual([
			"server-loop-utilization/v1",
			"bulk-source-completion/v1",
			"bulk-sink-series/v1",
		]);
	});

	for (const schema of SERVER_CHILD_LIFECYCLE_SCHEMAS) {
		const keys = KEY_SETS[schema];
		test(`the_key_set_of_${schema.replace(/[^a-z0-9]+/g, "_")}_is_exact`, () => {
			expect([...SERVER_CHILD_KEY_SETS[schema]]).toEqual([...keys]);

			const body = BODIES[schema];
			expect(Object.keys(body).sort()).toEqual([...keys]);

			const accepted = parseServerChildPayload(schema, body);
			expect(accepted.ok).toBe(true);

			const extra = parseServerChildPayload(schema, { ...body, extra: 1 });
			expect(extra.ok).toBe(false);

			for (const key of keys) {
				const missing = { ...body } as Record<string, unknown>;
				delete missing[key];
				const parsed = parseServerChildPayload(schema, missing);
				expect(parsed.ok).toBe(false);
			}
		});

		test(`the_builder_of_${schema.replace(/[^a-z0-9]+/g, "_")}_produces_the_pinned_frame`, () => {
			const built = buildFixture(schema);
			expect(built).toEqual(BODIES[schema]);
			const frame = encodeServerChildFrame(built as never);
			expect(frame.ok).toBe(true);
			if (!frame.ok) return;
			expect(hex(frame.value)).toBe(HEX_VECTORS[schema]);
			const decoded = decodeServerChildFrame(frame.value, schema);
			expect(decoded.ok).toBe(true);
			if (!decoded.ok) return;
			expect(decoded.value).toEqual(BODIES[schema]);
		});
	}

	test("the_capture_ack_carries_base64_not_nested_records", () => {
		const keys = SERVER_CHILD_KEY_SETS["server-capture-ack/v1"];
		expect(keys).toContain("snapshotFrameBase64");
		expect(keys).toContain("linuxRelayObservationBase64");
		expect(keys).not.toContain("snapshotFrame");
		expect(keys).not.toContain("linuxRelayObservation");

		const nested = parseServerChildPayload("server-capture-ack/v1", {
			schema: "server-capture-ack/v1",
			sequence: 5,
			executionSha256: EXECUTION,
			snapshotFrame: { schema: "server-loop-utilization/v1" },
			linuxRelayObservation: null,
		});
		expect(nested.ok).toBe(false);

		// The observation half is nullable; the snapshot half never is.
		const withoutObservation = buildServerCaptureAck({
			sequence: 5,
			executionSha256: EXECUTION,
			snapshotFrameBase64: b64("server-loop-utilization-frame"),
			linuxRelayObservationBase64: null,
		});
		expect(withoutObservation.ok).toBe(true);
		const withoutSnapshot = buildServerCaptureAck({
			sequence: 5,
			executionSha256: EXECUTION,
			snapshotFrameBase64: null as never,
			linuxRelayObservationBase64: null,
		});
		expect(withoutSnapshot.ok).toBe(false);
	});

	test("the_base64_and_ns_validators_match_the_remote_codecs_semantics", () => {
		// Characterises the two rules copied from `isStrictBase64`
		// (`cross-supervisor-protocol.ts:1910`) and `NS_STRING_PATTERN` (`:2493`),
		// which are module-private there. A divergence in either copy shows up
		// here rather than as a frame one side accepts and the other refuses.
		const base64Cases: readonly (readonly [string | null, boolean])[] = [
			["Y29ob3J0", true],
			["YQ==", true],
			["YWI=", true],
			["", false],
			["YQ=", false],
			["Y", false],
			["YQ===", false],
			["Y29o b3J0", false],
			["Y29ob3J-", false],
			[null, true], // only where the field is nullable
		];
		for (const [value, accepted] of base64Cases) {
			const built = buildServerCaptureAck({
				sequence: 5,
				executionSha256: EXECUTION,
				snapshotFrameBase64: b64("frame"),
				linuxRelayObservationBase64: value,
			});
			expect(built.ok).toBe(accepted);
		}

		const nsCases: readonly (readonly [string, boolean])[] = [
			["0", true],
			["1", true],
			["123456789012345", true],
			["01", false],
			["", false],
			["-1", false],
			["1.5", false],
			["12345678901234567890123", false],
		];
		for (const [value, accepted] of nsCases) {
			const built = buildServerMeasureStartAck({
				sequence: 3,
				executionSha256: EXECUTION,
				baselineBusyMs: 0,
				baselineAtLinuxNs: value,
				linuxClockId: "CLOCK_MONOTONIC",
			});
			expect(built.ok).toBe(accepted);
		}
	});

	test("a_fractional_baseline_busy_ms_is_refused_on_both_sides_of_the_pipe", () => {
		// D1. `secure_fs::cohort::canonical_bytes` refuses every non-integer
		// number at encode time, and §1.3 row 2 carries `baselineBusyMs`
		// verbatim from this frame into `rig-measure-start-ack/v1`. A codec that
		// admitted `1234.5` here would be admitting a record the rig could never
		// turn into a receipt. The Rust half of this refusal is
		// `a_fractional_baseline_busy_ms_cannot_reach_a_rig_receipt`
		// (`crates/native/tests/rig_cohort_runtime.rs`); both sides refuse, and
		// the accepted integer form is vector 9, pinned in both languages.
		const busyCases: readonly (readonly [number, boolean])[] = [
			[0, true],
			[1234, true],
			[Number.MAX_SAFE_INTEGER, true],
			[1234.5, false],
			[-1, false],
			[Number.NaN, false],
			[Number.POSITIVE_INFINITY, false],
			[Number.MAX_SAFE_INTEGER + 2, false],
		];
		for (const [value, accepted] of busyCases) {
			const built = buildServerMeasureStartAck({
				sequence: 3,
				executionSha256: EXECUTION,
				baselineBusyMs: value,
				baselineAtLinuxNs: "123456789012400",
				linuxClockId: "CLOCK_MONOTONIC",
			});
			expect(built.ok).toBe(accepted);
			if (!built.ok) expect(built.code).toBe("FRAME_INVALID");
		}

		// And the same value arriving from the wire is refused, not coerced.
		const parsed = parseServerChildPayload("server-measure-start-ack/v1", {
			...BODIES["server-measure-start-ack/v1"],
			baselineBusyMs: 1234.5,
		});
		expect(parsed.ok).toBe(false);
	});

	test("a_literal_true_field_that_is_false_is_a_state_refusal", () => {
		const drained = parseServerChildPayload("server-warmup-drained/v1", {
			...BODIES["server-warmup-drained/v1"],
			warmupQueuesEmpty: false,
		});
		expect(drained.ok).toBe(false);
		if (drained.ok) return;
		expect(drained.code).toBe("STATE_INVALID");

		const stopped = parseServerChildPayload("server-stopped/v1", {
			...BODIES["server-stopped/v1"],
			allSessionsClosed: false,
		});
		expect(stopped.ok).toBe(false);
		if (stopped.ok) return;
		expect(stopped.code).toBe("STATE_INVALID");
	});

	test("a_grant_without_its_mac_signature_is_refused_on_the_bind_frame", () => {
		const built = buildServerBindExecution({
			sequence: 0,
			executionSha256: EXECUTION,
			rigExecutionAcceptanceSha256: ACCEPTANCE,
			cohortGrantBase64: b64("cohort-grant"),
			cohortGrantSignatureBase64: null,
		});
		expect(built.ok).toBe(false);

		const phaseA = buildServerBindExecution({
			sequence: 0,
			executionSha256: EXECUTION,
			rigExecutionAcceptanceSha256: ACCEPTANCE,
			cohortGrantBase64: null,
			cohortGrantSignatureBase64: null,
		});
		expect(phaseA.ok).toBe(true);
	});

	test("a_frame_over_64_kib_is_refused", () => {
		const oversize = "A".repeat(CHILD_PIPE_CONTROL_MAX_BYTES);
		const built = buildServerCaptureAck({
			sequence: 5,
			executionSha256: EXECUTION,
			snapshotFrameBase64: oversize,
			linuxRelayObservationBase64: null,
		});
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		const encoded = encodeServerChildFrame(built.value as never);
		expect(encoded.ok).toBe(false);
		if (encoded.ok) return;
		expect(encoded.code).toBe("FRAME_INVALID");

		// A frame whose declared length exceeds the cap is refused before the
		// body is parsed at all.
		const lying = new Uint8Array(8);
		new DataView(lying.buffer).setUint32(
			0,
			CHILD_PIPE_CONTROL_MAX_BYTES + 1,
			false,
		);
		const decoded = decodeServerChildFrame(lying);
		expect(decoded.ok).toBe(false);
		if (decoded.ok) return;
		expect(decoded.code).toBe("FRAME_INVALID");
	});

	test("the_lifecycle_order_is_the_one_the_design_pins", () => {
		expect([...SERVER_CHILD_RIG_TO_CHILD_ORDER]).toEqual([
			"server-bind-execution/v1",
			"server-warmup-start/v1",
			"server-warmup-drain-and-reset/v1",
			"server-measure-start/v1",
			"server-present-start-barrier/v1",
			"server-stop-and-capture/v1",
			"server-teardown/v1",
		]);
		expect([...SERVER_CHILD_CHILD_TO_RIG_ORDER]).toEqual([
			"server-ready/v1",
			"server-warmup-ready/v1",
			"server-warmup-drained/v1",
			"server-measure-start-ack/v1",
			"server-start-barrier-accepted/v1",
			"server-capture-ack/v1",
			"server-stopped/v1",
		]);
		expect(SERVER_CHILD_RIG_TO_CHILD_ORDER.length).toBe(7);
		expect(SERVER_CHILD_CHILD_TO_RIG_ORDER.length).toBe(7);
		expect(SERVER_CHILD_RIG_TO_CHILD_ORDER.length).toBeLessThanOrEqual(
			CHILD_PIPE_RIG_SERVER_MAX_FRAMES_PER_DIRECTION,
		);
	});

	test("the_sequences_are_independent_per_direction", () => {
		const lifecycle = createServerChildLifecycle();

		// Three R->C frames in a row: the C->R direction has not moved.
		for (const [index, schema] of SERVER_CHILD_RIG_TO_CHILD_ORDER.slice(
			0,
			3,
		).entries()) {
			const step = stepServerChildLifecycle(lifecycle, "rigToChild", {
				schema,
				sequence: index,
			});
			expect(step.ok).toBe(true);
		}
		expect(lifecycle.rigToChild.sequence).toBe(3);
		expect(lifecycle.childToRig.sequence).toBe(0);

		// The C->R direction still starts at 0 with its own first schema.
		const first = stepServerChildLifecycle(lifecycle, "childToRig", {
			schema: "server-ready/v1",
			sequence: 0,
		});
		expect(first.ok).toBe(true);

		// A C->R frame numbered from the other direction's counter is refused.
		const crossed = stepServerChildLifecycle(lifecycle, "childToRig", {
			schema: "server-warmup-ready/v1",
			sequence: 3,
		});
		expect(crossed.ok).toBe(false);
		if (crossed.ok) return;
		expect(crossed.code).toBe("SEQUENCE_INVALID");
	});

	test("an_out_of_order_schema_is_a_state_refusal", () => {
		const lifecycle = createServerChildLifecycle();
		const step = stepServerChildLifecycle(lifecycle, "rigToChild", {
			schema: "server-teardown/v1",
			sequence: 0,
		});
		expect(step.ok).toBe(false);
		if (step.ok) return;
		expect(step.code).toBe("STATE_INVALID");
	});

	test("a_refusal_is_admissible_at_any_point_and_ends_the_stream", () => {
		const lifecycle = createServerChildLifecycle();
		const refusal = stepServerChildLifecycle(lifecycle, "childToRig", {
			schema: "child-pipe-refusal/v1",
			sequence: 0,
		});
		expect(refusal.ok).toBe(true);
		expect(lifecycle.terminal).not.toBeNull();

		const after = stepServerChildLifecycle(lifecycle, "rigToChild", {
			schema: "server-bind-execution/v1",
			sequence: 0,
		});
		expect(after.ok).toBe(false);
		if (after.ok) return;
		expect(after.code).toBe("STATE_INVALID");
	});

	test("a_direction_is_capped_at_thirty_two_frames", () => {
		const lifecycle = createServerChildLifecycle();
		lifecycle.rigToChild.sequence =
			CHILD_PIPE_RIG_SERVER_MAX_FRAMES_PER_DIRECTION;
		lifecycle.rigToChild.index = SERVER_CHILD_RIG_TO_CHILD_ORDER.length - 1;
		const step = stepServerChildLifecycle(lifecycle, "rigToChild", {
			schema: "server-teardown/v1",
			sequence: CHILD_PIPE_RIG_SERVER_MAX_FRAMES_PER_DIRECTION,
		});
		expect(step.ok).toBe(false);
		if (step.ok) return;
		expect(step.code).toBe("SEQUENCE_INVALID");
	});
});
