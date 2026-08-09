import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

function functionBodies(implementation: string, name: string): string[] {
	const bodies: string[] = [];
	const marker = `pub async fn ${name}`;
	let cursor = 0;
	while (true) {
		const found = implementation.indexOf(marker, cursor);
		if (found < 0) break;
		cursor = found;
		const start = implementation.indexOf("{", cursor);
		let depth = 0;
		for (let i = start; i < implementation.length; i++) {
			if (implementation[i] === "{") depth++;
			if (implementation[i] === "}") depth--;
			if (depth === 0) {
				bodies.push(implementation.slice(start, i + 1));
				cursor = i + 1;
				break;
			}
		}
	}
	return bodies;
}

describe("engine-owned payload source contract", () => {
	it("allocates engine storage only during N-API value conversion", () => {
		const implementation = source("crates/native/src/engine_owned_payload.rs");
		expect(implementation).toContain("impl ToNapiValue for EngineOwnedPayload");
		expect(implementation).toContain("Env::from_raw(raw_env)");
		expect(implementation).toContain("env.create_arraybuffer(length)");
		expect(implementation).not.toContain("create_external_arraybuffer");
		expect(implementation).not.toContain("create_arraybuffer_with_data");
		expect(implementation).not.toContain("napi_create_external_buffer");
	});

	it("keeps async owned reads free of JS values and external Buffer conversion", () => {
		for (const path of [
			"crates/native/src/client.rs",
			"crates/native/src/client_stream.rs",
		]) {
			const implementation = source(path);
			const ownedReads = [
				...functionBodies(implementation, "read_datagram_owned"),
				...functionBodies(implementation, "read_owned"),
			];
			expect(ownedReads.length).toBeGreaterThan(0);
			for (const body of ownedReads) {
				expect(body).toContain("EngineOwnedPayload");
				expect(body).not.toContain("Env");
				expect(body).not.toContain("Buffer");
				expect(body).not.toContain("JsArrayBuffer");
			}
		}
		const serverBinding = source("crates/native/src/session_napi.rs");
		expect(serverBinding).toContain(
			"pub fn read_datagram_owned(&self, env: Env)",
		);
		expect(serverBinding).toContain("env.spawn_future(async move");
		expect(serverBinding).toContain("map(EngineOwnedPayload::new)");
	});

	it("routes every production receive surface through the owned dispatcher", () => {
		const index = source("packages/webtransport/src/index.ts");
		const streams = source("packages/webtransport/src/streams.ts");
		expect(
			index.match(/readNativePayload\(/g)?.length ?? 0,
		).toBeGreaterThanOrEqual(3);
		expect(streams.match(/readNativePayload\(/g)?.length).toBe(2);
		expect(index).toContain("assertNativePayloadOwnership(native)");
	});
});
