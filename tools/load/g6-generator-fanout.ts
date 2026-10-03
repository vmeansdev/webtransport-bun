/**
 * Several generator processes under ONE owned work process. The owned launch
 * (g6-c32-work-remote) records a single process group; this wrapper starts the
 * N mmo-client entry scripts inside it, one at a time (each waits for the
 * previous one's built binary, as the unowned path does), tags every output
 * line with its process index, and exits with the worst child status. The
 * conductor demultiplexes the tags back into N per-process streams.
 */
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough, type Readable } from "node:stream";

export const FANOUT_MAX_PROCESSES = 16;

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function ownedFanoutScript(
	argvs: readonly (readonly string[])[],
): string {
	if (argvs.length < 2 || argvs.length > FANOUT_MAX_PROCESSES)
		throw Error(`fan-out needs 2..${FANOUT_MAX_PROCESSES} generator processes`);
	const lines = ["set -u", "d=$(mktemp -d)", "trap 'rm -rf \"$d\"' EXIT"];
	argvs.forEach((argv, index) => {
		if (argv.length === 0) throw Error("empty generator argv");
		const cmd = argv.map(quote).join(" ");
		lines.push(
			`( set -o pipefail; ${cmd} 2> >(sed -u 's/^/@@E${index}@@ /' >&2) | tee "$d/o${index}" | sed -u 's/^/@@O${index}@@ /'; echo $? > "$d/rc${index}" ) &`,
			`until grep -q '^macgen: binary=' "$d/o${index}" 2>/dev/null || [ -e "$d/rc${index}" ]; do sleep 0.2; done`,
		);
	});
	lines.push(
		"wait",
		"rc=0",
		`for i in $(seq 0 ${argvs.length - 1}); do r=$(cat "$d/rc$i" 2>/dev/null || echo 255); [ "$r" -gt "$rc" ] && rc=$r; done`,
		'exit "$rc"',
	);
	return lines.join("\n");
}

export type FanoutClient = EventEmitter & {
	stdout: Readable;
	stderr: Readable;
};

const TAG = /^@@([OE])(\d+)@@ ?(.*)$/;

/** N virtual per-process clients fed from one owned fan-out process. */
export function demultiplexFanout(
	fanout: {
		stdout: Readable | null;
		stderr: Readable | null;
		once(
			event: "exit",
			listener: (code: number | null, signal: NodeJS.Signals | null) => void,
		): unknown;
	},
	count: number,
	untagged: (line: string) => void,
): FanoutClient[] {
	const clients = Array.from({ length: count }, () => {
		const client = new EventEmitter() as FanoutClient;
		client.stdout = new PassThrough();
		client.stderr = new PassThrough();
		return client;
	});
	const route = (line: string, from: "O" | "E") => {
		const match = TAG.exec(line);
		const index = match ? Number(match[2]) : -1;
		const client = clients[index];
		if (!match || client === undefined || match[1] !== from) {
			untagged(line);
			return;
		}
		((from === "O" ? client.stdout : client.stderr) as PassThrough).write(
			`${match[3]}\n`,
		);
	};
	let open = 0;
	const finished: Promise<void>[] = [];
	for (const [stream, from] of [
		[fanout.stdout, "O"],
		[fanout.stderr, "E"],
	] as const) {
		if (stream === null) continue;
		open += 1;
		finished.push(
			new Promise<void>((resolve) => {
				const reader = createInterface({ input: stream });
				reader.on("line", (line) => route(line, from));
				reader.once("close", () => resolve());
			}),
		);
	}
	fanout.once("exit", (code, signal) => {
		void Promise.all(finished).then(() => {
			for (const client of clients) {
				(client.stdout as PassThrough).end();
				(client.stderr as PassThrough).end();
				client.emit("exit", code, signal);
			}
		});
	});
	void open;
	return clients;
}
