#!/usr/bin/env bun
/**
 * Probe: after one `_write` error, does the next `write()` ever call back?
 *
 * `BidiStream` is constructed with `autoDestroy: false`. The probe drives a
 * stream until a write fails with E_BACKPRESSURE_TIMEOUT (peer never reads),
 * then issues one more write and reports whether its callback fires.
 */

import type { Duplex } from "node:stream";
import {
	connect,
	createServer,
} from "../../packages/webtransport/src/index.ts";

const PORT = 27455;

const server = createServer({
	port: PORT,
	tls: { certPem: "", keyPem: "" },
	onSession: async (session: any) => {
		const accepted = (
			session.incomingBidirectionalStreams as ReadableStream<any>
		).getReader();
		for (;;) {
			const next = await accepted.read();
			if (next.done || !next.value) break;
			// Never read it: hold the flow-control window shut.
		}
	},
});
await Bun.sleep(500);

const client: any = await connect(`https://127.0.0.1:${PORT}`, {
	tls: { insecureSkipVerify: true },
	limits: { backpressureTimeoutMs: 1000 },
});
const duplex = (await client.createBidirectionalStream()) as Duplex;

const write = (i: number) =>
	new Promise<string>((resolve) => {
		const t0 = performance.now();
		duplex.write(Buffer.alloc(1402), (err) =>
			resolve(
				`write#${i} ${err ? `rejected(${err.message})` : "ok"} in ${Math.round(
					performance.now() - t0,
				)}ms`,
			),
		);
	});

let firstError = 0;
for (let i = 0; i < 20000; i += 1) {
	const r = await write(i);
	if (r.includes("rejected")) {
		console.error(r);
		firstError = i;
		break;
	}
}

const state = () =>
	`destroyed=${duplex.destroyed} writableEnded=${duplex.writableEnded} ` +
	`writableFinished=${duplex.writableFinished} errored=${!!(duplex as any).errored}`;
console.error(`after first error: ${state()}`);

const second = await Promise.race([
	write(firstError + 1),
	Bun.sleep(10000).then(() => "SECOND-WRITE-CALLBACK-NEVER-FIRED"),
]);
console.error(`second: ${second}`);

const ended = await Promise.race([
	new Promise<string>((resolve) => duplex.end(() => resolve("end-cb-fired"))),
	Bun.sleep(10000).then(() => "END-CALLBACK-NEVER-FIRED"),
]);
console.error(`end(): ${ended}  ${state()}`);

client.close?.();
await server.close();
process.exit(0);
