import { createServer } from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";

const cert = generateLocalhostCert();
if (!cert) throw new Error("failed to generate test certificate");
const server = createServer({
	port: 0,
	tls: { certPem: cert.certPem, keyPem: cert.keyPem },
	limits: { maxSessions: 200, maxHandshakesInFlight: 256 },
	rateLimits: {
		handshakesPerSec: 500,
		handshakesBurst: 1000,
		handshakesBurstPerPrefix: 1000,
		streamsPerSec: 1000,
		streamsBurst: 2000,
		datagramsPerSec: 10000,
		datagramsBurst: 20000,
	},
	onSession: () => undefined,
});
const sample = (label: string) => {
	const memory = process.memoryUsage();
	console.log(
		JSON.stringify({
			label,
			rssMb: Number((memory.rss / 1024 / 1024).toFixed(3)),
			heapUsedMb: Number((memory.heapUsed / 1024 / 1024).toFixed(3)),
			externalMb: Number((memory.external / 1024 / 1024).toFixed(3)),
		}),
	);
};
sample("service-ready");
const durationSec = process.env.RSS_NOHANDLER_DURATION ?? "15";
const child = Bun.spawn(
	[
		`${process.cwd()}/target/release/load-client`,
		"--url",
		`https://127.0.0.1:${server.address.port}`,
		"--sessions",
		"200",
		"--duration",
		durationSec,
		"--datagrams-per-sec",
		"0",
		"--streams-per-sec",
		"5",
		"--max-session-errors",
		"0",
		"--max-datagram-errors",
		"0",
		"--max-stream-errors",
		"0",
		"--skip-probes",
	],
	{ stdout: "pipe", stderr: "pipe" },
);
const [stdout, stderr, exitCode] = await Promise.all([
	new Response(child.stdout).text(),
	new Response(child.stderr).text(),
	child.exited,
]);
console.log(stdout.trim());
console.error(stderr.trim());
console.log(JSON.stringify({ exitCode }));
sample("pre-close");
console.log(
	JSON.stringify({
		label: "pre-close-metrics",
		metrics: server.metricsSnapshot(),
	}),
);
await server.close();
await Bun.sleep(250);
sample("post-close");
await Bun.sleep(Number(process.env.RSS_NOHANDLER_HOLD_MS ?? "60000"));
cert.cleanup();
