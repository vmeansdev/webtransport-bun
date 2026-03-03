#!/usr/bin/env bun
/**
 * Debug bidi echo: logs each step.
 */
import { connect, createServer } from "../packages/webtransport/src/index.ts";

const server = createServer({
	port: 14460,
	tls: { certPem: "", keyPem: "" },
	onSession: async (s) => {
		console.log("[server] session accepted");
		void (async () => {
			for await (const duplex of s.incomingBidirectionalStreams) {
				const chunks: Uint8Array[] = [];
				for await (const c of duplex.readable) chunks.push(c);
				if (chunks.length > 0) {
					const writer = duplex.writable.getWriter();
					await writer.write(Buffer.concat(chunks.map((c) => Buffer.from(c))));
					await writer.close();
					console.log("[server] echoed");
				}
			}
		})().catch((err) => {
			console.error("[server] incoming bidi loop failed", err);
		});
	},
});
await Bun.sleep(2000);
console.log("[client] connecting");
const client = await connect("https://127.0.0.1:14460", {
	tls: { insecureSkipVerify: true },
});
console.log("[client] connected");

console.log("[client] createBidirectionalStream");
const bidi = await client.createBidirectionalStream();
console.log("[client] created");

const payload = Buffer.from("hello");
console.log("[client] writing");
await new Promise<void>((resolve, reject) => {
	bidi.write(payload, (err: Error | null | undefined) =>
		err ? reject(err) : resolve(),
	);
});
console.log("[client] write done");
await new Promise<void>((resolve, reject) => {
	bidi.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
});
console.log("[client] end done, reading...");

const chunks: Buffer[] = [];
for await (const c of bidi) {
	console.log("[client] got chunk", c.length);
	chunks.push(c);
}
console.log("[client] read done, chunks:", chunks.length);
if (Buffer.concat(chunks).toString() !== "hello") throw new Error("bad echo");
console.log("[client] OK");

await server.close();
console.log("done");
