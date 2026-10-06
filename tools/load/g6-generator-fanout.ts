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
		lines.push(`${taggedPipeline(index, argv)} &`, untilBuilt(index));
	});
	lines.push(
		"wait",
		"rc=0",
		`for i in $(seq 0 ${argvs.length - 1}); do r=$(cat "$d/rc$i" 2>/dev/null || echo 255); [ "$r" -gt "$rc" ] && rc=$r; done`,
		'exit "$rc"',
	);
	return lines.join("\n");
}

/**
 * Tag every line of one stream and write it whole. All N taggers share the
 * fan-out's stdout (and stderr) pipe, and a line longer than PIPE_BUF is not
 * written atomically: the realm processes print their final reports (hundreds
 * of KB each) at the same barrier-aligned instant, and per-line `sed -u`
 * writes interleaved them into an unparseable report (VM rehearsal,
 * 2026-10-06). The taggers therefore hold one exclusive lock per stream for
 * each whole line. perl is in every Linux base image and on macOS.
 */
function tagger(tag: string, stream: "out" | "err"): string {
	return `G6_FANOUT_LOCK="$d/${stream}.lock" perl -ne 'BEGIN { $| = 1; open(L, ">>", $ENV{G6_FANOUT_LOCK}) or die "fan-out lock: $!" } flock(L, 2); print q{${tag} }, $_; flock(L, 8)'`;
}

function taggedPipeline(index: number, argv: readonly string[]): string {
	if (argv.length === 0) throw Error("empty generator argv");
	const cmd = argv.map(quote).join(" ");
	return `( set -o pipefail; ${cmd} 2> >(${tagger(`@@E${index}@@`, "err")} >&2) | tee "$d/o${index}" | ${tagger(`@@O${index}@@`, "out")}; echo $? > "$d/rc${index}" )`;
}

function untilBuilt(index: number): string {
	return `until grep -q '^macgen: binary=' "$d/o${index}" 2>/dev/null || [ -e "$d/rc${index}" ]; do sleep 0.2; done`;
}

/**
 * The sharded arms' generator fan-out: ONE owned process group (the owner
 * file is written once per cell) that first runs the generator-loopback
 * pre-checks — the forwarder (g6-server on 127.0.0.1), the V-F floor and,
 * in hotspot cells, the V-S sink — and only then starts the main processes
 * exactly as {@link ownedFanoutScript} does. Main processes are tagged
 * 0..M-1; the pre-check processes M (forwarder), M+1 (floor), M+2 (sink
 * subscriber), M+3 (sink publisher). The exit status is the worst MAIN
 * status: the forwarder is stopped by signal on purpose, and a failed
 * pre-check is evidence for the grader (its tagged `precheck: rc=` line),
 * not a reason to abort the cell.
 */
export function armsFanoutScript(input: {
	main: readonly (readonly string[])[];
	precheck: {
		dir: string;
		readyPath: string;
		certPath: string;
		keyPath: string;
		forwarder: readonly string[];
		floor: readonly string[];
		sink: {
			subscriber: readonly string[];
			publisher: readonly string[];
		} | null;
	};
}): string {
	const m = input.main.length;
	const pre = input.precheck;
	if (m < 1 || m + 4 > FANOUT_MAX_PROCESSES)
		throw Error(
			`arms fan-out needs 1..${FANOUT_MAX_PROCESSES - 4} main processes`,
		);
	if (!/^\/tmp\/g6-arms-precheck-[A-Za-z0-9._-]+$/.test(pre.dir))
		throw Error("arms pre-check dir must be /tmp/g6-arms-precheck-<id>");
	const [fw, floor, sub, pub] = [m, m + 1, m + 2, m + 3];
	const lines = [
		"set -u",
		"d=$(mktemp -d)",
		`pre=${quote(pre.dir)}`,
		`trap 'rm -rf "$d" "$pre"' EXIT`,
		'mkdir -p "$pre"',
		`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 2 -nodes -keyout ${quote(pre.keyPath)} -out ${quote(pre.certPath)} -subj /CN=localhost -addext 'subjectAltName = DNS:localhost,IP:127.0.0.1' >/dev/null 2>&1 || echo "@@E${fw}@@ precheck: certificate generation failed" >&2`,
		`${taggedPipeline(fw, pre.forwarder)} &`,
		`until [ -e ${quote(pre.readyPath)} ] || [ -e "$d/rc${fw}" ]; do sleep 0.2; done`,
		taggedPipeline(floor, pre.floor),
	];
	if (pre.sink !== null) {
		lines.push(
			`${taggedPipeline(sub, pre.sink.subscriber)} &`,
			"sinksub=$!",
			untilBuilt(sub),
			taggedPipeline(pub, pre.sink.publisher),
			'wait "$sinksub"',
		);
	}
	// Our own session only (setsid / ssh): never another host process.
	lines.push(
		"pkill -TERM -s 0 -x g6-server 2>/dev/null || true",
		"wait",
		`for i in ${[fw, floor, ...(pre.sink === null ? [] : [sub, pub])].join(" ")}; do echo "@@O$i@@ precheck: rc=$(cat "$d/rc$i" 2>/dev/null || echo 255)"; done`,
	);
	input.main.forEach((argv, index) => {
		lines.push(`${taggedPipeline(index, argv)} &`, untilBuilt(index));
	});
	lines.push(
		"wait",
		"rc=0",
		`for i in $(seq 0 ${m - 1}); do r=$(cat "$d/rc$i" 2>/dev/null || echo 255); [ "$r" -gt "$rc" ] && rc=$r; done`,
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
