import {
	requireDefined,
	validateRfc3339Millis,
} from "./g6-c32-freeze-model.ts";
import { startOwnedCommand } from "./g6-c32-operation.ts";

/** Only signal the process group this invocation created, never the controller group. */
export async function runWorkBoundedCommand(
	argv: readonly string[],
	until: string,
): Promise<number> {
	const monotonicStart = process.hrtime.bigint();
	const remaining =
		Date.parse(validateRfc3339Millis(until, "operation cutoff")) - Date.now();
	if (remaining <= 0) return 124;
	if (!argv[0] || remaining > 24 * 60 * 60 * 1000)
		throw Error("invalid bounded command or cutoff");
	const deadlineMonotonicNs = monotonicStart + BigInt(remaining) * 1_000_000n;
	const controller = new AbortController();
	const abort = () => controller.abort();
	for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
		process.on(name, abort);
	try {
		const environment: Record<string, string> = {};
		for (const [name, value] of Object.entries(process.env))
			if (value !== undefined) environment[name] = value;
		const result = await startOwnedCommand(
			{
				operationId: "bounded-work-command",
				phase: "WORK",
				command: requireDefined(argv[0]),
				args: argv.slice(1),
				cwd: ".",
				env: environment,
				stdin: "ignore",
				timeoutMs: remaining,
			},
			process.cwd(),
			controller.signal,
			{
				deadlineMonotonicNs,
				forwardOutput: {
					stdout: process.stdout,
					stderr: process.stderr,
					inheritStdin: true,
				},
			},
		).result;
		if (result.status.outcome === "TIMED_OUT") return 124;
		if (result.status.outcome === "CANCELLED") return 143;
		return result.status.outcome === "SUCCEEDED"
			? 0
			: (result.status.exitCode ?? 1);
	} finally {
		// Repeated signals remain latched until ownership and forwarding settle.
		for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
			process.removeListener(name, abort);
	}
}
if (import.meta.main) {
	try {
		const [until, separator, ...argv] = process.argv.slice(2);
		if (!until || separator !== "--")
			throw Error("usage: cutoff -- command [args]");
		// A blocked inherited sink must not keep the CLI alive after its cutoff.
		// Successful return already requires all forwarded write callbacks.
		process.exit(await runWorkBoundedCommand(argv, until));
	} catch (error) {
		console.error(String(error));
		process.exitCode = 1;
	}
}
