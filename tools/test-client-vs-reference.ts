#!/usr/bin/env bun
/**
 * Test addon client against reference Rust server (bidi echo).
 * Run: cargo run --bin reference-server &
 * bun tools/test-client-vs-reference.ts
 */
import { connect } from "../packages/webtransport/src/index.ts";

const client = await connect("https://127.0.0.1:4433", {
    tls: { insecureSkipVerify: true },
});
const bidi = await client.createBidirectionalStream();
const payload = Buffer.from("hello-from-addon-client");
bidi.write(payload);
bidi.end();

const chunks: Buffer[] = [];
for await (const c of bidi) chunks.push(c);
const got = Buffer.concat(chunks);
if (got.toString() !== payload.toString()) {
    console.error("FAIL: expected", payload.toString(), "got", got.toString());
    process.exit(1);
}
console.log("OK: bidi echo works with reference server");
client.close();
