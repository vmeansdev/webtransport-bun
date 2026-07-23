import { expect, test } from "@playwright/test";
import {
	BROWSER_READ_WITH_TIMEOUT_INIT_SCRIPT,
	createMonotonicDeadline,
	fetchWithTimeout,
	promiseWithTimeout,
} from "../browser-helpers.js";

const HEALTH_URL = "http://127.0.0.1:4436";
const QUIC_URL = "https://127.0.0.1:4435";

test.beforeEach(async ({ page }) => {
	await page.addInitScript({ content: BROWSER_READ_WITH_TIMEOUT_INIT_SCRIPT });
});

async function fetchCertHash(): Promise<string> {
	const deadline = createMonotonicDeadline(2_000);
	const res = await fetchWithTimeout(
		`${HEALTH_URL}/cert-hash`,
		undefined,
		2_000,
		"wasm cert-hash fetch",
		deadline,
	);
	const json = (await promiseWithTimeout(
		res.json(),
		2_000,
		"wasm cert-hash json",
		deadline,
	)) as {
		hashBase64?: string;
		executionIdentity?: string;
	};
	if (json.executionIdentity !== "wasm-under-bun") {
		throw new Error(`wrong execution identity: ${json.executionIdentity}`);
	}
	if (!json.hashBase64) throw new Error("no cert hash from health server");
	return json.hashBase64;
}

test("execution identity is WASM under Bun", async () => {
	const deadline = createMonotonicDeadline(2_000);
	const response = await fetchWithTimeout(
		`${HEALTH_URL}/execution-identity`,
		{
			cache: "no-store",
		},
		2_000,
		"wasm execution identity fetch",
		deadline,
	);
	expect(response.ok).toBe(true);
	expect(
		await promiseWithTimeout(
			response.json(),
			2_000,
			"wasm execution identity json",
			deadline,
		),
	).toEqual({
		executionIdentity: "wasm-under-bun",
	});
});

test("datagram echo via native WebTransport -> wasm server", async ({
	page,
}) => {
	await page.goto(HEALTH_URL);
	const hashBase64 = await fetchCertHash();

	const result = await page.evaluate(
		async ({ url, h }) => {
			const helpers = globalThis as typeof globalThis & {
				__wtReadWithTimeout?: <T>(
					reader: ReadableStreamDefaultReader<T>,
					timeoutMs: number,
					label: string,
				) => Promise<ReadableStreamReadResult<T>>;
				__wtWithTimeout?: <T>(
					promise: PromiseLike<T>,
					timeoutMs: number,
					label: string,
				) => Promise<T>;
			};
			const readWithTimeout = helpers.__wtReadWithTimeout;
			const withTimeout = helpers.__wtWithTimeout;
			if (!readWithTimeout || !withTimeout)
				throw new Error("bounded browser helpers missing");
			const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
			const opts: WebTransportOptions = {
				serverCertificateHashes: [{ algorithm: "sha-256", value: bin }],
			};
			try {
				const wt = new WebTransport(url, opts);
				await withTimeout(wt.ready, 5_000, "wasm datagram ready");

				const text = "Datagram echo test!";
				const writer = wt.datagrams.writable.getWriter();
				await writer.write(new TextEncoder().encode(text));
				writer.releaseLock();

				const reader = wt.datagrams.readable.getReader();
				const { value } = await readWithTimeout(
					reader,
					5000,
					"wasm interop datagram read",
				);
				await wt.close();
				return value ? new TextDecoder().decode(value as Uint8Array) : null;
			} catch (e: unknown) {
				return (e as Error).message;
			}
		},
		{ url: QUIC_URL, h: hashBase64 },
	);

	expect(result).toBe("Datagram echo test!");
});

test("bidi stream echo via native WebTransport -> wasm server", async ({
	page,
}) => {
	await page.goto(HEALTH_URL);
	const hashBase64 = await fetchCertHash();

	const result = await page.evaluate(
		async ({ url, h }) => {
			const helpers = globalThis as typeof globalThis & {
				__wtReadWithTimeout?: <T>(
					reader: ReadableStreamDefaultReader<T>,
					timeoutMs: number,
					label: string,
				) => Promise<ReadableStreamReadResult<T>>;
				__wtWithTimeout?: <T>(
					promise: PromiseLike<T>,
					timeoutMs: number,
					label: string,
				) => Promise<T>;
			};
			const readWithTimeout = helpers.__wtReadWithTimeout;
			const withTimeout = helpers.__wtWithTimeout;
			if (!readWithTimeout || !withTimeout)
				throw new Error("bounded browser helpers missing");
			const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
			const opts: WebTransportOptions = {
				serverCertificateHashes: [{ algorithm: "sha-256", value: bin }],
			};
			try {
				const wt = new WebTransport(url, opts);
				await withTimeout(wt.ready, 5_000, "wasm bidi ready");

				const stream = await wt.createBidirectionalStream();
				const writer = stream.writable.getWriter();
				const reader = stream.readable.getReader();

				const text = "Hello WebTransport from Bun!";
				await writer.write(new TextEncoder().encode(text));
				await writer.close();

				const { value } = await readWithTimeout(
					reader,
					5000,
					"wasm interop bidi echo read",
				);
				await wt.close();
				return value ? new TextDecoder().decode(value) : null;
			} catch (e: unknown) {
				return (e as Error).message;
			}
		},
		{ url: QUIC_URL, h: hashBase64 },
	);

	expect(result).toBe("Hello WebTransport from Bun!");
});

test("unidirectional stream echo via native WebTransport -> wasm server", async ({
	page,
}) => {
	await page.goto(HEALTH_URL);
	const hashBase64 = await fetchCertHash();

	const result = await page.evaluate(
		async ({ url, h }) => {
			const helpers = globalThis as typeof globalThis & {
				__wtReadWithTimeout?: <T>(
					reader: ReadableStreamDefaultReader<T>,
					timeoutMs: number,
					label: string,
				) => Promise<ReadableStreamReadResult<T>>;
				__wtWithTimeout?: <T>(
					promise: PromiseLike<T>,
					timeoutMs: number,
					label: string,
				) => Promise<T>;
			};
			const readWithTimeout = helpers.__wtReadWithTimeout;
			const withTimeout = helpers.__wtWithTimeout;
			if (!readWithTimeout || !withTimeout)
				throw new Error("bounded browser helpers missing");
			const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
			const opts: WebTransportOptions = {
				serverCertificateHashes: [{ algorithm: "sha-256", value: bin }],
			};
			try {
				const wt = new WebTransport(url, opts);
				await withTimeout(wt.ready, 5_000, "wasm uni ready");

				const text = "Uni stream echo test!";
				const writable = await wt.createUnidirectionalStream();
				const writer = writable.getWriter();
				await writer.write(new TextEncoder().encode(text));
				await writer.close();

				const reader = wt.incomingUnidirectionalStreams.getReader();
				const { value: stream } = await readWithTimeout(
					reader,
					5000,
					"wasm interop incoming uni handle read",
				);
				if (!stream) throw new Error("No incoming uni stream");

				const streamReader = stream.getReader();
				const { value } = await readWithTimeout(
					streamReader,
					5000,
					"wasm interop incoming uni payload read",
				);
				await wt.close();
				return value ? new TextDecoder().decode(value) : null;
			} catch (e: unknown) {
				return (e as Error).message;
			}
		},
		{ url: QUIC_URL, h: hashBase64 },
	);

	expect(result).toBe("Uni stream echo test!");
});

test("eight consecutive Chromium reconnects complete against the WASM server", async ({
	page,
}) => {
	await page.goto(HEALTH_URL);
	const hashBase64 = await fetchCertHash();
	const result = await page.evaluate(
		async ({ url, h }) => {
			const withTimeout = async <T>(
				promise: Promise<T>,
				label: string,
			): Promise<T> => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					return await Promise.race([
						promise,
						new Promise<never>((_, reject) => {
							timer = setTimeout(
								() => reject(new Error(`${label} timeout`)),
								5_000,
							);
						}),
					]);
				} finally {
					if (timer !== undefined) clearTimeout(timer);
				}
			};
			const value = Uint8Array.from(atob(h), (char) => char.charCodeAt(0));
			const attempts: Array<{ attempt: number; closed: boolean }> = [];
			for (let attempt = 1; attempt <= 8; attempt += 1) {
				const transport = new WebTransport(url, {
					serverCertificateHashes: [{ algorithm: "sha-256", value }],
				});
				await withTimeout(transport.ready, `ready ${attempt}`);
				transport.close({
					closeCode: 4400 + attempt,
					reason: "wasm-reconnect",
				});
				await withTimeout(transport.closed, `closed ${attempt}`);
				attempts.push({ attempt, closed: true });
			}
			return attempts;
		},
		{ url: QUIC_URL, h: hashBase64 },
	);
	expect(result).toEqual(
		Array.from({ length: 8 }, (_, index) => ({
			attempt: index + 1,
			closed: true,
		})),
	);
});
