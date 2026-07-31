import { describe, expect, it } from "bun:test";
import {
	buildInteropWebServerEnv,
	buildInteropWebServerCommand,
	resolveBunExecutable,
} from "../web-server-env.ts";
import { verifyEvidenceDocument } from "../verify-evidence.ts";

describe("interop evidence security boundary", () => {
	it("forwards only documented non-sensitive server settings", () => {
		const env = buildInteropWebServerEnv({
			HOME: "/Users/secret",
			LOKALISE_API_TOKEN: "secret-token",
			OLLAMA_API_KEY: "secret-key",
			SSH_AUTH_SOCK: "/tmp/ssh-agent",
			PATH: "/usr/bin",
			WT_IDLE_TIMEOUT_MS: "5000",
			WT_QPACK_MAX_TABLE_CAPACITY: "4096",
			WEBTRANSPORT_INTEROP_HOST: "127.0.0.1",
			WEBTRANSPORT_INTEROP_QUIC_PORT: "4433",
			WEBTRANSPORT_INTEROP_HEALTH_PORT: "4434",
		});

		expect(env).toEqual({
			WT_IDLE_TIMEOUT_MS: "5000",
			WT_QPACK_MAX_TABLE_CAPACITY: "4096",
			WEBTRANSPORT_INTEROP_HOST: "127.0.0.1",
			WEBTRANSPORT_INTEROP_QUIC_PORT: "4433",
			WEBTRANSPORT_INTEROP_HEALTH_PORT: "4434",
		});
	});

	it("uses the current Bun executable instead of PATH lookup", () => {
		const command = buildInteropWebServerCommand();
		expect(command).toContain(resolveBunExecutable());
		expect(command).not.toContain("bun run");
	});

	it("rejects inherited environment keys and host paths in evidence", () => {
		expect(() =>
			verifyEvidenceDocument({
				config: {
					webServer: {
						env: {
							HOME: "/Users/vmeansdev",
							LOKALISE_API_TOKEN: "secret-token",
							SSH_AUTH_SOCK: "/tmp/agent.sock",
						},
					},
				},
			}),
		).toThrow(/environment/i);
	});

	it("accepts evidence containing only the documented runtime environment", () => {
		expect(() =>
			verifyEvidenceDocument({
				config: {
					webServer: {
						env: {
							WT_IDLE_TIMEOUT_MS: "5000",
							WEBTRANSPORT_INTEROP_HOST: "127.0.0.1",
							WEBTRANSPORT_INTEROP_QUIC_PORT: "4433",
							WEBTRANSPORT_INTEROP_HEALTH_PORT: "4434",
						},
					},
				},
			}),
		).not.toThrow();
	});
});
