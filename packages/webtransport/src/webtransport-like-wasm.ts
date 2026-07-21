// Wasm adapter: present the W3C `WasmWebTransport` class (Wasm backend)
// through the backend-agnostic `WebTransportLike` contract.
//
// The Wasm WebTransport facade is WHATWG-based (its datagrams/streams are
// ReadableStream/WritableStream), so this is a thin translation of close-info
// shapes and a wrapper of its `ReadableStream` accessors as async-iterables.
// It completely mirrors `webtransport-like-native.ts`.

import type { WasmWebTransport } from "./wasm-webtransport.js";
import type { WebTransportLike, WtBidiStream, WtCloseInfo } from "./shared.js";

/** Async-iterate a ReadableStream, releasing the reader when done. */
async function* iterate<T>(stream: ReadableStream<T>): AsyncIterable<T> {
	const reader = stream.getReader();
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return;
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

/** Adapt a Wasm {@link WasmWebTransport} to the shared {@link WebTransportLike} contract. */
export function wasmToWebTransportLike(wt: WasmWebTransport): WebTransportLike {
	let datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;

	// The WebTransportLike contract says `closed` NEVER rejects — connection
	// failure is surfaced via `ready` (which rejects) instead. The underlying
	// W3C `wt.closed` DOES reject on connect failure, so map that rejection to a
	// resolved close info here to honor the contract. (`wt.ready`, forwarded
	// below, already carries an internal no-op catch in the WasmWebTransport class,
	// so forwarding it cannot leak an unhandled rejection.)
	const closed = wt.closed.then(
		(info) => ({ code: info.closeCode, reason: info.reason }),
		() => ({ code: 0, reason: "" }),
	);

	const transport = {
		ready: wt.ready,
		closed,

		close(info?: WtCloseInfo): void {
			wt.close({ closeCode: info?.code, reason: info?.reason });
		},

		async sendDatagram(data: Uint8Array): Promise<void> {
			if (!datagramWriter) {
				datagramWriter = wt.datagrams.writable.getWriter();
			}
			await datagramWriter.write(data);
		},

		incomingDatagrams(): AsyncIterable<Uint8Array> {
			return iterate(wt.datagrams.readable);
		},

		createBidirectionalStream(): Promise<WtBidiStream> {
			return wt.createBidirectionalStream();
		},

		createUnidirectionalStream(): Promise<WritableStream<Uint8Array>> {
			return wt.createUnidirectionalStream();
		},

		incomingBidirectionalStreams(): AsyncIterable<WtBidiStream> {
			return iterate(wt.incomingBidirectionalStreams);
		},

		incomingUnidirectionalStreams(): AsyncIterable<ReadableStream<Uint8Array>> {
			return iterate(wt.incomingUnidirectionalStreams);
		},
	} satisfies WebTransportLike;

	return transport;
}
