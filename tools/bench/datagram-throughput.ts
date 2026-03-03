#!/usr/bin/env bun
/**
 * Datagram throughput benchmark. Phase 10.
 * Connects to addon server, sends datagrams, measures throughput and latency.
 */

import { createServer } from "../../packages/webtransport/src/index.ts";
import { $ } from "bun";

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/release/load-client`;

async function main() {
	try {
		const p = await $`lsof -ti :4433`.quiet().nothrow().text();
		if (p.trim())
			await $`kill -9 ${p.trim().split(/\s+/).filter(Boolean)}`
				.quiet()
				.nothrow();
	} catch (err) {
		console.warn("datagram-throughput: port cleanup failed:", err);
	}
	await Bun.sleep(2000);

	await $`cd ${ROOT} && cargo build -p reference --bin load-client --release`.quiet();

	const server = createServer({
		port: 4433,
		tls: { certPem: "", keyPem: "" },
		onSession: () => {},
	});
	await Bun.sleep(6000);

	const start = performance.now();
	const client = Bun.spawn(
		[
			CLIENT_BIN,
			"--url",
			"https://127.0.0.1:4433",
			"--sessions",
			"4",
			"--duration",
			"10",
			"--datagrams-per-sec",
			"1000",
			"--streams-per-sec",
			"0",
		],
		{ cwd: ROOT, stdout: "pipe", stderr: "pipe" },
	);
	const out = await new Response(client.stdout).text();
	await client.exited;
	const elapsed = (performance.now() - start) / 1000;
	await server.close();

	const match = out.match(/datagrams sent=(\d+)/);
	const sent = match?.[1] ? parseInt(match[1], 10) : 0;
	const throughput = sent / elapsed;
	console.log(
		"datagram-throughput: sent=",
		sent,
		"elapsed=",
		elapsed.toFixed(2),
		"s",
		"throughput=",
		throughput.toFixed(0),
		"dgram/s",
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
