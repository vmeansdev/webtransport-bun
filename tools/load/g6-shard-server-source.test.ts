import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
	join(import.meta.dir, "g6-shard-server.ts"),
	"utf8",
);

describe("G6 shard server source-bound configuration", () => {
	test("attests a coherent explicit emitter mode", () => {
		expect(source).toContain('requireArg("emitter-mode")');
		expect(source).toContain("resolveEmitterMode");
		expect(source).toContain("emitterMode");
		expect(source).toContain("server.sendDatagramMirror");
	});

	test("uses the tested fatal scheduler to emit a fatal event", () => {
		expect(source).toContain("createFatalEmitterScheduler");
		expect(source).toContain('ev: "fatal"');
		expect(source).toContain("process.exit(1)");
	});
});
