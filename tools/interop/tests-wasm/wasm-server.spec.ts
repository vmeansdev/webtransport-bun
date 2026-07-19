import { expect, test } from "@playwright/test";

const HEALTH_URL = "http://127.0.0.1:4436";
const QUIC_URL = "https://127.0.0.1:4435";

async function fetchCertHash(): Promise<string> {
	const res = await fetch(`${HEALTH_URL}/cert-hash`);
	const json = (await res.json()) as { hashBase64?: string };
	if (!json.hashBase64) throw new Error("no cert hash from health server");
	return json.hashBase64;
}

test("datagram echo via native WebTransport -> wasm server", async ({
	page,
}) => {
	await page.goto(HEALTH_URL);
	const hashBase64 = await fetchCertHash();

	const result = await page.evaluate(
		async ({ url, h }) => {
			const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
			const opts: WebTransportOptions = {
				serverCertificateHashes: [{ algorithm: "sha-256", value: bin }],
			};
			try {
				const wt = new WebTransport(url, opts);
				await wt.ready;

				const text = "Datagram echo test!";
				const writer = wt.datagrams.writable.getWriter();
				await writer.write(new TextEncoder().encode(text));
				writer.releaseLock();

				const reader = wt.datagrams.readable.getReader();
				const { value } = await reader.read();
				await wt.close();
				return value ? new TextDecoder().decode(value) : null;
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
			const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
			const opts: WebTransportOptions = {
				serverCertificateHashes: [{ algorithm: "sha-256", value: bin }],
			};
			try {
				const wt = new WebTransport(url, opts);
				await wt.ready;

				const stream = await wt.createBidirectionalStream();
				const writer = stream.writable.getWriter();
				const reader = stream.readable.getReader();

				const text = "Hello WebTransport from Bun!";
				await writer.write(new TextEncoder().encode(text));
				await writer.close();

				const { value } = await reader.read();
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
			const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
			const opts: WebTransportOptions = {
				serverCertificateHashes: [{ algorithm: "sha-256", value: bin }],
			};
			try {
				const wt = new WebTransport(url, opts);
				await wt.ready;

				const text = "Uni stream echo test!";
				const writable = await wt.createUnidirectionalStream();
				const writer = writable.getWriter();
				await writer.write(new TextEncoder().encode(text));
				await writer.close();

				const reader = wt.incomingUnidirectionalStreams.getReader();
				const { value: stream } = await reader.read();
				if (!stream) throw new Error("No incoming uni stream");

				const streamReader = stream.getReader();
				const { value } = await streamReader.read();
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
