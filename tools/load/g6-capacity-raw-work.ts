/** Shared executable raw-work checks for attribution and capacity grading. */

import type { OperationReceipt } from "./g6-c32-freeze-model.ts";
import type { HostIdentityPacket } from "./g6-c32-host.ts";
import type { SuccessorGradeRequest } from "./g6-c32-successor-grade.ts";
import { G6_SHARDED_VALIDITY } from "./g6-sharded-grade.ts";

type JsonRecord = Record<string, unknown>;
type LadderProfile = Required<SuccessorGradeRequest["profile"]>;
export type RawPairIdentity = Record<
	"server" | "generator",
	HostIdentityPacket
>;
function fail(message: string): never {
	throw Error(message);
}
function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function requireRecord(value: unknown, label: string): JsonRecord {
	if (!isRecord(value)) fail(`${label} must be an object`);
	return value;
}
function requireSafeInteger(
	value: unknown,
	label: string,
	minimum = 0,
): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum)
		fail(`${label} must be a safe integer >= ${minimum}`);
	return value as number;
}
function requireCount(value: unknown, label: string): number {
	return requireSafeInteger(value, label);
}

export function validateRawNumbers(scan: JsonRecord, report: JsonRecord): void {
	for (const key of [
		"sessionsRequested",
		"sessionsOk",
		"sessionsErr",
		"activeWorkloadSessions",
	] as const)
		requireCount(report[key], `client.${key}`);
	const windows = requireRecord(report.windows, "client.windows");
	const steady = requireRecord(windows.steady, "client.windows.steady");
	const drain = requireRecord(
		windows.steadyDrain,
		"client.windows.steadyDrain",
	);
	requireSafeInteger(steady.sent, "client steady sent", 1);
	requireCount(steady.sessionsLost, "client steady sessionsLost");
	requireCount(drain.rxSnapshot, "client steadyDrain rxSnapshot");
	const aggregate = requireRecord(scan.aggregate, "scan.aggregate");
	const aggregateSteady = requireRecord(aggregate.steady, "aggregate.steady");
	requireCount(aggregateSteady.rxTotal, "aggregate steady rxTotal");
	for (const phase of ["steady", "steadyDrain"] as const) {
		const emitter = requireRecord(
			requireRecord(aggregate[phase], `aggregate.${phase}`).emitter,
			`aggregate.${phase}.emitter`,
		);
		requireSafeInteger(
			emitter.snapshotIssued,
			`aggregate.${phase}.snapshotIssued`,
			1,
		);
		if (phase === "steady")
			requireCount(emitter.sendErrors, "aggregate.steady.sendErrors");
	}
	if (!Array.isArray(scan.shards)) fail("scan.shards must be an array");
	for (const [index, value] of scan.shards.entries()) {
		const shard = requireRecord(value, `shard ${index}`);
		requireSafeInteger(shard.serverId, `shard ${index} serverId`, 1);
		requireCount(shard.sessionsAtSteady, `shard ${index} sessionsAtSteady`);
		const shardWindows = requireRecord(shard.windows, `shard ${index} windows`);
		for (const phase of ["steady", "steadyDrain", "lifetime"] as const) {
			const boundary = requireRecord(
				shardWindows[phase],
				`shard ${index} ${phase}`,
			);
			if (
				typeof boundary.wallMs !== "number" ||
				!Number.isFinite(boundary.wallMs) ||
				boundary.wallMs <= 0
			)
				fail(`shard ${index} ${phase} wallMs is invalid`);
			if (
				phase === "steady" &&
				Math.abs(boundary.wallMs - G6_SHARDED_VALIDITY.steadySeconds * 1000) >
					G6_SHARDED_VALIDITY.steadyWallMsTolerance
			)
				fail(`shard ${index} steady wallMs does not cover the rated window`);
			if (
				phase !== "steady" &&
				boundary.wallMs <
					(requireRecord(shardWindows.steady, "steady window").wallMs as number)
			)
				fail(`shard ${index} ${phase} wallMs is shorter than steady`);
			requireCount(boundary.rxTotal, `shard ${index} ${phase} rxTotal`);
			const emitter = requireRecord(
				boundary.emitter,
				`shard ${index} ${phase} emitter`,
			);
			requireCount(
				emitter.snapshotIssued,
				`shard ${index} ${phase} snapshotIssued`,
			);
			requireCount(emitter.sendErrors, `shard ${index} ${phase} sendErrors`);
		}
	}
	// These are producer sums, not an independent source of truth. Reconcile
	// every clause-driving counter before either ladder or companion grading.
	for (const phase of ["steady", "steadyDrain", "lifetime"] as const) {
		const aggregateWindow = requireRecord(
			aggregate[phase],
			`aggregate.${phase}`,
		);
		const aggregateEmitter = requireRecord(
			aggregateWindow.emitter,
			`aggregate.${phase}.emitter`,
		);
		for (const key of ["rxTotal", "snapshotIssued", "sendErrors"] as const) {
			const observed = requireCount(
				key === "rxTotal" ? aggregateWindow[key] : aggregateEmitter[key],
				`aggregate.${phase}.${key}`,
			);
			const total = scan.shards.reduce((sum: number, value: unknown) => {
				const window = requireRecord(
					requireRecord(requireRecord(value, "shard").windows, "shard windows")[
						phase
					],
					"shard window",
				);
				return requireCount(
					sum +
						requireCount(
							key === "rxTotal"
								? window[key]
								: requireRecord(window.emitter, "shard emitter")[key],
							`shard ${phase}.${key}`,
						),
					"aggregate sum",
				);
			}, 0);
			if (observed !== total)
				fail(`aggregate.${phase}.${key} contradicts raw shard counters`);
		}
	}
}

export function validateRawLifecycle(
	diagnostic: JsonRecord,
	scan: JsonRecord,
	operation: OperationReceipt,
	shards: number,
): void {
	const lifecycle = diagnostic.perShardLifecycle;
	if (!Array.isArray(lifecycle) || lifecycle.length !== shards)
		fail("lifecycle shard evidence is missing");
	const phases = ["connect", "steady", "drain", "idle", "stop"];
	const scanIds = (scan.shards as JsonRecord[]).map((shard) => shard.serverId);
	const lifecycleIds = lifecycle.map((shard) =>
		requireSafeInteger(
			requireRecord(shard, "lifecycle shard").serverId,
			"lifecycle serverId",
			1,
		),
	);
	if (
		scanIds.length !== shards ||
		new Set(scanIds).size !== shards ||
		new Set(lifecycleIds).size !== shards ||
		scanIds.some((id) => !lifecycleIds.includes(id as number))
	)
		fail("scan/lifecycle shard membership differs");
	const lower = Date.parse(operation.startedAt),
		upper = Date.parse(operation.finishedAt);
	for (const value of lifecycle) {
		const shard = requireRecord(value, "lifecycle shard");
		if (
			!Array.isArray(shard.boundaries) ||
			shard.boundaries.length !== phases.length ||
			shard.boundaries.some(
				(boundary, index) =>
					!isRecord(boundary) || boundary.phase !== phases[index],
			)
		)
			fail("lifecycle phase boundaries are missing or unordered");
		let previous = lower;
		const times = shard.boundaries.map((value, index) => {
			const ts = requireSafeInteger(
				requireRecord(value, "lifecycle boundary").tsMs,
				"lifecycle boundary timestamp",
				1,
			);
			if (
				ts < previous ||
				ts > upper ||
				(index > 0 && ts < Date.parse(scan.startedAt as string))
			)
				fail(
					"lifecycle boundary timestamps are unordered or outside this scan operation",
				);
			previous = ts;
			return ts;
		});
		const steadyAt = times[1],
			drainAt = times[2];
		if (steadyAt === undefined || drainAt === undefined)
			fail("missing steady interval");
		if (
			Math.abs(drainAt - steadyAt - G6_SHARDED_VALIDITY.steadySeconds * 1000) >
			G6_SHARDED_VALIDITY.steadyWallMsTolerance
		)
			fail("lifecycle steady interval does not cover the rated window");
		if (!Array.isArray(shard.exits) || shard.exits.length !== 1)
			fail("lifecycle exits are missing or ambiguous");
		const exit = requireRecord(shard.exits[0], "lifecycle exit");
		const exitAt = requireSafeInteger(exit.tsMs, "lifecycle exit timestamp", 1);
		if (exitAt < previous || exitAt > upper)
			fail("lifecycle exit is outside the terminal scan interval");
		// An observed unsuccessful exit is a measured failure, not absent proof.
		if (
			!(
				(Number.isSafeInteger(exit.code) &&
					(exit.code as number) >= 0 &&
					exit.signal === null) ||
				(exit.code === null &&
					typeof exit.signal === "string" &&
					exit.signal.length > 0)
			)
		)
			fail("lifecycle exit status is malformed");
	}
}

export function validateScanCommand(
	operation: OperationReceipt,
	stdout: string,
	contract: {
		objective: { sourceSha: string };
		ladder: { profile: LadderProfile; registrationSha256: string };
	},
	pair: RawPairIdentity,
	sessions: number,
	active: number,
	startedAt: string,
	detailedProbe = true,
): void {
	const { action } = operation;
	const work = action.command === "work_scan";
	if (
		(work
			? action.args.length !== 4 ||
				!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(action.args[0] ?? "") ||
				operation.envelope.operationId !== `${action.args[0]}-scan` ||
				action.args[1] !==
					`/root/webtransport-bun/.scratch/bare-metal-campaign/runs/${operation.envelope.runId}/cells/work-${action.args[0]}` ||
				action.args[2] !== "env"
			: action.command !== "g6_ssh" ||
				action.args.length !== 3 ||
				action.args[0] !== `root@${pair.server.provider.publicIpv4}` ||
				action.args[1] !== "env") ||
		operation.envelope.phase !== "RUNNING"
	)
		fail(
			"scan command does not execute the registered scanner on the exact server",
		);
	// Match the producer's constrained assignment prefix and shell suffix; do
	// not treat an arbitrary string containing expected flags as execution proof.
	const command = action.args[work ? 3 : 2];
	if (!command) fail("scan command is missing");
	const match = command.match(
		/^((?:[A-Z][A-Z0-9_]*=[A-Za-z0-9_./:@-]+ +)+)bash -lc "cd '(\/[A-Za-z0-9_./-]+)' && exec '(\/[A-Za-z0-9_./-]+)' tools\/load\/g6-sharded-scan\.ts"$/,
	);
	if (!match?.[1])
		fail("scan command has an unsupported or ambiguous invocation");
	const env: Record<string, string> = {};
	for (const assignment of match[1].trim().split(/ +/)) {
		const [key, value] = assignment.split("=") as [string, string];
		if (Object.hasOwn(env, key))
			fail("scan command repeats an environment assignment");
		env[key] = value;
	}
	const p = contract.ladder.profile;
	const fixed: Record<string, string | number> = {
		SCAN_DIAGNOSTIC: 1,
		SCAN_SHARDS: p.shards,
		SCAN_SESSIONS: sessions,
		SCAN_WORKLOAD_ACTIVE_SESSIONS: active,
		SCAN_ENDPOINTS: p.endpoints,
		SCAN_CONNECT_CONCURRENCY: p.connectConcurrency,
		SCAN_CONNECT_RATE_PER_SEC: p.connectRatePerSec,
		SCAN_FIXED_SOURCE_PORT_BASE: requireSafeInteger(
			p.fixedSourcePortBase,
			"registered source port base",
			1,
		),
		SCAN_ACK_REFLECTOR: p.ackReflector,
		SCAN_SERVER_WORKERS: p.serverWorkers,
		SCAN_SERVER_GRO: p.serverGro,
		SCAN_SERVER_RECV_RUNTIME: p.serverRecvRuntime,
		SCAN_ACK_CADENCE: p.ackCadence,
		SCAN_SERVER_UDP_SNDBUF_BYTES: p.serverUdpSendBufferBytes,
		SCAN_UDP_SEND_BATCH: p.udpSendBatch,
		SCAN_SERVER_UDP_SEND_EAGAIN_MODE: p.serverUdpSendEagainMode,
		SCAN_REFLECT_RING_BYPASS: p.reflectRingBypass,
		SCAN_LINUX_PROBE_ENABLED: detailedProbe ? 1 : 0,
		G6_OFFBOX_SSH: `root@${pair.generator.provider.privateIpv4}`,
		G6_SERVER_ADDRESS: pair.server.provider.privateIpv4,
		G6_CANDIDATE_SHA: contract.objective.sourceSha,
		G6_PREREGISTRATION_SHA256: contract.ladder.registrationSha256,
		G6_EMITTER_MODE: "native-mirror",
	};
	if (work)
		Object.assign(fixed, {
			SCAN_NATIVE_SEND_PATH_DIAGNOSTICS: 1,
			G6_OFFBOX_WORK_RUN_ID: operation.envelope.runId,
			G6_OFFBOX_WORK_NODE_ID: action.args[0],
			G6_OFFBOX_WORK_ROOT: `/root/webtransport-bun/.scratch/bare-metal-campaign/runs/${operation.envelope.runId}`,
			G6_OFFBOX_WORK_BOOT_ID: pair.generator.bootId,
		});
	// r5 profiles name the datagram read path; historical ones never carried it.
	const datagramPump = (p as { datagramPump?: string }).datagramPump;
	if (datagramPump !== undefined) fixed.SCAN_DATAGRAM_PUMP = datagramPump;
	else if (Object.hasOwn(env, "SCAN_DATAGRAM_PUMP"))
		fail("scan command sets a datagram path the registered profile lacks");
	// Generator process count: the profile's exact value when registered;
	// otherwise the launcher may only pass the single-process scan default.
	const clientProcesses = (p as { clientProcesses?: number }).clientProcesses;
	if (clientProcesses !== undefined)
		fixed.SCAN_CLIENT_PROCESSES = clientProcesses;
	else if (Object.hasOwn(env, "SCAN_CLIENT_PROCESSES"))
		fixed.SCAN_CLIENT_PROCESSES = 1;
	for (const [key, value] of Object.entries(fixed))
		if (env[key] !== String(value))
			fail(`scan command ${key} differs from registered host/profile`);
	const paths = [
		"G6_BPF_READY_RECEIPT",
		"SCAN_LINUX_PROBE_OUT",
		"SCAN_POST_RUN_STEERING_OUT",
		"SCAN_OUT",
		"SCAN_DIAGNOSTIC_OUT",
		"G6_OFFBOX_ENTRY_SCRIPT",
		"G6_OFFBOX_CLONE",
	];
	for (const path of [...paths.map((key) => env[key]), match[2], match[3]]) {
		if (
			!path?.startsWith("/") ||
			path.split("/").some((part) => part === "." || part === "..")
		)
			fail("scan command contains an invalid remote path");
	}
	if (
		!pair.server.binary.path.startsWith(`${match[2]}/`) ||
		!pair.generator.binary.path.startsWith(`${env.G6_OFFBOX_CLONE}/`) ||
		env.G6_OFFBOX_ENTRY_SCRIPT !==
			`${env.G6_OFFBOX_CLONE}/tools/offbox/linux-generator-entry-g6.sh`
	)
		fail("scan command checkout differs from the bound source binaries");
	if (!env.SCAN_OUT) fail("missing scan output path");
	const outRoot = env.SCAN_OUT.replace(/\/g6-sharded-scan\.json$/, "");
	if (work && outRoot !== action.args[1])
		fail("owned scan outputs differ from the exact work cell");
	for (const [key, leaf] of Object.entries({
		SCAN_OUT: "g6-sharded-scan.json",
		SCAN_DIAGNOSTIC_OUT: "g6-sharded-diagnostic.json",
		SCAN_LINUX_PROBE_OUT: "linux-probe.jsonl",
		SCAN_POST_RUN_STEERING_OUT: "post-run-steering.json",
		G6_BPF_READY_RECEIPT: "g6-shard-bpf-ready.json",
	}))
		if (env[key] !== `${outRoot}/${leaf}`)
			fail("scan command artifact paths do not share the same cell");
	const allowed = new Set([
		...Object.keys(fixed),
		...paths,
		"SCAN_NATIVE_SEND_PATH_DIAGNOSTICS",
	]);
	if (
		Object.keys(env).some((key) => !allowed.has(key)) ||
		(env.SCAN_NATIVE_SEND_PATH_DIAGNOSTICS !== undefined &&
			env.SCAN_NATIVE_SEND_PATH_DIAGNOSTICS !== "1")
	)
		fail("scan command has unregistered workload overrides");
	const lines = stdout.split(/\r?\n/);
	const startLines = lines.filter((line) =>
		line.startsWith("g6-sharded-scan: shards="),
	);
	const startPrefix = `g6-sharded-scan: shards=${p.shards} sessions=${sessions} paced=false url=https://${pair.server.provider.privateIpv4}:`;
	const startLine = startLines[0];
	if (
		startLines.length !== 1 ||
		!startLine?.startsWith(startPrefix) ||
		!/^\d+ started-at=/.test(startLine.slice(startPrefix.length)) ||
		!startLine.endsWith(` started-at=${startedAt}`) ||
		lines.filter((line) => line === "g6-sharded-scan: client exited 0")
			.length !== 1
	)
		fail("scan stdout does not witness this completed registered cell");
	const writes = lines.filter((line) =>
		line.startsWith("g6-sharded-scan: wrote "),
	);
	if (
		writes.length !== 2 ||
		writes[0] !== `g6-sharded-scan: wrote ${env.SCAN_OUT}` ||
		writes[1] !== `g6-sharded-scan: wrote ${env.SCAN_DIAGNOSTIC_OUT}`
	)
		fail("scan stdout does not witness both retained artifacts");
}

export function validateClientPorts(
	report: JsonRecord,
	profile: LadderProfile,
): void {
	const addresses = requireRecord(
		report.client,
		"client endpoint evidence",
	).endpointSourceAddresses;
	if (!Array.isArray(addresses) || addresses.length !== profile.endpoints)
		fail("client observed source-port pool is incomplete");
	const ports = addresses.map((address) =>
		typeof address === "string"
			? Number(address.match(/:(\d+)$/)?.[1])
			: Number.NaN,
	);
	const base = requireSafeInteger(
		profile.fixedSourcePortBase,
		"registered source port base",
		1,
	);
	if (
		new Set(ports).size !== profile.endpoints ||
		ports.some(
			(port) =>
				!Number.isSafeInteger(port) ||
				port < base ||
				port >= base + profile.endpoints,
		)
	)
		fail("endpoint source ports differ from registered pool");
}
