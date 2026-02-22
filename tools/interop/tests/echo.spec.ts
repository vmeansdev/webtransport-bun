import { test, expect } from '@playwright/test';
import { getCertHashBase64 } from '../cert-hash.js';

test('bidi stream echo via WebTransport', async ({ page }) => {
    await page.goto('http://127.0.0.1:4434');
    const hashBase64 = getCertHashBase64();

    const result = await page.evaluate(
        async (h: string) => {
            const opts: WebTransportOptions = {};
            if (h) {
                const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
                opts.serverCertificateHashes = [
                    { algorithm: 'sha-256', value: bin.buffer },
                ];
            }
            try {
                const wt = new WebTransport('https://127.0.0.1:4433', opts);
                await wt.ready;

                const stream = await wt.createBidirectionalStream();
                const writer = stream.writable.getWriter();
                const reader = stream.readable.getReader();

                const text = 'Hello WebTransport from Bun!';
                await writer.write(new TextEncoder().encode(text));
                await writer.close();

                const { value } = await reader.read();
                await wt.close();

                return new TextDecoder().decode(value);
            } catch (e: unknown) {
                return (e as Error).message;
            }
        },
        hashBase64
    );

    expect(result).toBe('Hello WebTransport from Bun!');
});

test('datagram echo via WebTransport', async ({ page }) => {
    await page.goto('http://127.0.0.1:4434');
    const hashBase64 = getCertHashBase64();

    const result = await page.evaluate(
        async (h: string) => {
            const opts: WebTransportOptions = {};
            if (h) {
                const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
                opts.serverCertificateHashes = [
                    { algorithm: 'sha-256', value: bin.buffer },
                ];
            }
            try {
                const wt = new WebTransport('https://127.0.0.1:4433', opts);
                await wt.ready;

                const text = 'Datagram echo test!';
                const payload = new TextEncoder().encode(text);

                const writer = wt.datagrams.writable.getWriter();
                await writer.write(payload);
                writer.releaseLock();

                const reader = wt.datagrams.readable.getReader();
                const { value } = await reader.read();
                await wt.close();

                return value ? new TextDecoder().decode(value) : null;
            } catch (e: unknown) {
                return (e as Error).message;
            }
        },
        hashBase64
    );

    expect(result).toBe('Datagram echo test!');
});

test('unidirectional stream echo via WebTransport', async ({ page }) => {
    await page.goto('http://127.0.0.1:4434');
    const hashBase64 = getCertHashBase64();

    const result = await page.evaluate(
        async (h: string) => {
            const opts: WebTransportOptions = {};
            if (h) {
                const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
                opts.serverCertificateHashes = [
                    { algorithm: 'sha-256', value: bin.buffer },
                ];
            }
            try {
                const wt = new WebTransport('https://127.0.0.1:4433', opts);
                await wt.ready;

                const text = 'Uni stream echo test!';

                // Create outgoing uni stream and write
                const writable = await wt.createUnidirectionalStream();
                const writer = writable.getWriter();
                await writer.write(new TextEncoder().encode(text));
                await writer.close();

                // Server echoes back on a new uni stream; read from incoming
                const reader = wt.incomingUnidirectionalStreams.getReader();
                const { value: stream } = await reader.read();
                if (!stream) throw new Error('No incoming uni stream');

                const streamReader = stream.getReader();
                const { value } = await streamReader.read();
                await wt.close();

                return value ? new TextDecoder().decode(value) : null;
            } catch (e: unknown) {
                return (e as Error).message;
            }
        },
        hashBase64
    );

    expect(result).toBe('Uni stream echo test!');
});
