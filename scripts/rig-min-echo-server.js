// Minimal WebSocket echo server for the rig-measurement path.
// Bypasses the campaign framework's WS adapter (whose handshake
// did not complete in the rig environment) and does raw Bun.serve
// + upgrade + echo. The campaign framework is layered on top of this
// in a follow-up; the goal of this iteration is to produce a real
// number on the rig.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const cert = readFileSync(`${homedir()}/.ws-wt-tls/server.crt`, "utf8");
const key = readFileSync(`${homedir()}/.ws-wt-tls/server.key`, "utf8");
const port = Number(process.env.RIG_ECHO_PORT ?? 4446);
const bind = process.env.RIG_ECHO_BIND ?? "10.99.0.2";

Bun.serve({
	port,
	hostname: bind,
	tls: { cert, key, serverName: "gravvene-dev-home" },
	fetch(req, server) {
		const url = new URL(req.url);
		if (server.upgrade(req, { data: { path: url.pathname } })) {
			return;
		}
		return new Response("WebSocket upgrade required", { status: 426 });
	},
	websocket: {
		open(ws) {
			// eslint-disable-next-line no-console
			console.log("open", ws.data?.path);
		},
		message(ws, msg) {
			ws.send(msg);
		},
		close(ws) {
			// eslint-disable-next-line no-console
			console.log("close", ws.data?.path);
		},
	},
});
// eslint-disable-next-line no-console
console.log(`rig-echo-server listening on wss://${bind}:${port}`);
