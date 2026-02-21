import { describe, it, expect } from "bun:test";
import {
    createServer,
    DEFAULT_LIMITS,
    DEFAULT_RATE_LIMITS,
    E_TLS,
    E_HANDSHAKE_TIMEOUT,
    E_SESSION_CLOSED,
    E_SESSION_IDLE_TIMEOUT,
    E_STREAM_RESET,
    E_STOP_SENDING,
    E_QUEUE_FULL,
    E_BACKPRESSURE_TIMEOUT,
    E_LIMIT_EXCEEDED,
    E_RATE_LIMITED,
    E_INTERNAL,
    WebTransportError,
    WT_RESET,
    WT_STOP_SENDING,
} from "../src/index.js";

describe("webtransport package exports", () => {
    it("exports createServer function", () => {
        expect(typeof createServer).toBe("function");
    });

    it("exports all stable error codes", () => {
        expect(E_TLS).toBe("E_TLS");
        expect(E_HANDSHAKE_TIMEOUT).toBe("E_HANDSHAKE_TIMEOUT");
        expect(E_SESSION_CLOSED).toBe("E_SESSION_CLOSED");
        expect(E_SESSION_IDLE_TIMEOUT).toBe("E_SESSION_IDLE_TIMEOUT");
        expect(E_STREAM_RESET).toBe("E_STREAM_RESET");
        expect(E_STOP_SENDING).toBe("E_STOP_SENDING");
        expect(E_QUEUE_FULL).toBe("E_QUEUE_FULL");
        expect(E_BACKPRESSURE_TIMEOUT).toBe("E_BACKPRESSURE_TIMEOUT");
        expect(E_LIMIT_EXCEEDED).toBe("E_LIMIT_EXCEEDED");
        expect(E_RATE_LIMITED).toBe("E_RATE_LIMITED");
        expect(E_INTERNAL).toBe("E_INTERNAL");
    });

    it("exports WebTransportError class", () => {
        const err = new WebTransportError("E_TLS", "bad cert");
        expect(err).toBeInstanceOf(Error);
        expect(err.code).toBe("E_TLS");
        expect(err.message).toBe("bad cert");
        expect(err.name).toBe("WebTransportError");
    });

    it("exports stream control symbols", () => {
        expect(typeof WT_RESET).toBe("symbol");
        expect(typeof WT_STOP_SENDING).toBe("symbol");
    });

    it("exports DEFAULT_LIMITS with AGENTS.md values", () => {
        expect(DEFAULT_LIMITS.maxSessions).toBe(2000);
        expect(DEFAULT_LIMITS.maxHandshakesInFlight).toBe(200);
        expect(DEFAULT_LIMITS.maxStreamsGlobal).toBe(50_000);
        expect(DEFAULT_LIMITS.maxDatagramSize).toBe(1200);
        expect(DEFAULT_LIMITS.maxQueuedBytesGlobal).toBe(512 * 1024 * 1024);
        expect(DEFAULT_LIMITS.backpressureTimeoutMs).toBe(5000);
        expect(DEFAULT_LIMITS.handshakeTimeoutMs).toBe(10_000);
        expect(DEFAULT_LIMITS.idleTimeoutMs).toBe(60_000);
    });

    it("exports DEFAULT_RATE_LIMITS", () => {
        expect(DEFAULT_RATE_LIMITS.handshakesPerSec).toBe(20);
        expect(DEFAULT_RATE_LIMITS.handshakesBurst).toBe(40);
        expect(DEFAULT_RATE_LIMITS.datagramsPerSec).toBe(2000);
    });

    it("createServer returns a server instance", () => {
        const server = createServer({
            port: 4433,
            tls: { certPem: "", keyPem: "" },
            onSession: () => { },
        });
        expect(server).toBeDefined();
        expect(server.address).toBeDefined();
        expect(server.address.port).toBe(4433);
        expect(typeof server.close).toBe("function");
    });
});
