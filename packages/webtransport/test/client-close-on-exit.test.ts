import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "../src/index.js";
import { generateCertForNames } from "./helpers/certs.js";

const INDEX = resolve(import.meta.dir, "../src/index.ts");

// A client that calls session.close() and then process.exit() straight away
// used to kill the addon's client thread before the close was sent, leaving
// its sessions open on the server until the 60 s idle timeout.
describe("client close survives an immediate process.exit()", () => {
	it("the server sees every session close", async () => {
		const cert = generateCertForNames(["localhost", "127.0.0.1"]);
		if (!cert) return;
		const server = createServer({
			port: 0,
			host: "127.0.0.1",
			tls: { certPem: cert.certPem, keyPem: cert.keyPem },
			rateLimits: {
				handshakesPerSec: 1000,
				handshakesBurst: 1000,
				handshakesBurstPerPrefix: 1000,
			},
			onSession: () => {},
		});
		const dir = mkdtempSync(join(tmpdir(), "wt-close-on-exit-"));
		try {
			const script = join(dir, "client.ts");
			writeFileSync(
				script,
				`import { connect } from ${JSON.stringify(INDEX)};
const url = "https://127.0.0.1:${server.address.port}/";
const sessions = await Promise.all(
	Array.from({ length: 20 }, () => connect(url, { tls: { insecureSkipVerify: true } })),
);
console.log("connected", sessions.length);
for (const s of sessions) s.close();
process.exit(0);
`,
			);
			const child = Bun.spawn([process.execPath, script], {
				env: {
					...process.env,
					WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN: "1",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const exited = await Promise.race([child.exited, Bun.sleep(20_000)]);
			if (exited === undefined) child.kill();
			expect(exited).toBe(0);
			expect(await new Response(child.stdout).text()).toContain("connected 20");

			const deadline = Date.now() + 5000;
			while (
				server.metricsSnapshot().sessionsActive > 0 &&
				Date.now() < deadline
			) {
				await Bun.sleep(50);
			}
			expect(server.metricsSnapshot().sessionsActive).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			await server.close();
			cert.cleanup();
		}
	}, 40_000);
});
