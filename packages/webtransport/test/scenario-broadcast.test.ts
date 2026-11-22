import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBroadcastClients } from "../../../examples/scenarios/broadcast/client.js";
import { startBroadcastServer } from "../../../examples/scenarios/broadcast/server.js";
import { generateDevTls } from "../../../examples/scenarios/shared/dev-tls.js";

const SERVER_CLI = resolve(
	import.meta.dir,
	"../../../examples/scenarios/broadcast/server.ts",
);

// Reads a child's stdout into lines in the background, so every wait on it
// can be bounded by a deadline instead of awaiting the stream.
function collectLines(stream: ReadableStream<Uint8Array>): string[] {
	const lines: string[] = [];
	let partial = "";
	const decoder = new TextDecoder();
	void (async () => {
		for await (const chunk of stream) {
			partial += decoder.decode(chunk, { stream: true });
			const parts = partial.split("\n");
			partial = parts.pop() ?? "";
			lines.push(...parts);
		}
	})().catch(() => {});
	return lines;
}

async function waitForLine(
	lines: string[],
	match: (line: string) => boolean,
	timeoutMs: number,
	from = 0,
): Promise<string> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		const line = lines.slice(from).find(match);
		if (line !== undefined) return line;
		await Bun.sleep(25);
	}
	throw new Error(
		`no matching line within ${timeoutMs} ms: ${lines.join(" | ")}`,
	);
}

// Keeps docs/scenarios/broadcast.md's example runnable. It checks that the
// example works end to end at a small scale, not how fast it is: the
// runbook's numbers come from dedicated hardware, not from this test.
describe("scenario example: broadcast", () => {
	it("delivers every tick to a small fleet with the unpaced mirror", async () => {
		const tls = generateDevTls();
		const ticker = startBroadcastServer({
			port: 0,
			host: "127.0.0.1",
			tls,
			mode: "mirror",
			hz: 10,
			rateLimits: { handshakesPerSec: 1000, handshakesBurst: 1000 },
		});
		try {
			const report = await runBroadcastClients({
				url: `https://127.0.0.1:${ticker.port}/ticker`,
				caPem: tls.caPem,
				subscribers: 20,
				durationMs: 2500,
			});
			expect(report.connectFailures).toBe(0);
			expect(report.subscribers).toBe(20);
			expect(report.silentSessions).toBe(0);
			expect(report.received).toBeGreaterThan(0);
			expect(report.delivery).toBeGreaterThan(0.5);
			const stats = ticker.stats();
			expect(stats.ticks).toBeGreaterThan(0);
			expect(stats.accepted).toBeGreaterThan(0);
			expect(stats.queueFull).toBe(0);
		} finally {
			await ticker.close();
		}
	}, 30_000);

	// The egress pacer is process-wide and its first configuration wins, so
	// the paced server runs as the example's own CLI in a child process rather
	// than claiming the pacer for every other test in this one.
	it("delivers every tick to a small fleet through the egress pacer", async () => {
		const tls = generateDevTls();
		const dir = mkdtempSync(join(tmpdir(), "wt-broadcast-test-"));
		writeFileSync(join(dir, "cert.pem"), tls.certPem);
		writeFileSync(join(dir, "key.pem"), tls.keyPem);
		const child = Bun.spawn(
			[
				process.execPath,
				SERVER_CLI,
				"--port=0",
				"--host=127.0.0.1",
				"--mode=paced",
				"--hz=10",
				"--pps=2000",
			],
			{
				env: {
					...process.env,
					CERT_PEM: join(dir, "cert.pem"),
					KEY_PEM: join(dir, "key.pem"),
				},
				stdout: "pipe",
				stderr: "inherit",
			},
		);
		const lines = collectLines(child.stdout);
		try {
			const banner = await waitForLine(
				lines,
				(line) => line.startsWith("broadcast server on "),
				15_000,
			);
			const port = Number(/:(\d+) /.exec(banner)?.[1]);
			const report = await runBroadcastClients({
				url: `https://127.0.0.1:${port}/ticker`,
				caPem: tls.caPem,
				subscribers: 20,
				durationMs: 2500,
			});
			expect(report.connectFailures).toBe(0);
			expect(report.subscribers).toBe(20);
			expect(report.silentSessions).toBe(0);
			expect(report.delivery).toBeGreaterThan(0.5);

			// The CLI prints its counters every 5 s. Read the next line rather
			// than sending SIGINT: Windows has no signals, so a SIGINT handler
			// never runs there and the child is simply terminated.
			const seen = lines.length;
			const final = JSON.parse(
				await waitForLine(lines, (line) => line.startsWith("{"), 10_000, seen),
			);
			expect(final.mode).toBe("paced");
			expect(final.accepted).toBeGreaterThan(0);
			expect(final.refused).toBe(0);
			expect(final.datagramMirrorPacedCalls).toBeGreaterThan(0);
			expect(final.datagramMirrorCalls).toBe(0);
		} finally {
			child.kill("SIGKILL");
			await Promise.race([child.exited, Bun.sleep(5000)]);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
