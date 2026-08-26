/**
 * Test worker: drains a native sink ring with SinkReader and posts the
 * collected records back once a terminal record (or the deadline) arrives.
 * Loaded through the "sink-reader" module directly — a consumer worker needs
 * no native code.
 */
import { SinkReader } from "../../src/sink-reader.js";
import type { StreamSinkDescriptor } from "../../src/sink-layout.js";

declare var self: Worker;

interface StartMessage {
	sab: SharedArrayBuffer;
	descriptor: StreamSinkDescriptor;
	deadlineMs: number;
	wakeTimeoutMs?: number;
}

self.onmessage = (event: MessageEvent) => {
	const { sab, descriptor, deadlineMs, wakeTimeoutMs } =
		event.data as StartMessage;
	// copy: true — records are posted across the worker boundary, so views
	// into the shared ring would be reclaimed under the receiver.
	const reader = new SinkReader(descriptor, sab, { wakeTimeoutMs, copy: true });
	const records: unknown[] = [];
	const deadline = Date.now() + deadlineMs;
	while (reader.state === "active" && Date.now() < deadline) {
		const record = reader.next(Math.max(1, deadline - Date.now()));
		if (record) records.push(record);
	}
	postMessage({ records, endState: reader.state });
};
