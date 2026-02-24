#!/usr/bin/env bun
/**
 * Test bidi echo: addon client vs addon server in SEPARATE process.
 * Run: bun tools/addon-server-bidi-only.ts &
 *      bun tools/test-bidi-addon-server.ts
 */
import { connect } from "../packages/webtransport/src/index.ts";

const client = await connect("https://127.0.0.1:4433", {
	tls: { insecureSkipVerify: true },
});
const bidi = await client.createBidirectionalStream();
const payload = Buffer.from("hello");
bidi.write(payload);
bidi.end();

const chunks: Buffer[] = [];
for await (const c of bidi) chunks.push(c);
const got = Buffer.concat(chunks);
if (got.toString() !== payload.toString()) {
	console.error("FAIL: expected", payload.toString(), "got", got.toString());
	process.exit(1);
}
console.log("OK: bidi echo works");
client.close();
