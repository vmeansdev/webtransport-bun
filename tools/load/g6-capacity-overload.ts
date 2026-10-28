/** Isolated native overload proof. Never probes or kills unrelated listeners. */
import { fileURLToPath } from "node:url";
import {
	__TESTING__,
	connect,
	createServer,
	DEFAULT_LIMITS,
	E_BACKPRESSURE_TIMEOUT,
	E_LIMIT_EXCEEDED,
	type ServerSession,
} from "../../packages/webtransport/src/index.js";

const THIS_FILE = fileURLToPath(import.meta.url);
const PAYLOAD = new Uint8Array(512).fill(0x61);
// Test-only small budgets make pressure deterministic. Defaults are not raised.
const LIMITS = {
	maxSessions: 1,
	maxQueuedBytesGlobal: 512,
	maxQueuedBytesPerSession: 512,
	backpressureTimeoutMs: 120,
} as const;

export function isStableNativeError(error: unknown, expected: string): boolean {
	return (
		error instanceof Error &&
		((error as Error & { code?: string }).code === expected ||
			error.message === expected ||
			error.message.startsWith(`${expected}:`))
	);
}
async function bounded<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(Error(`proof deadline: ${label}`)), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
async function waitUntil(
	predicate: () => boolean,
	ms: number,
	label: string,
): Promise<void> {
	const until = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() >= until) throw Error(`proof deadline: ${label}`);
		await Bun.sleep(10);
	}
}
async function holdClientMain(url: string): Promise<void> {
	const client = await bounded(
		connect(url, { tls: { insecureSkipVerify: true } }),
		5000,
		"owned client connect",
	);
	try {
		await bounded(
			client.sendDatagram(PAYLOAD),
			2000,
			"fill server receive budget",
		);
		console.log(JSON.stringify({ sentCount: 1, bytes: PAYLOAD.byteLength }));
		await bounded(client.closed, 15000, "owned server close");
	} finally {
		client.close();
	}
}

export async function runBoundedOverloadProof() {
	let accept: (session: ServerSession) => void = () => {
		throw Error("accept resolver not initialized");
	};
	const accepted = new Promise<ServerSession>((resolve) => {
		accept = resolve;
	});
	const server = createServer({
		port: 0,
		tls: { certPem: "", keyPem: "" },
		limits: LIMITS,
		onSession: accept,
	});
	const port = server.address.port;
	let child: ReturnType<typeof Bun.spawn> | undefined;
	let closed = false;
	try {
		if (!Number.isSafeInteger(port) || port < 1)
			throw Error("owned ephemeral listener was not bound");
		const internals = __TESTING__.serverInternals(server);
		if (typeof internals.__sendPathDiagnostics !== "function")
			throw Error("native diagnostic readout seam is missing");
		const diagnostics = JSON.parse(internals.__sendPathDiagnostics());
		if (diagnostics.enabled !== false)
			throw Error("diagnostics must be off in the default overload fixture");
		const ownedClient = Bun.spawn(
			[
				process.execPath,
				THIS_FILE,
				"--hold-client",
				`https://127.0.0.1:${port}`,
			],
			{
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env },
			},
		);
		child = ownedClient;
		const stdout = new Response(ownedClient.stdout).text(),
			stderr = new Response(ownedClient.stderr).text();
		const session = await bounded(
			accepted,
			5000,
			"first native session accepted",
		);
		let limitExceededError: string | null = null;
		try {
			const extra = await bounded(
				connect(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				}),
				2500,
				"session admission rejection",
			);
			extra.close();
			throw Error("over-capacity session unexpectedly admitted");
		} catch (error) {
			if (!isStableNativeError(error, E_LIMIT_EXCEEDED)) throw error;
			limitExceededError = E_LIMIT_EXCEEDED;
		}
		await waitUntil(
			() =>
				server.metricsSnapshot().queuedBytesGlobal ===
				LIMITS.maxQueuedBytesGlobal,
			3000,
			"exact receive budget filled",
		);
		const before = server.metricsSnapshot();
		let backpressureSendError: string | null = null;
		try {
			await bounded(
				session.sendDatagram(new Uint8Array([0x99])),
				2000,
				"native send backpressure timeout",
			);
			throw Error("send unexpectedly bypassed a full byte budget");
		} catch (error) {
			if (!isStableNativeError(error, E_BACKPRESSURE_TIMEOUT)) throw error;
			backpressureSendError = E_BACKPRESSURE_TIMEOUT;
		}
		const after = server.metricsSnapshot();
		if (
			after.backpressureWaitCount <= before.backpressureWaitCount ||
			after.backpressureTimeoutCount <= before.backpressureTimeoutCount
		)
			throw Error("native wait and timeout counters did not increase");
		if (after.queuedBytesGlobal !== LIMITS.maxQueuedBytesGlobal)
			throw Error("timed-out send changed the full receive reservation");
		await bounded(server.close(), 3000, "native server teardown");
		closed = true;
		const holdClientExitCode = await bounded(
			child.exited,
			3000,
			"owned client exit",
		);
		const [out, err] = await bounded(
			Promise.all([stdout, stderr]),
			1000,
			"owned client output EOF",
		);
		if (holdClientExitCode !== 0) throw Error(`owned client failed: ${err}`);
		const report = JSON.parse(out);
		if (report.sentCount !== 1 || report.bytes !== PAYLOAD.byteLength)
			throw Error("owned client did not execute the input");
		await waitUntil(
			() => {
				const m = server.metricsSnapshot();
				return (
					m.queuedBytesGlobal === 0 &&
					m.sessionsActive === 0 &&
					m.sessionTasksActive === 0 &&
					m.streamTasksActive === 0
				);
			},
			2000,
			"queue and task gauges return to baseline",
		);
		const final = server.metricsSnapshot();
		return {
			source: {
				defaults: {
					maxQueuedBytesPerSession: DEFAULT_LIMITS.maxQueuedBytesPerSession,
					maxQueuedBytesGlobal: DEFAULT_LIMITS.maxQueuedBytesGlobal,
				},
				diagnostics: {
					mode: "runtime-default-off" as const,
					enabled: diagnostics.enabled as false,
					note: "Native diagnostic readout confirms off. Test-only 512-byte budgets exercise bounded pressure; exported production defaults remain unchanged. Not Linux capacity evidence.",
				},
			},
			runtime: {
				port,
				sessionLimit: LIMITS.maxSessions,
				heldSessionKind: "child-handle" as const,
				limitExceededError,
				backpressureSendError,
				limitExceededCount: after.limitExceededCount,
				backpressureWaitCount:
					after.backpressureWaitCount - before.backpressureWaitCount,
				backpressureTimeoutCount:
					after.backpressureTimeoutCount - before.backpressureTimeoutCount,
				queuedBytesGlobalPeak: Math.max(
					before.queuedBytesGlobal,
					after.queuedBytesGlobal,
				),
				queuedBytesGlobalLimit: LIMITS.maxQueuedBytesGlobal,
				queuedBytesGlobalAfterClose: final.queuedBytesGlobal,
				sessionsActiveAfterClose: final.sessionsActive,
				sessionTasksActiveAfterClose: final.sessionTasksActive,
				streamTasksActiveAfterClose: final.streamTasksActive,
				holdClientExitCode,
			},
		};
	} finally {
		try {
			if (!closed)
				await bounded(server.close(), 3000, "failure server cleanup");
		} finally {
			if (child && child.exitCode === null) {
				child.kill("SIGTERM");
				try {
					await bounded(child.exited, 500, "client TERM join");
				} catch {
					child.kill("SIGKILL");
					await bounded(child.exited, 1000, "client KILL join");
				}
			}
		}
	}
}

if (import.meta.main) {
	const run = process.argv.includes("--hold-client")
		? holdClientMain(process.argv.at(-1) ?? "")
		: runBoundedOverloadProof().then((report) => {
				console.log(JSON.stringify(report, null, 2));
			});
	void run.catch((error: unknown) => {
		console.error(error);
		process.exitCode = 1;
	});
}
