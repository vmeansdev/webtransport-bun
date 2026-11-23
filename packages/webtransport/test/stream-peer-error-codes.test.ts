import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Duplex } from "node:stream";
import { peerStreamErrorCode } from "../src/errors.js";
import {
	connect,
	createServer,
	E_STOP_SENDING,
	E_STREAM_RESET,
	WebTransportError,
	WT_RESET,
	WT_STOP_SENDING,
} from "../src/index.js";
import { RecvStream } from "../src/streams.js";
import { type GeneratedCert, generateCertForNames } from "./helpers/certs.js";
import { openWTWithRetry } from "./helpers/network.js";

// A peer's RESET_STREAM / STOP_SENDING carries an application error code. The
// receiving side must see it on WebTransportError.streamErrorCode, on every
// native surface, as the wasm backend already reports it.

type ServerSession = Parameters<
	NonNullable<Parameters<typeof createServer>[0]["onSession"]>
>[0];

const WAIT_MS = 5000;
const INSECURE = { tls: { insecureSkipVerify: true } } as const;

let cert: GeneratedCert | null;
beforeAll(() => {
	cert = generateCertForNames(["localhost", "127.0.0.1"]);
});
afterAll(() => cert?.cleanup());

function within<T>(promise: Promise<T>, label: string): Promise<T> {
	return Promise.race([
		promise,
		Bun.sleep(WAIT_MS).then(() => {
			throw new Error(`timed out: ${label}`);
		}),
	]);
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

async function withServer(
	onSession: (session: ServerSession) => Promise<void>,
	body: (url: string) => Promise<void>,
): Promise<void> {
	if (!cert) throw new Error("certificate generation failed");
	const server = createServer({
		port: 0,
		host: "127.0.0.1",
		tls: { certPem: cert.certPem, keyPem: cert.keyPem },
		onSession: (session) => {
			void onSession(session).catch(() => {});
		},
	});
	try {
		await body(`https://127.0.0.1:${server.address.port}/`);
	} finally {
		await server.close();
	}
}

async function acceptBidi(session: ServerSession) {
	const reader = session.incomingBidirectionalStreams.getReader();
	const next = await within(reader.read(), "server accept bidi");
	reader.releaseLock();
	if (next.done) throw new Error("no incoming bidi stream");
	return next.value;
}

async function readUntilError(reader: {
	read(): Promise<{ done: boolean }>;
}): Promise<unknown> {
	const deadline = Date.now() + WAIT_MS;
	while (Date.now() < deadline) {
		try {
			const next = await within(reader.read(), "read until error");
			if (next.done) return new Error("clean EOF instead of an error");
		} catch (err) {
			return err;
		}
	}
	return new Error("no read error before the deadline");
}

async function writeUntilError(write: () => Promise<void>): Promise<unknown> {
	const deadline = Date.now() + WAIT_MS;
	while (Date.now() < deadline) {
		try {
			await within(write(), "write until error");
		} catch (err) {
			return err;
		}
		await Bun.sleep(5);
	}
	return new Error("no write error before the deadline");
}

function nodeWrite(stream: Duplex): Promise<void> {
	return new Promise((resolve, reject) => {
		stream.write(new Uint8Array(1024), (err) =>
			err ? reject(err) : resolve(),
		);
	});
}

function expectPeerCode(err: unknown, code: string, streamErrorCode: number) {
	expect(err).toBeInstanceOf(WebTransportError);
	const e = err as WebTransportError;
	expect(e.code).toBe(code as WebTransportError["code"]);
	expect(e.source).toBe("stream");
	expect(e.streamErrorCode).toBe(streamErrorCode);
}

describe("peer code in the failure message", () => {
	it("is read from both peer-fault renderings and nothing else", () => {
		expect(
			peerStreamErrorCode("E_STREAM_RESET: stream reset by peer (code 42)"),
		).toBe(42);
		expect(
			peerStreamErrorCode("E_STOP_SENDING: stream stopped by peer (code 0)"),
		).toBe(0);
		expect(
			peerStreamErrorCode(
				`GenericFailure, E_STOP_SENDING: stream stopped by peer (code ${2 ** 32 - 1})`,
			),
		).toBe(2 ** 32 - 1);
		// A local reset or any other failure carries no peer code.
		expect(peerStreamErrorCode("E_STREAM_RESET: E_STREAM_RESET")).toBeNull();
		expect(peerStreamErrorCode("E_STREAM_RESET")).toBeNull();
		expect(peerStreamErrorCode("E_INTERNAL: (code 9)")).toBeNull();
	});

	it("reaches a Node stream's error without a live connection", async () => {
		const stream = new RecvStream({
			handleId: 1,
			nativeHandle: {
				read: async () => "E_STREAM_RESET: stream reset by peer (code 42)",
				stopSending: () => {},
			},
		});
		const failed = new Promise<unknown>((resolve) =>
			stream.on("error", resolve),
		);
		stream.resume();
		expectPeerCode(
			await within(failed, "mock stream error"),
			E_STREAM_RESET,
			42,
		);
	});
});

describe("peer RESET_STREAM code reaches the receiver", () => {
	it("on a client Node stream", async () => {
		await withServer(
			async (session) => {
				const stream = await acceptBidi(session);
				await stream.writable.abort(42);
			},
			async (url) => {
				const client = await connect(url, INSECURE);
				try {
					const stream = await client.createBidirectionalStream();
					const failed = new Promise<unknown>((resolve) => {
						stream.on("error", resolve);
						stream.on("data", () => {});
					});
					stream.write(new Uint8Array([1]));
					expectPeerCode(
						await within(failed, "client stream error"),
						E_STREAM_RESET,
						42,
					);
				} finally {
					client.close();
				}
			},
		);
	}, 30_000);

	it("on the client facade readable", async () => {
		await withServer(
			async (session) => {
				const stream = await acceptBidi(session);
				await stream.writable.abort(42);
			},
			async (url) => {
				const wt = await openWTWithRetry(url, INSECURE);
				try {
					const stream = await wt.createBidirectionalStream();
					const writer = stream.writable.getWriter();
					await writer.write(new Uint8Array([1]));
					expectPeerCode(
						await readUntilError(stream.readable.getReader()),
						E_STREAM_RESET,
						42,
					);
				} finally {
					wt.close();
				}
			},
		);
	}, 30_000);

	it("on a server bidi readable", async () => {
		const accepted = deferred();
		const failure = deferred<unknown>();
		await withServer(
			async (session) => {
				const stream = await acceptBidi(session);
				const reader = stream.readable.getReader();
				await within(reader.read(), "server first chunk");
				accepted.resolve();
				failure.resolve(await readUntilError(reader));
			},
			async (url) => {
				const client = await connect(url, INSECURE);
				try {
					const stream = await client.createBidirectionalStream();
					stream.on("error", () => {});
					stream.write(new Uint8Array([1]));
					await within(accepted.promise, "server accepted");
					(stream as unknown as { [WT_RESET](code: number): void })[WT_RESET](
						42,
					);
					expectPeerCode(
						await within(failure.promise, "server read error"),
						E_STREAM_RESET,
						42,
					);
				} finally {
					client.close();
				}
			},
		);
	}, 30_000);

	it("on a server uni readable", async () => {
		const accepted = deferred();
		const failure = deferred<unknown>();
		await withServer(
			async (session) => {
				const incoming = session.incomingUnidirectionalStreams.getReader();
				const next = await within(incoming.read(), "server accept uni");
				if (next.done) throw new Error("no incoming uni stream");
				const reader = next.value.getReader();
				await within(reader.read(), "server first uni chunk");
				accepted.resolve();
				failure.resolve(await readUntilError(reader));
			},
			async (url) => {
				const client = await connect(url, INSECURE);
				try {
					const stream = await client.createUnidirectionalStream();
					stream.on("error", () => {});
					stream.write(new Uint8Array([1]));
					await within(accepted.promise, "server accepted uni");
					(stream as unknown as { [WT_RESET](code: number): void })[WT_RESET](
						42,
					);
					expectPeerCode(
						await within(failure.promise, "server uni read error"),
						E_STREAM_RESET,
						42,
					);
				} finally {
					client.close();
				}
			},
		);
	}, 30_000);
});

describe("peer STOP_SENDING code reaches the writer", () => {
	it("on a client Node stream", async () => {
		const stopped = deferred();
		await withServer(
			async (session) => {
				const stream = await acceptBidi(session);
				const reader = stream.readable.getReader();
				await within(reader.read(), "server first chunk");
				await reader.cancel(44);
				stopped.resolve();
			},
			async (url) => {
				const client = await connect(url, INSECURE);
				try {
					const stream = await client.createBidirectionalStream();
					stream.on("error", () => {});
					stream.write(new Uint8Array([1]));
					await within(stopped.promise, "server stopped sending");
					expectPeerCode(
						await writeUntilError(() => nodeWrite(stream)),
						E_STOP_SENDING,
						44,
					);
				} finally {
					client.close();
				}
			},
		);
	}, 30_000);

	it("on the client facade writable", async () => {
		const stopped = deferred();
		await withServer(
			async (session) => {
				const stream = await acceptBidi(session);
				const reader = stream.readable.getReader();
				await within(reader.read(), "server first chunk");
				await reader.cancel(44);
				stopped.resolve();
			},
			async (url) => {
				const wt = await openWTWithRetry(url, INSECURE);
				try {
					const stream = await wt.createBidirectionalStream();
					const writer = stream.writable.getWriter();
					await writer.write(new Uint8Array([1]));
					await within(stopped.promise, "server stopped sending");
					expectPeerCode(
						await writeUntilError(() => writer.write(new Uint8Array(1024))),
						E_STOP_SENDING,
						44,
					);
				} finally {
					wt.close();
				}
			},
		);
	}, 30_000);

	it("on a server bidi writable", async () => {
		const accepted = deferred();
		const stopped = deferred();
		const failure = deferred<unknown>();
		await withServer(
			async (session) => {
				const stream = await acceptBidi(session);
				const reader = stream.readable.getReader();
				await within(reader.read(), "server first chunk");
				accepted.resolve();
				await within(stopped.promise, "client stopped sending");
				const writer = stream.writable.getWriter();
				failure.resolve(
					await writeUntilError(() => writer.write(new Uint8Array(1024))),
				);
			},
			async (url) => {
				const client = await connect(url, INSECURE);
				try {
					const stream = await client.createBidirectionalStream();
					stream.on("error", () => {});
					stream.write(new Uint8Array([1]));
					await within(accepted.promise, "server accepted");
					(stream as unknown as { [WT_STOP_SENDING](code: number): void })[
						WT_STOP_SENDING
					](44);
					stopped.resolve();
					expectPeerCode(
						await within(failure.promise, "server write error"),
						E_STOP_SENDING,
						44,
					);
				} finally {
					client.close();
				}
			},
		);
	}, 30_000);
});
