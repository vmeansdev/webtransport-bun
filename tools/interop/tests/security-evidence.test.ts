import { describe, expect, it } from "bun:test";
import {
	buildInteropWebServerEnv,
	buildInteropWebServerCommand,
	resolveBunExecutable,
} from "../web-server-env.ts";
import {
	verifyEvidenceDocument,
	verifyInteropEvidenceDocument,
} from "../verify-evidence.ts";

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
		).toThrow(/environment|host path/i);
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

	it("accepts benign authoritative telemetry keys", () => {
		expect(() =>
			verifyEvidenceDocument({
				memoryTelemetry: {
					inProcessRssRecovery: { authoritative: false },
				},
			}),
		).not.toThrow();
	});

	it("keeps generic config artifacts outside the interop schema", () => {
		expect(() =>
			verifyEvidenceDocument({
				config: {
					label: "distributed-scale",
					artifactPath:
						".release-evidence/load/distributed-scale-artifact.json",
				},
			}),
		).not.toThrow();
	});

	it("rejects nested secrets and host paths without echoing values", () => {
		const cases = [
			{
				marker: "sk-test-secret-value",
				document: {
					metadata: { nested: { authorization: "sk-test-secret-value" } },
				},
			},
			{
				marker: "/Users/private-user/project",
				document: {
					results: [{ details: { sourcePath: "/Users/private-user/project" } }],
				},
			},
			{
				marker: "C:\\Users\\private-user\\project",
				document: {
					results: [
						{ details: { sourcePath: "C:\\Users\\private-user\\project" } },
					],
				},
			},
			{
				marker: "\\\\private-server\\share\\evidence.json",
				document: {
					results: [
						{
							details: {
								sourcePath: "\\\\private-server\\share\\evidence.json",
							},
						},
					],
				},
			},
		];

		for (const { marker, document } of cases) {
			let thrown: unknown;
			try {
				verifyEvidenceDocument(document);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeDefined();
			const message = String(thrown);
			expect(message).toContain("unsafe interop evidence");
			expect(message).not.toContain(marker);
		}
	});

	it("keeps interop schema checks separate from the generic privacy walk", () => {
		expect(() =>
			verifyEvidenceDocument({ readiness: { status: "passed" } }),
		).not.toThrow();
		expect(() =>
			verifyInteropEvidenceDocument({ readiness: { status: "passed" } }),
		).toThrow(/config|webServer/i);
	});
});
