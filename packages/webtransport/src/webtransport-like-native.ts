// Native adapter: present the W3C `WebTransport` class (Node-API addon backend)
// through the backend-agnostic `WebTransportLike` contract.
//
// The native facade is already WHATWG-based (its datagrams/streams are
// ReadableStream/WritableStream), so this is a thin translation of close-info
// shapes and a wrapper of its `ReadableStream` accessors as async-iterables. It
// does NOT modify the `WebTransport` class or any native runtime behavior.

import type { WebTransport } from "./index.js";
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

/** Adapt a native W3C {@link WebTransport} to the shared {@link WebTransportLike} contract. */
export function nativeToWebTransportLike(wt: WebTransport): WebTransportLike {
	let datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;

	return {
		ready: wt.ready,
		closed: wt.closed.then((info) => ({
			code: info.closeCode,
			reason: info.reason,
		})),

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
	};
}
