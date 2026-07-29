/**
 * Parity baseline tests (Phase 0).
 * Freezes current WebTransport facade surface and key behaviors.
 * These tests must pass before any parity work; they catch regressions.
 *
 * Backend selector: WEBTRANSPORT_PARITY_BACKEND=wasm (requires wasm pkg).
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { WebTransport } from "../src/index.js";
import { WasmWebTransport } from "../src/wasm-webtransport.js";
import {
	createParityHarness,
	isWasmParityBackend,
	PARITY_BACKEND,
	skipWasmParityIfUnavailable,
	type ParityHarness,
} from "./helpers/parity-backend.js";

describe.skipIf(skipWasmParityIfUnavailable)(
	`parity baseline (Phase 0) [${PARITY_BACKEND}]`,
	() => {
		let harness: ParityHarness;

		beforeAll(async () => {
			harness = await createParityHarness({
				onSession: () => {},
			});
		});

		afterAll(async () => {
			await harness.close();
		});

		test("WebTransport facade has required members", async () => {
			const wt = await harness.open({});

			// Lifecycle
			expect("ready" in wt).toBe(true);
			expect("closed" in wt).toBe(true);
			expect("draining" in wt).toBe(true);

			// Datagrams (WebTransportDatagramDuplexStream)
			expect("datagrams" in wt).toBe(true);
			expect(wt.datagrams).toBeDefined();
			expect("readable" in wt.datagrams).toBe(true);
			expect("writable" in wt.datagrams).toBe(true);
			expect(typeof wt.datagrams.createWritable).toBe("function");
			expect(typeof wt.datagrams.maxDatagramSize).toBe("number");

			// Streams
			expect("incomingBidirectionalStreams" in wt).toBe(true);
			expect("incomingUnidirectionalStreams" in wt).toBe(true);
			expect(typeof wt.createBidirectionalStream).toBe("function");
			expect(typeof wt.createUnidirectionalStream).toBe("function");
			expect(typeof wt.createSendGroup).toBe("function");
			expect(typeof wt.close).toBe("function");

			wt.close();
		});

		test("WebTransport.getStats returns connection stats shape", async () => {
			const wt = await harness.open({});

			expect(typeof wt.getStats).toBe("function");
			const stats = await wt.getStats();
			expect(stats).toBeDefined();
			expect(stats.datagrams).toBeDefined();
			expect(typeof stats.datagrams.droppedIncoming).toBe("number");
			expect(typeof stats.datagrams.expiredIncoming).toBe("number");
			expect(typeof stats.datagrams.expiredOutgoing).toBe("number");
			expect(typeof stats.datagrams.lostOutgoing).toBe("number");
			expect(typeof stats.bytesSent).toBe("number");
			expect(typeof stats.bytesReceived).toBe("number");
			expect(typeof stats.packetsSent).toBe("number");
			expect(typeof stats.packetsReceived).toBe("number");

			wt.close();
		});

		test("allowPooling and requireUnreliable options are accepted", () => {
			expect(() => {
				const wt = harness.construct({
					allowPooling: true,
				});
				wt.close();
			}).not.toThrow();
			expect(() => {
				const wt = harness.construct({
					requireUnreliable: true,
				});
				wt.close();
			}).not.toThrow();
		});

		test("datagrams.readable and datagrams.writable are Web Streams", async () => {
			const wt = await harness.open({});

			expect(wt.datagrams.readable).toBeInstanceOf(ReadableStream);
			expect(wt.datagrams.writable).toBeInstanceOf(WritableStream);

			wt.close();
		});

		test("supportsReliableOnly is false on the selected facade", () => {
			if (isWasmParityBackend()) {
				expect(WasmWebTransport.supportsReliableOnly).toBe(false);
			} else {
				expect(WebTransport.supportsReliableOnly).toBe(false);
			}
		});
	},
);
