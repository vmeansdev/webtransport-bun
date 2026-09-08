/**
 * Every read seam in the adapter tree, classified by a scan rather than by
 * hand.
 *
 * Every count this plan's ancestors stated about the read surface was wrong,
 * including the ones handed over by reviewers, because the surface was being
 * enumerated by eye. So it is not enumerated here either: `scanReadSeams`
 * parses the stated roots and finds every implementation of the inbound
 * operations, and the table below supplies each one's cell. A seam the scan
 * finds and the table does not carry fails; a row the scan does not find
 * fails; and a seam whose body starts or stops charging fails, because the
 * scan reads whether it charges out of the source and the cell has to agree.
 *
 * Four cells, and no fifth:
 *
 *  - **ingest** / **egress**: the seam opens its own span on the session's
 *    meter, so the turn is charged where it happens.
 *  - **charged-at-another-seam**: the seam does no transport read of its own;
 *    it stands in front of one. The row must name the span that charges the
 *    work *and* point at a measurement that shows that span charging it. The
 *    weak form of this cell -- naming a span that merely exists -- is what let
 *    the whole WebSocket consumer turn be filed as "already charged at
 *    `ws.ts:1865`" for two revisions, when `ws.ts:1865` charges the arrival
 *    turn and contains none of it.
 *  - **not-transport-work**: with a reason, and the reason has to be about
 *    this seam rather than about the difficulty of measuring it.
 *
 * No number appears in this file. There is no expected seam count, here or in
 * the acceptance criteria, because a count is the thing that kept being wrong.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeWireMessage, type WireMessage } from "../wire.ts";
import {
	type ServerWebSocketLike,
	type Session,
	systemTransportClock,
	type WebSocketServerRuntime,
	type WebSocketServerRuntimeOptions,
} from "./transport.ts";
import {
	encodeHandshakeFrame,
	encodeWebSocketFrame,
	WebSocketAdapter,
} from "./ws.ts";
import {
	createWebTransportAdapter,
	type FakeWtClientSession,
	type FakeWtServerSession,
	type WtServerFactory,
} from "./wt.ts";

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * The scan itself lives in `check-official-io.ts` -- see the note there. The
 * short version: a census written by hand is the defect it exists to cure, so
 * it must be derived from the source, and the audit's own test-import rule
 * refuses `typescript` from a `.test.ts` while `checkerTs` is pinned to
 * exactly one file. The roots it scans, the names it treats as read seams and
 * the markers it reads a charge from are stated there as
 * `READ_SEAM_SCAN_ROOTS`, `READ_SEAM_NAMES` and its charge markers. Widening
 * the roots is the only sanctioned way to change what this table must carry:
 * a seam added outside them escapes the scan silently, which is the failure
 * this mechanism exists to prevent.
 */

/**
 * The stated roots: the adapter tree, plus the one production decorator that
 * wraps a session from outside it. Widening this is the only sanctioned way to
 * change what the table below must contain -- a seam added outside these roots
 * escapes the scan silently, which is the failure this mechanism exists to
 * prevent, so a new decorator site belongs in a root before it belongs in a
 * campaign.
 */
const SCAN_ROOTS = [
	"tools/compare/adapters",
	"tools/compare/bin/compare-controller.ts",
] as const;

/** The inbound half of the transport interface: what a read seam is called. */
const READ_SEAM_NAMES = new Set([
	"read",
	"receiveMessage",
	"acceptUni",
	"acceptBidi",
	"acceptSession",
]);

/**
 * How the scan reads "this seam charges": the seam's own body opens or takes a
 * span on a `LoopBusyMeter`. A seam that hands its span to a helper still
 * opens it here, which is the discipline the read path follows -- the span
 * belongs to the seam and the helper only pauses it across the `await`.
 */
const CHARGE_MARKERS = [
	'.open("ingest"',
	'.open("egress"',
	'.measure("ingest"',
	'.measure("egress"',
	"openIngestSpan(",
] as const;

interface ScannedSeam {
	/** `<repo-relative file>#<chain of enclosing declarations>.<name>`. */
	readonly id: string;
	readonly file: string;
	readonly line: number;
	readonly charges: boolean;
}

interface Declaration {
	readonly name: string;
	readonly start: number;
	readonly bodyEnd: number;
}

/**
 * Why this reads the source instead of parsing it with the TypeScript
 * compiler: the official-I/O audit refuses `typescript` from a `.test.ts` and
 * from any production module -- the realpath-contained resolver rejects it --
 * and it refuses a test that reaches `check-official-io.ts`, which is the one
 * module exempted. So the scan is written here, small enough to read in one
 * sitting and pinned by the table it feeds.
 *
 * It is deliberately shape-blind about *what* a declaration means and precise
 * about *where* it ends: literals, comments and type bodies are masked first,
 * so no brace inside a string or an interface can move the nesting; a
 * declaration's body is then found by walking from its name to the first `{`
 * or statement terminator at paren depth zero; and a name only counts as a
 * seam if it has a body at all, which is what keeps the method *signatures* in
 * `transport.ts` out of the census. It was written against, and checked to
 * reproduce exactly, the seam set the TypeScript compiler's own AST produces
 * over the same roots -- same ids, same count, same charge verdicts.
 */
const DECLARATION =
	/^[ \t]*(?:(?:export|declare|public|private|protected|static|readonly|abstract)[ \t]+)*(?:(?:async|function|const|let|var)[ \t]+)*([A-Za-z_$][\w$]*)[ \t]*(?=[({:=])/gm;

/** A class opens a body without any of the punctuation above after its name. */
const CLASS_DECLARATION =
	/^[ \t]*(?:export[ \t]+)?(?:abstract[ \t]+)?class[ \t]+([A-Za-z_$][\w$]*)/gm;

/** Control-flow keywords that open a block and name nothing. */
const NOT_A_NAME = new Set([
	"return",
	"if",
	"else",
	"for",
	"while",
	"do",
	"switch",
	"case",
	"try",
	"catch",
	"finally",
	"throw",
	"new",
	"await",
	"yield",
	"typeof",
	"in",
	"of",
	"import",
	"export",
]);

function typeScriptFiles(path: string, out: string[] = []): string[] {
	if (statSync(path).isFile()) {
		if (path.endsWith(".ts") && !path.endsWith(".test.ts")) out.push(path);
		return out;
	}
	for (const entry of readdirSync(path).sort())
		typeScriptFiles(join(path, entry), out);
	return out;
}

/**
 * Blank out string, template and comment content, preserving every offset so
 * line numbers survive. A brace, a colon or a seam name inside a literal
 * cannot then be read as code -- which matters here, because this file's own
 * neighbours carry both in their prose.
 */
function maskLiterals(source: string): string {
	const out = source.split("");
	const blank = (from: number, to: number): void => {
		for (let at = from; at < to && at < out.length; at++)
			if (out[at] !== "\n") out[at] = " ";
	};
	let index = 0;
	while (index < source.length) {
		const character = source[index];
		const next = source[index + 1];
		if (character === "/" && next === "/") {
			const end = source.indexOf("\n", index);
			const stop = end === -1 ? source.length : end;
			blank(index, stop);
			index = stop;
			continue;
		}
		if (character === "/" && next === "*") {
			const end = source.indexOf("*/", index + 2);
			const stop = end === -1 ? source.length : end + 2;
			blank(index, stop);
			index = stop;
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			let at = index + 1;
			while (at < source.length) {
				if (source[at] === "\\") {
					at += 2;
					continue;
				}
				if (source[at] === character) break;
				at += 1;
			}
			blank(index + 1, at);
			index = Math.min(at + 1, source.length);
			continue;
		}
		index += 1;
	}
	return out.join("");
}

/**
 * Blank out interface and type-alias bodies. Their members are the same shape
 * as an object literal's and have no bodies to charge from; leaving them in
 * would put `transport.ts`'s own `read(deadlineMs): Promise<...>;` in the
 * census as a seam that charges nothing.
 */
function maskTypeBlocks(masked: string): string {
	const out = masked.split("");
	const pattern =
		/^[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?(?:interface|type)[ \t]+[A-Za-z_$][\w$]*/gm;
	for (;;) {
		const match = pattern.exec(masked);
		if (match === null) break;
		const open = masked.indexOf("{", (match.index ?? 0) + match[0].length);
		const semicolon = masked.indexOf(";", (match.index ?? 0) + match[0].length);
		if (open === -1 || (semicolon !== -1 && semicolon < open)) continue;
		const close = matchingBrace(masked, open);
		for (let at = open; at < close; at++) if (out[at] !== "\n") out[at] = " ";
	}
	return out.join("");
}

/** The offset of the `}` that closes the `{` at `open`. */
function matchingBrace(masked: string, open: number): number {
	let depth = 0;
	for (let at = open; at < masked.length; at++) {
		if (masked[at] === "{") depth += 1;
		else if (masked[at] === "}") {
			depth -= 1;
			if (depth === 0) return at + 1;
		}
	}
	return masked.length;
}

/**
 * Resolve one declaration's body: a block, an expression-bodied arrow, or
 * nothing at all (a method signature, a plain property).
 */
function bodyOf(
	masked: string,
	from: number,
	kind: "declaration" | "class",
): { bodyEnd: number } | undefined {
	let parens = 0;
	let sawArrow = false;
	for (let at = from; at < masked.length; at++) {
		const character = masked[at];
		if (character === "(" || character === "[") parens += 1;
		else if (character === ")" || character === "]") parens -= 1;
		else if (parens === 0 && character === "=" && masked[at + 1] === ">")
			sawArrow = true;
		else if (parens === 0 && character === "{") {
			// A `{` that a colon introduces is a type, not a body: the return
			// type of `makeMessageReceive` is an object type, and taking it for
			// the body would end the declaration before its first statement.
			let back = at - 1;
			while (back >= 0 && /\s/.test(masked[back] as string)) back -= 1;
			if (masked[back] === ":") {
				at = matchingBrace(masked, at) - 1;
				continue;
			}
			return { bodyEnd: matchingBrace(masked, at) };
		} else if (
			kind === "declaration" &&
			parens === 0 &&
			(character === ";" || character === ",")
		) {
			// An expression-bodied arrow is a body; a `(args) => Result` type
			// annotation is not, and the two are the same shape. What separates
			// them here is the terminator: an object-literal member ends with a
			// comma, an interface member with a semicolon.
			return sawArrow && character === "," ? { bodyEnd: at } : undefined;
		}
	}
	return undefined;
}

/** Every implementation of an inbound operation under the stated roots. */
function scanReadSeams(): readonly ScannedSeam[] {
	const seams: ScannedSeam[] = [];
	const files: string[] = [];
	for (const root of SCAN_ROOTS) typeScriptFiles(join(REPO_ROOT, root), files);
	for (const file of files.sort()) {
		const raw = readFileSync(file, "utf8");
		const masked = maskTypeBlocks(maskLiterals(raw));
		const declarations: Declaration[] = [];
		for (const [kind, pattern] of [
			["class", CLASS_DECLARATION],
			["declaration", DECLARATION],
		] as const) {
			pattern.lastIndex = 0;
			for (;;) {
				const match = pattern.exec(masked);
				if (match === null) break;
				const name = match[1] as string;
				if (NOT_A_NAME.has(name)) continue;
				const nameEnd = (match.index ?? 0) + match[0].length;
				const body = bodyOf(masked, nameEnd, kind);
				if (body === undefined) continue;
				declarations.push({
					name,
					start: match.index ?? 0,
					bodyEnd: body.bodyEnd,
				});
			}
		}
		declarations.sort((left, right) => left.start - right.start);
		const relativeFile = relative(REPO_ROOT, file);
		for (const declaration of declarations) {
			if (!READ_SEAM_NAMES.has(declaration.name)) continue;
			const enclosing = declarations
				.filter(
					(other) =>
						other !== declaration &&
						other.start < declaration.start &&
						other.bodyEnd > declaration.start,
				)
				.map((other) => other.name);
			const body = raw.slice(declaration.start, declaration.bodyEnd);
			seams.push({
				id: `${relativeFile}#${[...enclosing, declaration.name].join(".")}`,
				file: relativeFile,
				line: raw.slice(0, declaration.start).split("\n").length,
				charges: CHARGE_MARKERS.some((marker) => body.includes(marker)),
			});
		}
	}
	return seams;
}

// ---------------------------------------------------------------------------
// The measurements a charged-at-another-seam row has to point at
// ---------------------------------------------------------------------------

const far = (): number => systemTransportClock.nowMs() + 1_000_000;

type Listener = (...args: unknown[]) => void;

class CensusSocket implements ServerWebSocketLike {
	readonly listeners = new Map<string, Set<Listener>>();
	readonly remoteAddress = "10.99.0.1";
	readyState = 1 as const;
	data: { readonly role?: string } = {};
	send(data: string | ArrayBuffer | ArrayBufferView): number {
		return typeof data === "string" ? data.length : 1;
	}
	close(): void {}
	addEventListener(type: string, listener: EventListener): void {
		const set = this.listeners.get(type) ?? new Set<Listener>();
		set.add(listener as unknown as Listener);
		this.listeners.set(type, set);
	}
	removeEventListener(type: string, listener: EventListener): void {
		this.listeners.get(type)?.delete(listener as unknown as Listener);
	}
}

class CensusRuntime implements WebSocketServerRuntime {
	constructor(readonly options: WebSocketServerRuntimeOptions) {}
	stop(): void {}
	open(): CensusSocket {
		const socket = new CensusSocket();
		this.options.websocket.open?.(socket);
		return socket;
	}
	receive(socket: CensusSocket, data: Uint8Array): void {
		this.options.websocket.message(socket, data);
	}
}

async function openWsSession(): Promise<{
	readonly session: Session;
	readonly deliver: (frame: Uint8Array) => void;
}> {
	const holder: { current?: CensusRuntime } = {};
	const adapter = new WebSocketAdapter({
		clock: systemTransportClock,
		serverFactory: (options) => {
			const runtime = new CensusRuntime(options);
			holder.current = runtime;
			return runtime;
		},
	});
	const server = await adapter.startServer({
		port: 4433,
		role: "publisher",
		tls: { cert: "c", key: "k", serverName: "wt-compare.local" },
	});
	const runtime = holder.current;
	if (!runtime) throw new Error("no ws runtime");
	const socket = runtime.open();
	runtime.receive(socket, encodeHandshakeFrame("publisher"));
	const session = await server.acceptSession(far());
	return { session, deliver: (frame) => runtime.receive(socket, frame) };
}

function censusMessage(): WireMessage {
	return {
		runId: "run-1",
		sessionId: "session-1",
		sequence: 1,
		expiresAtMs: Number.MAX_SAFE_INTEGER,
		payload: Uint8Array.from([1, 2, 3, 4]),
	};
}

function wtNativeSession(
	datagrams: readonly Uint8Array[],
): FakeWtServerSession {
	let sent = 0;
	const payloads = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= 8) {
				controller.close();
				return;
			}
			sent += 1;
			controller.enqueue(new Uint8Array(4096));
		},
	});
	let handed = false;
	const uniStreams = new ReadableStream<ReadableStream<Uint8Array>>({
		pull(controller) {
			if (handed) {
				controller.close();
				return;
			}
			handed = true;
			controller.enqueue(payloads);
		},
	});
	return {
		id: "census-wt",
		peer: { ip: "10.99.0.1", port: 1 },
		has0Rtt: false,
		accepted0Rtt: false,
		handshakeConfirmed: true,
		ready: Promise.resolve(),
		closed: new Promise(() => {}),
		draining: new Promise(() => {}),
		close: () => {},
		drain: () => {},
		sendDatagram: async () => {},
		sendDatagramBatch: async (items: readonly Uint8Array[]) => ({
			sent: items.length,
		}),
		incomingDatagrams: async function* () {
			for (const datagram of datagrams) yield datagram;
		},
		incomingBidirectionalStreams: new ReadableStream({
			pull(controller) {
				controller.close();
			},
		}),
		incomingUnidirectionalStreams: uniStreams,
		createBidirectionalStream: async () => ({}),
		createUnidirectionalStream: async () => ({}),
		metricsSnapshot: () => ({}),
		goAway: () => {},
	} as unknown as FakeWtServerSession;
}

async function openWtSession(
	datagrams: readonly Uint8Array[] = [],
): Promise<Session> {
	const native = wtNativeSession(datagrams);
	const serverFactory: WtServerFactory = (options) =>
		({
			address: { host: "10.99.0.2", port: options.port ?? 4433 },
			congestionControl: "default",
			close: async () => {},
			metricsSnapshot: () => ({}),
			tlsSnapshot: () => ({ sni: [] }),
			goAway: () => {},
			onSession(cb: (s: FakeWtServerSession) => void) {
				cb(native);
			},
		}) as unknown as ReturnType<WtServerFactory>;
	const adapter = createWebTransportAdapter({
		serverFactory,
		clientFactory: async () => ({}) as unknown as FakeWtClientSession,
		clock: systemTransportClock,
	});
	const server = await adapter.startServer({
		port: 4433,
		tls: { cert: "c", key: "k" },
	});
	return await server.acceptSession(far());
}

/**
 * Each measurement drives the production seam the anchor sits in and returns
 * what that span charged. A cell-three row is only as good as the number one
 * of these produces: "the span exists" is the claim that validated a
 * falsehood for two revisions.
 */
const MEASUREMENTS: Record<string, () => Promise<number>> = {
	// Interleaved: the session's byte budget holds one record at a time, and
	// the point is to attribute the consumer turn anyway, one delivery at a
	// time, with the arrival turn subtracted.
	"ws-channel-read": async () => {
		const arm = await openWsSession();
		const busyMs = (): number => arm.session.snapshot().loopUtilization.busyMs;
		arm.deliver(encodeWebSocketFrame({ kind: "open-uni", channelId: 1 }));
		const channel = await arm.session.acceptUni(far());
		let charged = 0;
		for (let index = 0; index < 200; index++) {
			arm.deliver(
				encodeWebSocketFrame({
					kind: "channel-data",
					channelId: 1,
					payload: new Uint8Array(4096),
				}),
			);
			const delivered = busyMs();
			await channel.read(far());
			charged += busyMs() - delivered;
		}
		return charged;
	},
	"ws-session-receive": async () => {
		const arm = await openWsSession();
		const busyMs = (): number => arm.session.snapshot().loopUtilization.busyMs;
		let charged = 0;
		for (let index = 0; index < 200; index++) {
			arm.deliver(
				encodeWebSocketFrame({
					kind: "message",
					deliveryKind: "datagram",
					payload: encodeWireMessage(censusMessage()),
				}),
			);
			const delivered = busyMs();
			await arm.session.receiveMessage("datagram", far());
			charged += busyMs() - delivered;
		}
		return charged;
	},
	"wt-channel-read": async () => {
		const session = await openWtSession();
		const channel = await session.acceptUni(far());
		const opened = session.snapshot().loopUtilization.busyMs;
		for (;;) {
			const chunk = await channel.read(far());
			if (chunk === null) break;
		}
		return session.snapshot().loopUtilization.busyMs - opened;
	},
	"wt-ingest-pump": async () => {
		const datagrams = Array.from({ length: 50 }, () =>
			encodeWireMessage(censusMessage()),
		);
		const session = await openWtSession(datagrams);
		const opened = session.snapshot().loopUtilization.busyMs;
		for (let index = 0; index < datagrams.length; index++)
			await session.receiveMessage("datagram", far());
		return session.snapshot().loopUtilization.busyMs - opened;
	},
};

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

type SeamCell =
	| { readonly cell: "ingest" }
	| { readonly cell: "egress" }
	| {
			readonly cell: "charged-at-another-seam";
			/** The file the charging span is written in. */
			readonly spanFile: string;
			/** Source text of the span's own construction, found in that file. */
			readonly spanAnchor: string;
			/** A measurement that shows that span charging this work. */
			readonly measurement: keyof typeof MEASUREMENTS;
	  }
	| { readonly cell: "not-transport-work"; readonly reason: string };

type SeamRow = SeamCell & { readonly id: string };

/** The base WS channel read every WS-wire decorator ultimately stands on. */
const WS_CHANNEL_READ = {
	cell: "charged-at-another-seam",
	spanFile: "tools/compare/adapters/ws.ts",
	spanAnchor: "const span = this.session.openIngestSpan();",
	measurement: "ws-channel-read",
} as const;

const WS_SESSION_RECEIVE = {
	cell: "charged-at-another-seam",
	spanFile: "tools/compare/adapters/ws.ts",
	spanAnchor:
		"return await this.receiveMessageCharged(span, kind, deadlineMs);",
	measurement: "ws-session-receive",
} as const;

const WS_SESSION_ACCEPT = {
	cell: "charged-at-another-seam",
	spanFile: "tools/compare/adapters/ws.ts",
	spanAnchor: '"uni stream accept deadline expired",\n\t\t\t\tspan,',
	measurement: "ws-channel-read",
} as const;

const WT_CHANNEL_READ = {
	cell: "charged-at-another-seam",
	spanFile: "tools/compare/adapters/wt.ts",
	spanAnchor: "return await readChunk(readable, deadlineMs, clock, span);",
	measurement: "wt-channel-read",
} as const;

const WT_INGEST_PUMP = {
	cell: "charged-at-another-seam",
	spanFile: "tools/compare/adapters/wt.ts",
	spanAnchor: 'busy.open("ingest", envelope !== null)',
	measurement: "wt-ingest-pump",
} as const;

const CENSUS: readonly SeamRow[] = [
	// -- WebSocket, the wire itself -------------------------------------------
	{
		id: "tools/compare/adapters/ws.ts#WsSession.receiveMessage",
		cell: "ingest",
	},
	{ id: "tools/compare/adapters/ws.ts#WsSession.acceptUni", cell: "ingest" },
	{ id: "tools/compare/adapters/ws.ts#WsSession.acceptBidi", cell: "ingest" },
	{ id: "tools/compare/adapters/ws.ts#WsChannel.read", cell: "ingest" },
	{
		id: "tools/compare/adapters/ws.ts#WsServerHandle.acceptSession",
		cell: "not-transport-work",
		reason:
			"The server handle's accept is the listener's admission hand-off, not " +
			"one session's transport work: it belongs to no session until it " +
			"returns one, and charging its turn to whichever session came out " +
			"would put the listener's own loop inside that session's busyMs. It " +
			"is the one caller of `waitForQueue` with no meter behind it, which " +
			"is why item C's charge sits at the call sites and not inside it.",
	},

	// -- WebTransport, the wire itself ----------------------------------------
	{
		id: "tools/compare/adapters/wt.ts#makeReceiveChannel.read",
		cell: "ingest",
	},
	{ id: "tools/compare/adapters/wt.ts#makeBidiChannel.read", cell: "ingest" },
	{
		id: "tools/compare/adapters/wt.ts#makeMessageReceive.receiveMessage",
		...WT_INGEST_PUMP,
	},
	{
		id: "tools/compare/adapters/wt.ts#wrapServerSession.session.acceptUni",
		cell: "ingest",
	},
	{
		id: "tools/compare/adapters/wt.ts#wrapServerSession.session.acceptBidi",
		cell: "ingest",
	},
	{
		id: "tools/compare/adapters/wt.ts#wrapServerSession.session.acceptBidi.read",
		cell: "ingest",
	},
	{
		id: "tools/compare/adapters/wt.ts#wrapClientSession.session.acceptUni",
		cell: "ingest",
	},
	{
		id: "tools/compare/adapters/wt.ts#wrapClientSession.session.acceptBidi",
		cell: "ingest",
	},
	{
		id: "tools/compare/adapters/wt.ts#wrapServerHandle.acceptSession",
		cell: "not-transport-work",
		reason:
			"The WebTransport twin of the WebSocket server handle's accept, and " +
			"not transport work for the same reason: the session's meter opens " +
			"when the session is wrapped, and this turn is the listener's.",
	},

	// -- The two off-loop read-path arms --------------------------------------
	// Their reads run on this loop -- `ws-worker.ts` says in its own words that
	// there is no worker thread -- and the transport read itself happens at the
	// base seam, which is what these arms now publish. What is left here is a
	// hand-off between two scheduling units in one process.
	{
		id: "tools/compare/adapters/ws-worker.ts#wrapSession.ensureMessagePump.read",
		...WS_SESSION_RECEIVE,
	},
	{
		id: "tools/compare/adapters/ws-worker.ts#wrapSession.wrapReceive.ensureChannelPump.read",
		...WS_CHANNEL_READ,
	},
	{
		id: "tools/compare/adapters/ws-worker.ts#wrapSession.wrapReceive.read",
		...WS_CHANNEL_READ,
	},
	{
		id: "tools/compare/adapters/ws-worker.ts#wrapSession.wrapBidi.read",
		...WS_CHANNEL_READ,
	},
	{
		id: "tools/compare/adapters/ws-worker.ts#wrapSession.receiveMessage",
		...WS_SESSION_RECEIVE,
	},
	{
		id: "tools/compare/adapters/ws-worker.ts#wrapSession.acceptUni",
		...WS_SESSION_ACCEPT,
	},
	{
		id: "tools/compare/adapters/ws-worker.ts#wrapSession.acceptBidi",
		...WS_SESSION_ACCEPT,
	},
	{
		id: "tools/compare/adapters/wt-stream-sink.ts#wrapSession.ensureMessagePump.read",
		...WT_INGEST_PUMP,
	},
	{
		id: "tools/compare/adapters/wt-stream-sink.ts#wrapSession.wrapReceive.ensureChannelPump.read",
		...WT_CHANNEL_READ,
	},
	{
		id: "tools/compare/adapters/wt-stream-sink.ts#wrapSession.wrapReceive.read",
		...WT_CHANNEL_READ,
	},
	{
		id: "tools/compare/adapters/wt-stream-sink.ts#wrapSession.wrapBidi.read",
		...WT_CHANNEL_READ,
	},
	{
		id: "tools/compare/adapters/wt-stream-sink.ts#wrapSession.receiveMessage",
		...WT_INGEST_PUMP,
	},
	{
		id: "tools/compare/adapters/wt-stream-sink.ts#wrapSession.acceptUni",
		...WT_CHANNEL_READ,
	},
	{
		id: "tools/compare/adapters/wt-stream-sink.ts#wrapSession.acceptBidi",
		...WT_CHANNEL_READ,
	},

	// -- The impairment overlay, outside the adapter tree ---------------------
	{
		id: "tools/compare/bin/compare-controller.ts#createLossyOverlayWsAdapter.wrapSession.receiveMessage",
		...WS_SESSION_RECEIVE,
	},
	{
		id: "tools/compare/bin/compare-controller.ts#createLossyOverlayWsAdapter.wrapSession.acceptUni",
		...WS_SESSION_ACCEPT,
	},
	{
		id: "tools/compare/bin/compare-controller.ts#createLossyOverlayWsAdapter.wrapSession.acceptBidi",
		...WS_SESSION_ACCEPT,
	},
];

// ---------------------------------------------------------------------------
// The three tests
// ---------------------------------------------------------------------------

describe("the read-seam census is derived, not written", () => {
	test("every scanned seam has a row and every row names a scanned seam", () => {
		const scanned = scanReadSeams();
		expect(scanned.length).toBeGreaterThan(0);
		const scannedIds = new Set(scanned.map((seam) => seam.id));
		const rowIds = new Set(CENSUS.map((row) => row.id));
		expect(rowIds.size).toBe(CENSUS.length);
		const missing = [...scannedIds].filter((id) => !rowIds.has(id)).sort();
		const orphaned = [...rowIds].filter((id) => !scannedIds.has(id)).sort();
		expect({ missing, orphaned }).toEqual({ missing: [], orphaned: [] });
	});

	test("a seam charges if and only if its cell says it does", () => {
		const byId = new Map(scanReadSeams().map((seam) => [seam.id, seam]));
		const disagreements: string[] = [];
		for (const row of CENSUS) {
			const seam = byId.get(row.id);
			if (seam === undefined) continue;
			const shouldCharge = row.cell === "ingest" || row.cell === "egress";
			if (seam.charges !== shouldCharge)
				disagreements.push(
					`${row.id} (${seam.file}:${seam.line}) is filed as ${row.cell} but ` +
						`${seam.charges ? "opens" : "opens no"} span`,
				);
		}
		expect(disagreements).toEqual([]);
	});

	test("every charged-at-another-seam row names a span that is measured to charge it", async () => {
		const rows = CENSUS.filter(
			(row): row is Extract<SeamRow, { cell: "charged-at-another-seam" }> =>
				row.cell === "charged-at-another-seam",
		);
		expect(rows.length).toBeGreaterThan(0);
		// The span exists...
		for (const row of rows) {
			const source = readFileSync(join(REPO_ROOT, row.spanFile), "utf8");
			expect({ id: row.id, found: source.includes(row.spanAnchor) }).toEqual({
				id: row.id,
				found: true,
			});
		}
		// ...and, which is the half that was missing, it charges. Each distinct
		// measurement is driven once against production and must produce a
		// positive charge; a named span that charges nothing is the falsehood
		// this cell used to be able to state.
		const used = [...new Set(rows.map((row) => row.measurement))].sort();
		const charged: Record<string, number> = {};
		for (const name of used) {
			const measure = MEASUREMENTS[name];
			if (measure === undefined) throw new Error(`no measurement ${name}`);
			charged[name] = await measure();
		}
		for (const name of used)
			expect({ name, positive: (charged[name] ?? 0) > 0 }).toEqual({
				name,
				positive: true,
			});
	}, 30_000);

	test("every row that is not-transport-work states a reason", () => {
		const rows = CENSUS.filter(
			(row): row is Extract<SeamRow, { cell: "not-transport-work" }> =>
				row.cell === "not-transport-work",
		);
		for (const row of rows) expect(row.reason.length).toBeGreaterThan(40);
	});
});
