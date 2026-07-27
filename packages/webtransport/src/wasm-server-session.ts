import type { WasmSession } from "./backend.js";

/**
 * Thin server-session facade over {@link WasmSession} for closer native
 * ServerSession ergonomics without inventing plug-and-play createServer().
 */
export class WasmServerSession {
	constructor(private readonly session: WasmSession) {}

	get ready(): Promise<void> {
		return this.session.ready;
	}

	get closed(): Promise<{ code?: number; reason?: string }> {
		return this.session.closed;
	}

	get maxDatagramSize(): number {
		return this.session.maxDatagramSize;
	}

	get sessionId(): bigint {
		return this.session.sessionId;
	}

	/** Underlying callback session. */
	unwrap(): WasmSession {
		return this.session;
	}

	sendDatagram(data: Uint8Array): Promise<void> {
		return this.session.sendDatagram(data);
	}

	onDatagram(
		cb: (data: Uint8Array, reservation?: { release(): void }) => void,
		options?: { retainReservation?: boolean },
	): void {
		this.session.onDatagram(cb, options);
	}

	createBidirectionalStream() {
		return this.session.createBidirectionalStream();
	}

	createUnidirectionalStream() {
		return this.session.createUnidirectionalStream();
	}

	onIncomingStream(
		cb: (stream: ReturnType<WasmSession["createBidirectionalStream"]>) => void,
	) {
		this.session.onIncomingStream(cb);
	}

	metricsSnapshot(): {
		datagramsIn: number;
		datagramsOut: number;
		streamsActive: number;
		queuedBytes: number;
	} {
		return this.session.metricsSnapshot();
	}

	close(info?: { code?: number; reason?: string }): void {
		this.session.close(info);
	}
}

/** Wrap an accepted wasm session as a ServerSession-like facade. */
export function toWasmServerSession(session: WasmSession): WasmServerSession {
	return new WasmServerSession(session);
}
