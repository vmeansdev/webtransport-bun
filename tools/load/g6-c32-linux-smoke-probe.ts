/** Production-only probes used by g6-c32-linux-smoke.sh on a prepared Linux host. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { countBpfMapEntries, sumPerCpuSteerStats } from "./g6-bpf-map.ts";

// The reuseport group size is the campaign's vCPU-derived shard count; the
// controller binds it into the environment, and the probe refuses to guess.
const SHARDS = requirePositiveInteger(
	process.env.G6_C32_SHARDS ?? "",
	"G6_C32_SHARDS",
);
const DEFAULT_PORT = 45_433;
const DEFAULT_FIXED_PORT_BASE = 45_000;
const DEFAULT_FIXED_PORT_COUNT = 512;
const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 30_000;
const PIN_PREFIX = "/sys/fs/bpf/g6-c32-smoke-";
const RFC3339_MILLIS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type ProbeOperation = {
	schema: "g6-c32-smoke-probe-operation/1";
	recordedAt: string;
	operationId: string;
	startedAt: string;
	finishedAt: string;
	durationMonotonicNs: string;
	outcome: "SUCCEEDED" | "FAILED";
	error: string | null;
};

type DaemonReady = {
	schema: "g6-c32-smoke-daemon-ready/1";
	recordedAt: string;
	startedAt: string;
	pid: number;
	port: number;
	instances: number;
	pinDirectory: string;
	repository: string;
};

type BunUdpSocket = {
	readonly port?: number;
	send(data: Uint8Array, port?: number, address?: string): number | boolean;
	close(): void;
};

function fail(message: string): never {
	throw new Error(`g6-c32-linux-smoke-probe: ${message}`);
}

function now(): string {
	return new Date().toISOString();
}

function requireTimestamp(value: string, label: string): string {
	if (!RFC3339_MILLIS_RE.test(value))
		fail(`${label} must be RFC3339 UTC milliseconds`);
	return value;
}

function requirePositiveInteger(value: string, label: string): number {
	if (!/^\d+$/.test(value)) fail(`${label} must be a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		fail(`${label} must be a positive integer`);
	}
	return parsed;
}

function requirePort(value: string, label: string): number {
	const parsed = requirePositiveInteger(value, label);
	if (parsed > 65_535) fail(`${label} must be at most 65535`);
	return parsed;
}

function argument(name: string, fallback?: string): string {
	const token = `--${name}`;
	const indexes = process.argv.flatMap((value, index) =>
		value === token ? [index] : [],
	);
	if (indexes.length > 1) fail(`${token} may be supplied only once`);
	const index = indexes[0];
	if (index === undefined) {
		if (fallback !== undefined) return fallback;
		fail(`${token} is required`);
	}
	const value = process.argv[index + 1];
	if (!value || value.startsWith("--")) fail(`${token} requires a value`);
	return value;
}

function assertKnownArguments(command: string, names: readonly string[]): void {
	const allowed = new Set(names.map((name) => `--${name}`));
	for (let index = 3; index < process.argv.length; index += 1) {
		const value = process.argv[index] as string;
		if (!value.startsWith("--")) continue;
		if (!allowed.has(value)) fail(`${command} received unknown flag ${value}`);
		index += 1;
	}
}

export function validateProbeStateRoot(value: string): string {
	if (!isAbsolute(value)) fail("state root must be absolute");
	if (
		normalize(value) !== value ||
		value.includes("/../") ||
		value.endsWith("/..")
	) {
		fail("state root must be normalized");
	}
	if (value === "/") fail("state root cannot be the root directory");
	return value;
}

function ensureStateRoot(value: string): string {
	const root = validateProbeStateRoot(value);
	if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
	if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
		fail("state root must be a real directory");
	}
	if (realpathSync(root) !== root) fail("state root cannot traverse symlinks");
	return root;
}

function requireRepository(value: string): string {
	if (!isAbsolute(value) || normalize(value) !== value) {
		fail("repository must be a normalized absolute path");
	}
	if (!lstatSync(value).isDirectory() || realpathSync(value) !== value) {
		fail("repository must be a real directory without symlink traversal");
	}
	return value;
}

function atomicJson(path: string, value: unknown): void {
	const staging = `${path}.staged-${process.pid}`;
	const fd = openSync(staging, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(staging, path);
}

function appendOperation(root: string, operation: ProbeOperation): void {
	requireTimestamp(operation.recordedAt, "operation.recordedAt");
	requireTimestamp(operation.startedAt, "operation.startedAt");
	requireTimestamp(operation.finishedAt, "operation.finishedAt");
	if (!/^\d+$/.test(operation.durationMonotonicNs)) {
		fail("operation.durationMonotonicNs must be a nonnegative decimal string");
	}
	const path = join(root, "probe-operations.jsonl");
	appendFileSync(path, `${JSON.stringify(operation)}\n`, { mode: 0o600 });
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export function makeProbeOperation(input: {
	operationId: string;
	startedAt: string;
	finishedAt: string;
	startedMonotonicNs: bigint;
	finishedMonotonicNs: bigint;
	outcome: "SUCCEEDED" | "FAILED";
	error: string | null;
}): ProbeOperation {
	const startedAt = requireTimestamp(input.startedAt, "operation.startedAt");
	const finishedAt = requireTimestamp(input.finishedAt, "operation.finishedAt");
	if (Date.parse(finishedAt) < Date.parse(startedAt)) {
		fail("operation wall timestamps moved backwards");
	}
	if (
		input.startedMonotonicNs < 0n ||
		input.finishedMonotonicNs < input.startedMonotonicNs
	) {
		fail("operation monotonic clock moved backwards");
	}
	if (!input.operationId || input.operationId.includes("\0")) {
		fail("operationId is invalid");
	}
	if (
		(input.outcome === "SUCCEEDED" && input.error !== null) ||
		(input.outcome === "FAILED" &&
			(typeof input.error !== "string" || input.error === ""))
	) {
		fail("operation outcome and error are inconsistent");
	}
	return {
		schema: "g6-c32-smoke-probe-operation/1",
		recordedAt: finishedAt,
		operationId: input.operationId,
		startedAt,
		finishedAt,
		durationMonotonicNs: (
			input.finishedMonotonicNs - input.startedMonotonicNs
		).toString(10),
		outcome: input.outcome,
		error: input.error,
	};
}

async function recorded<T>(
	root: string,
	operationId: string,
	work: () => T | Promise<T>,
): Promise<T> {
	const startedAt = now();
	const startedMonotonicNs = process.hrtime.bigint();
	try {
		const result = await work();
		const finishedAt = now();
		const finishedMonotonicNs = process.hrtime.bigint();
		appendOperation(
			root,
			makeProbeOperation({
				operationId,
				startedAt,
				finishedAt,
				startedMonotonicNs,
				finishedMonotonicNs,
				outcome: "SUCCEEDED",
				error: null,
			}),
		);
		return result;
	} catch (error) {
		const finishedAt = now();
		const finishedMonotonicNs = process.hrtime.bigint();
		appendOperation(
			root,
			makeProbeOperation({
				operationId,
				startedAt,
				finishedAt,
				startedMonotonicNs,
				finishedMonotonicNs,
				outcome: "FAILED",
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		throw error;
	}
}

function pinDirectory(root: string): string {
	const suffix = createHash("sha256").update(root).digest("hex").slice(0, 20);
	return `${PIN_PREFIX}${suffix}`;
}

function runCommand(
	root: string,
	operationId: string,
	command: string,
	args: readonly string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): string {
	const startedAt = now();
	const startedMonotonicNs = process.hrtime.bigint();
	const result = spawnSync(command, [...args], {
		cwd: options.cwd,
		env: options.env ?? process.env,
		encoding: "utf8",
		timeout: options.timeoutMs ?? 60_000,
		maxBuffer: 16 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const finishedAt = now();
	const finishedMonotonicNs = process.hrtime.bigint();
	writeFileSync(join(root, `${operationId}.stdout`), result.stdout ?? "");
	writeFileSync(join(root, `${operationId}.stderr`), result.stderr ?? "");
	const error = result.error
		? String(result.error)
		: result.status === 0
			? null
			: `exit=${result.status ?? "signal"} signal=${result.signal ?? "none"}`;
	appendOperation(
		root,
		makeProbeOperation({
			operationId,
			startedAt,
			finishedAt,
			startedMonotonicNs,
			finishedMonotonicNs,
			outcome: error === null ? "SUCCEEDED" : "FAILED",
			error,
		}),
	);
	if (error !== null) fail(`${operationId} failed: ${error}`);
	return result.stdout ?? "";
}

function readJson(path: string, label: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		fail(`${label} is unreadable: ${String(error)}`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function readReady(root: string): DaemonReady {
	const value = readJson(
		join(root, "daemon-ready.json"),
		"daemon ready record",
	);
	if (
		value.schema !== "g6-c32-smoke-daemon-ready/1" ||
		typeof value.recordedAt !== "string" ||
		typeof value.startedAt !== "string" ||
		!Number.isSafeInteger(value.pid) ||
		!Number.isSafeInteger(value.port) ||
		value.instances !== SHARDS ||
		typeof value.pinDirectory !== "string" ||
		typeof value.repository !== "string"
	) {
		fail("daemon ready record is malformed");
	}
	requireTimestamp(value.recordedAt, "daemon recordedAt");
	requireTimestamp(value.startedAt, "daemon startedAt");
	return value as DaemonReady;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(
	label: string,
	timeoutMs: number,
	predicate: () => boolean,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) fail(`${label} timed out after ${timeoutMs}ms`);
		await Bun.sleep(50);
	}
}

export function buildSteeringDatagram(serverId: number): Uint8Array {
	if (!Number.isSafeInteger(serverId) || serverId < 1 || serverId > SHARDS) {
		fail(`server ID must be 1..${SHARDS}`);
	}
	// QUIC short header + 11-byte keyless QUIC-LB CID. The CID is
	// rotation=0, server-id=[0, serverId], nonce=[1..8].
	return Uint8Array.of(
		0x40,
		0x00,
		0x00,
		serverId,
		0x01,
		0x02,
		0x03,
		0x04,
		0x05,
		0x06,
		0x07,
		0x08,
	);
}

export function fixedSourcePortReceipt(
	recordedAt: string,
	base: number,
	count: number,
	ports: ReadonlySet<number>,
): {
	schema: "g6-fixed-source-port-smoke/1";
	recordedAt: string;
	base: number;
	count: number;
	distinct: number;
	withinRange: boolean;
	passed: true;
} {
	requireTimestamp(recordedAt, "fixed source-port recordedAt");
	const withinRange =
		Number.isSafeInteger(base) &&
		Number.isSafeInteger(count) &&
		base >= 1 &&
		count >= 1 &&
		base + count - 1 <= 65_535 &&
		[...ports].every((port) => port >= base && port < base + count);
	if (!withinRange || ports.size !== count) {
		fail("did not bind every fixed source port in the registered range");
	}
	return {
		schema: "g6-fixed-source-port-smoke/1",
		recordedAt,
		base,
		count,
		distinct: ports.size,
		withinRange,
		passed: true,
	};
}

async function fixedSourcePort(
	root: string,
	base: number,
	count: number,
): Promise<void> {
	if (base + count - 1 > 65_535) fail("fixed source-port range exceeds 65535");
	const sockets: BunUdpSocket[] = [];
	const ports = new Set<number>();
	await recorded(root, "bind-fixed-source-port-range", async () => {
		try {
			for (let index = 0; index < count; index += 1) {
				const expected = base + index;
				const socket = (await Bun.udpSocket({
					hostname: "0.0.0.0",
					port: expected,
					socket: { data: () => {} },
				})) as BunUdpSocket;
				sockets.push(socket);
				if (socket.port !== expected)
					fail(`kernel bound ${socket.port} instead of ${expected}`);
				ports.add(expected);
			}
		} finally {
			for (const socket of sockets) socket.close();
		}
	});
	process.stdout.write(
		`${JSON.stringify(fixedSourcePortReceipt(now(), base, count, ports))}\n`,
	);
}

function dumpMap(root: string, name: string): string {
	return runCommand(
		root,
		`dump-${name}`,
		"bpftool",
		["-j", "map", "dump", "pinned", `${pinDirectory(root)}/${name}`],
		{ timeoutMs: 5_000 },
	);
}

function inspectMaps(root: string): {
	socksEntries: number;
	steered: number;
	fallback: number;
} {
	const socksEntries = countBpfMapEntries(dumpMap(root, "socks"));
	const stats = sumPerCpuSteerStats(dumpMap(root, "steer_stats"));
	if (socksEntries === null || stats === null)
		fail("BPF map dump is malformed");
	return { socksEntries, ...stats };
}

async function daemon(
	root: string,
	repository: string,
	port: number,
): Promise<void> {
	if (process.platform !== "linux") fail("daemon requires Linux");
	const startedAt = now();
	const pin = pinDirectory(root);
	const setup = join(repository, "tools/load/g6-shard-bpf-setup.sh");
	const readyReceipt = join(root, "g6-shard-bpf-ready.json");
	const servers: Array<{ close(): Promise<void> }> = [];
	let tlsCleanup: (() => void) | null = null;
	let stopping = false;
	const requestStop = (): void => {
		stopping = true;
	};
	process.on("SIGINT", requestStop);
	process.on("SIGTERM", requestStop);
	try {
		runCommand(root, `setup-bpf-${SHARDS}`, "bash", [setup, String(SHARDS)], {
			cwd: repository,
			env: {
				...process.env,
				PIN_DIR: pin,
				BPF_OBJ: join(root, "steer_by_cid.bpf.o"),
				G6_BPF_READY_RECEIPT: readyReceipt,
			},
			timeoutMs: 120_000,
		});
		const [{ createServer }, { generateLocalhostCert }] = await Promise.all([
			import("../../packages/webtransport/src/index.ts"),
			import("../../packages/webtransport/test/helpers/certs.ts"),
		]);
		const tls = generateLocalhostCert();
		if (!tls) fail("certificate generation failed");
		tlsCleanup = tls.cleanup;
		for (let serverId = 1; serverId <= SHARDS; serverId += 1) {
			const server = await recorded(
				root,
				`create-reuseport-shard-${serverId}`,
				() =>
					createServer({
						port,
						tls: { certPem: tls.certPem, keyPem: tls.keyPem },
						reusePort: true,
						quicLb: {
							serverId: [0, serverId],
							nonceLen: 8,
							configRotation: 0,
						},
						reusePortSteering: {
							sockArrayPinPath: `${pin}/socks`,
							key: serverId - 1,
							...(serverId === 1
								? { attachProgPinPath: `${pin}/steer_by_cid` }
								: {}),
						},
						onSession: () => {},
					}),
			);
			servers.push(server);
		}
		await waitUntil(`${SHARDS}-entry sockarray`, READY_TIMEOUT_MS, () => {
			try {
				const maps = inspectMaps(root);
				return (
					maps.socksEntries === SHARDS &&
					maps.steered === 0 &&
					maps.fallback === 0
				);
			} catch {
				return false;
			}
		});
		const ready: DaemonReady = {
			schema: "g6-c32-smoke-daemon-ready/1",
			recordedAt: now(),
			startedAt,
			pid: process.pid,
			port,
			instances: SHARDS,
			pinDirectory: pin,
			repository,
		};
		atomicJson(join(root, "daemon-ready.json"), ready);
		await recorded(root, "hold-reuseport-group", async () => {
			while (!stopping && !existsSync(join(root, "stop-request.json"))) {
				await Bun.sleep(100);
			}
		});
	} catch (error) {
		atomicJson(join(root, "daemon-failure.json"), {
			schema: "g6-c32-smoke-daemon-failure/1",
			recordedAt: now(),
			startedAt,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	} finally {
		for (const [index, server] of [...servers].reverse().entries()) {
			try {
				await recorded(root, `close-reuseport-shard-${SHARDS - index}`, () =>
					server.close(),
				);
			} catch {
				// The failed close is already durable; continue closing the exact group.
			}
		}
		tlsCleanup?.();
		if (pin.startsWith(PIN_PREFIX) && pin.length > PIN_PREFIX.length) {
			rmSync(pin, { recursive: true, force: true });
		}
		atomicJson(join(root, "daemon-stopped.json"), {
			schema: "g6-c32-smoke-daemon-stopped/1",
			recordedAt: now(),
			startedAt,
			pid: process.pid,
		});
	}
}

async function boundedProbe(
	root: string,
	repository: string,
	bunPath: string,
	role: "server" | "generator",
): Promise<void> {
	if (process.platform !== "linux") fail("bounded probe requires Linux");
	if (role === "server") {
		const ready = readReady(root);
		if (!processIsAlive(ready.pid)) fail("reuseport daemon is not alive");
	}
	const out = join(root, `linux-preflight-${role}.json`);
	runCommand(
		root,
		`bounded-linux-preflight-${role}`,
		bunPath,
		[
			join(repository, "tools/load/g6-linux-probe.ts"),
			"--mode",
			"preflight",
			"--role",
			role,
			"--out",
			out,
		],
		{ cwd: repository, timeoutMs: 30_000 },
	);
	const preflight = readJson(out, "Linux preflight evidence");
	if (preflight.complete !== true || typeof preflight.capturedAt !== "string") {
		fail("Linux preflight evidence is incomplete");
	}
	requireTimestamp(preflight.capturedAt, "Linux preflight capturedAt");
	process.stdout.write(
		`${JSON.stringify({ schema: "g6-bounded-linux-probe/1", recordedAt: now(), bounded: true, exitCode: 0, passed: true })}\n`,
	);
}

async function steering(root: string): Promise<void> {
	if (process.platform !== "linux") fail("steering probe requires Linux");
	const ready = readReady(root);
	if (!processIsAlive(ready.pid)) fail("reuseport daemon is not alive");
	const before = inspectMaps(root);
	if (before.socksEntries !== SHARDS || before.fallback !== 0) {
		fail(`BPF group was not a fresh ${SHARDS}-entry zero-fallback group`);
	}
	await recorded(root, "send-steerable-quic-lb-datagram", async () => {
		const socket = (await Bun.udpSocket({
			connect: { hostname: "127.0.0.1", port: ready.port },
			socket: { data: () => {}, error: () => {} },
		})) as BunUdpSocket;
		try {
			socket.send(buildSteeringDatagram(SHARDS));
		} finally {
			socket.close();
		}
	});
	let after = before;
	await waitUntil("steering counter increment", 5_000, () => {
		after = inspectMaps(root);
		return after.steered > before.steered;
	});
	if (after.fallback !== 0) fail("steering probe incremented fallback");
	process.stdout.write(
		`${JSON.stringify({ schema: "g6-steering-smoke/1", recordedAt: now(), phase: "post-run", selected: true, steered: after.steered - before.steered, fallback: after.fallback })}\n`,
	);
}

function bpf(root: string): void {
	const ready = readReady(root);
	if (!processIsAlive(ready.pid)) fail("reuseport daemon is not alive");
	const maps = inspectMaps(root);
	const setupReceipt = readJson(
		join(root, "g6-shard-bpf-ready.json"),
		"BPF setup receipt",
	);
	if (
		setupReceipt.schema !== "g6-shard-bpf-ready/1" ||
		setupReceipt.instances !== SHARDS ||
		!Number.isSafeInteger(setupReceipt.createdAtMs)
	) {
		fail(`BPF setup receipt does not bind ${SHARDS} instances`);
	}
	if (maps.socksEntries !== SHARDS || maps.fallback !== 0) {
		fail(`BPF group is not a ${SHARDS}-entry zero-fallback group`);
	}
	process.stdout.write(
		`${JSON.stringify({ schema: "g6-bpf-smoke/1", recordedAt: now(), instances: SHARDS, socksEntries: maps.socksEntries, fallback: maps.fallback, passed: true })}\n`,
	);
}

async function stop(root: string): Promise<void> {
	if (!existsSync(join(root, "daemon-ready.json"))) return;
	const ready = readReady(root);
	if (processIsAlive(ready.pid)) {
		atomicJson(join(root, "stop-request.json"), {
			schema: "g6-c32-smoke-daemon-stop-request/1",
			recordedAt: now(),
			pid: ready.pid,
		});
		await waitUntil(
			"reuseport daemon stop",
			STOP_TIMEOUT_MS,
			() => !processIsAlive(ready.pid),
		);
	}
	if (!existsSync(join(root, "daemon-stopped.json"))) {
		fail("reuseport daemon exited without a timestamped stop record");
	}
}

async function main(): Promise<void> {
	const command = process.argv[2];
	if (!command || command === "--help" || command === "help") {
		process.stdout.write(
			"usage: bun tools/load/g6-c32-linux-smoke-probe.ts <fixed-source-port|daemon|bounded-probe|steering|bpf|stop> [options]\n",
		);
		return;
	}
	const root = ensureStateRoot(argument("state-root"));
	if (command === "fixed-source-port") {
		assertKnownArguments(command, ["state-root", "base", "count"]);
		await fixedSourcePort(
			root,
			requirePort(argument("base", String(DEFAULT_FIXED_PORT_BASE)), "base"),
			requirePositiveInteger(
				argument("count", String(DEFAULT_FIXED_PORT_COUNT)),
				"count",
			),
		);
	} else if (command === "daemon") {
		assertKnownArguments(command, ["state-root", "repository", "port"]);
		await daemon(
			root,
			requireRepository(resolve(argument("repository"))),
			requirePort(argument("port", String(DEFAULT_PORT)), "port"),
		);
	} else if (command === "bounded-probe") {
		assertKnownArguments(command, ["state-root", "repository", "bun", "role"]);
		const role = argument("role");
		if (role !== "server" && role !== "generator")
			fail("role must be server or generator");
		await boundedProbe(
			root,
			requireRepository(resolve(argument("repository"))),
			argument("bun"),
			role,
		);
	} else if (command === "steering") {
		assertKnownArguments(command, ["state-root"]);
		await steering(root);
	} else if (command === "bpf") {
		assertKnownArguments(command, ["state-root"]);
		bpf(root);
	} else if (command === "stop") {
		assertKnownArguments(command, ["state-root"]);
		await stop(root);
	} else {
		fail(`unknown command ${command}`);
	}
}

if (import.meta.main) {
	main().catch((error) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exit(1);
	});
}
