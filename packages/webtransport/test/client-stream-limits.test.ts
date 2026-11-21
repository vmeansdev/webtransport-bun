/**
 * Client `limits.maxStreamsPerSessionBidi` / `maxStreamsPerSessionUni`: the
 * client enforces them the way the server does. Local opens over the cap
 * reject with E_LIMIT_EXCEEDED; peer streams over the cap are refused (reset /
 * STOP_SENDING) rather than surfaced. The admission logic itself is unit-tested
 * in crates/native/src/client.rs.
 */

import { describe, expect, it } from "bun:test";
import type { Readable, Writable } from "node:stream";
import {
	createServer,
	E_LIMIT_EXCEEDED,
	type ServerSession,
	WebTransportError,
} from "../src/index.js";
import { connectWithRetry, nextPort } from "./helpers/network.js";

const TLS = { insecureSkipVerify: true, serverName: "stream-limits.test" };

function idleServer(port: number, onSession?: (s: ServerSession) => void) {
	return createServer({
		port,
		host: "127.0.0.1",
		tls: { certPem: "", keyPem: "" },
		onSession: (s) => onSession?.(s),
	});
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
	try {
		const value = (await p) as { destroy?: () => void };
		value.destroy?.();
		return undefined;
	} catch (err) {
		return err instanceof WebTransportError ? err.code : String(err);
	}
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	return Promise.race([
		p,
		Bun.sleep(ms).then(() => {
			throw new Error(`timeout: ${what}`);
		}),
	]);
}

describe("client per-session stream caps", () => {
	it("rejects a local open over the cap and admits again once a stream closes", async () => {
		const port = nextPort(26820, 1000);
		const server = idleServer(port);
		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: TLS,
			limits: { maxStreamsPerSessionBidi: 1, maxStreamsPerSessionUni: 1 },
		});
		try {
			const bidi = await client.createBidirectionalStream();
			expect(await codeOf(client.createBidirectionalStream())).toBe(
				E_LIMIT_EXCEEDED,
			);

			const uni = await client.createUnidirectionalStream();
			expect(await codeOf(client.createUnidirectionalStream())).toBe(
				E_LIMIT_EXCEEDED,
			);

			const waiting = client.createBidirectionalStream({
				waitUntilAvailable: true,
			});
			await Bun.sleep(50);
			bidi.destroy();
			(await within(waiting, 3000, "bidi slot reuse")).destroy();
			uni.destroy();
		} finally {
			client.close();
			await server.close();
		}
	}, 15000);

	it("refuses a peer stream over the cap instead of surfacing it", async () => {
		const port = nextPort(26820, 1000);
		let secondRefused: Promise<boolean> | undefined;
		const server = idleServer(port, (session) => {
			void (async () => {
				const first = (await session.createUnidirectionalStream()) as Writable;
				first.write(new Uint8Array([1]));
				const second = (await session.createUnidirectionalStream()) as Writable;
				secondRefused = new Promise<boolean>((resolve) => {
					second.once("error", () => resolve(true));
					const deadline = Date.now() + 5000;
					const tick = () => {
						if (second.destroyed) return resolve(true);
						if (Date.now() > deadline) return resolve(false);
						second.write(new Uint8Array([2]));
						setTimeout(tick, 50);
					};
					tick();
				});
			})().catch(() => {});
		});
		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: TLS,
			limits: { maxStreamsPerSessionUni: 1 },
		});
		try {
			const incoming = client
				.incomingUnidirectionalStreams()
				[Symbol.asyncIterator]();
			const first = await within(incoming.next(), 5000, "first peer stream");
			expect(first.done).toBe(false);
			const firstStream = first.value as Readable;
			firstStream.on("data", () => {});

			// The slot stays held by the open first stream, so the second must
			// be refused, never delivered.
			const next = incoming.next();
			next.catch(() => {});
			const delivered = await Promise.race([
				next.then(() => true),
				Bun.sleep(1500).then(() => false),
			]);
			expect(delivered).toBe(false);

			const deadline = Date.now() + 5000;
			while (secondRefused === undefined && Date.now() < deadline) {
				await Bun.sleep(20);
			}
			expect(await within(secondRefused!, 6000, "peer refusal")).toBe(true);
			firstStream.destroy();
		} finally {
			client.close();
			await server.close();
		}
	}, 20000);
});
