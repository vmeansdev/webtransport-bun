// Minimal WebTransport echo server for the WS↔WT comparison harness.
// Uses the @webtransport-bun/webtransport createServer API. Each
// incoming datagram is echoed back via sendDatagram, matching the WS
// echo server's behavior so RTT samples are apples-to-apples across
// transports. The server is launched on the rig (or locally for the
// Mac-vs-Mac comparison) via systemd-run so it survives the SSH
// session closing.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createServer } from "@webtransport-bun/webtransport";

const cert = readFileSync(`${homedir()}/.ws-wt-tls/server.crt`, "utf8");
const key = readFileSync(`${homedir()}/.ws-wt-tls/server.key`, "utf8");
const port = Number(process.env.RIG_WT_ECHO_PORT ?? 4447);
const bind = process.env.RIG_WT_ECHO_BIND ?? "10.99.0.2";

const server = createServer({
	port,
	host: bind,
	tls: { certPem: cert, keyPem: key, allowSelfSigned: true },
	onSession: async (session) => {
		// eslint-disable-next-line no-console
		console.log("session open");
		try {
			for await (const datagram of session.incomingDatagrams()) {
				await session.sendDatagram(datagram);
			}
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("echo error", err);
		} finally {
			// eslint-disable-next-line no-console
			console.log("session closed");
		}
	},
});

// eslint-disable-next-line no-console
console.log(`wt-echo-server listening on https://${bind}:${port}`);

const shutdown = async () => {
	// eslint-disable-next-line no-console
	console.log("shutting down");
	try {
		await server.close();
	} catch {
		// ignore
	}
	process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
