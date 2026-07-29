import { createServer } from "../../src/index.js";
import { connectWithRetry, nextPort } from "../helpers/network.js";

type ProbeMode = "expect-stall" | "expect-production-noop";

type ProbeResult = {
	mode: ProbeMode;
	closeOutcome: "rejected" | "resolved";
	closeElapsedMs: number;
	preCloseStreamTasksActive: number;
	preCloseSessionTasksActive: number;
	errorMessage?: string;
	postClose?: {
		sessionsActive: number;
		sessionTasksActive: number;
		streamTasksActive: number;
	};
};

function parseMode(): ProbeMode {
	const mode = process.argv[2];
	if (mode === "expect-stall" || mode === "expect-production-noop") {
		return mode;
	}
	throw new Error(`unknown probe mode: ${mode ?? "<missing>"}`);
}

async function main() {
	const mode = parseMode();
	const port = nextPort(16500, 300);
	const server = createServer({
		port,
		tls: { certPem: "", keyPem: "" },
		onSession: () => {},
	});
	let client: Awaited<ReturnType<typeof connectWithRetry>> | undefined;

	try {
		client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});

		const preClose = server.metricsSnapshot();
		if (preClose.streamTasksActive <= 0) {
			throw new Error(
				`expected streamTasksActive > 0 before close, got ${preClose.streamTasksActive}`,
			);
		}

		const closeResult = await Promise.race([
			(async () => {
				const closeStart = Date.now();
				return server
					.close()
					.then(() => ({
						ok: true as const,
						closeElapsedMs: Date.now() - closeStart,
					}))
					.catch((error) => ({
						ok: false as const,
						error,
						closeElapsedMs: Date.now() - closeStart,
					}));
			})(),
			Bun.sleep(8000).then(() => ({ timedOut: true as const })),
		]);

		if ("timedOut" in closeResult) {
			throw new Error("close probe timed out");
		}

		const baseResult = {
			mode,
			closeElapsedMs: closeResult.closeElapsedMs,
			preCloseStreamTasksActive: preClose.streamTasksActive,
			preCloseSessionTasksActive: preClose.sessionTasksActive,
		};

		if (mode === "expect-stall") {
			if (!closeResult.ok) {
				const errorMessage = String(closeResult.error);
				if (!/E_BACKPRESSURE_TIMEOUT/.test(errorMessage)) {
					throw new Error(
						`expected E_BACKPRESSURE_TIMEOUT from seam close, got: ${errorMessage}`,
					);
				}
				if (!/abortedTasks=[1-9]\\d*/.test(errorMessage)) {
					throw new Error(
						`expected abortedTasks>0 in seam close error, got: ${errorMessage}`,
					);
				}
				const result: ProbeResult = {
					...baseResult,
					closeOutcome: "rejected",
					errorMessage,
				};
				console.log(`STALL_PROBE_RESULT=${JSON.stringify(result)}`);
				return;
			}

			const postClose = server.metricsSnapshot();
			if (
				postClose.sessionsActive !== 0 ||
				postClose.sessionTasksActive !== 0 ||
				postClose.streamTasksActive !== 0
			) {
				throw new Error(
					`expected seam-enabled close cleanup to reach zero metrics, got ${JSON.stringify(postClose)}`,
				);
			}
			if (closeResult.closeElapsedMs < 4500) {
				throw new Error(
					`expected seam-enabled close to exercise grace/abort path, got ${closeResult.closeElapsedMs}ms`,
				);
			}
			const result: ProbeResult = {
				...baseResult,
				closeOutcome: "resolved",
				postClose: {
					sessionsActive: postClose.sessionsActive,
					sessionTasksActive: postClose.sessionTasksActive,
					streamTasksActive: postClose.streamTasksActive,
				},
			};
			console.log(`STALL_PROBE_RESULT=${JSON.stringify(result)}`);
			return;
		}

		if (!closeResult.ok) {
			throw new Error(
				`expected production close to ignore stall env, got: ${String(closeResult.error)}`,
			);
		}
		if (closeResult.closeElapsedMs >= 4500) {
			throw new Error(
				`expected production close to avoid seam grace/abort path, got ${closeResult.closeElapsedMs}ms`,
			);
		}
		const postClose = server.metricsSnapshot();
		if (
			postClose.sessionsActive !== 0 ||
			postClose.sessionTasksActive !== 0 ||
			postClose.streamTasksActive !== 0
		) {
			throw new Error(
				`expected zeroed metrics after production close, got ${JSON.stringify(postClose)}`,
			);
		}
		const result: ProbeResult = {
			...baseResult,
			closeOutcome: "resolved",
			postClose: {
				sessionsActive: postClose.sessionsActive,
				sessionTasksActive: postClose.sessionTasksActive,
				streamTasksActive: postClose.streamTasksActive,
			},
		};
		console.log(`STALL_PROBE_RESULT=${JSON.stringify(result)}`);
	} finally {
		try {
			client?.close();
		} catch {
			// Best-effort probe cleanup only.
		}
		try {
			await server.close();
		} catch {
			// Seam probe intentionally leaves forced-stall tasks behind until process exit.
		}
	}
}

await main();
