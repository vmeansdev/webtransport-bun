import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// A wasm build whose ring C code was not compiled for wasm32 leaves
// `require("env")` in the glue. loadWasmModule() must surface that load error
// instead of reporting the artifact as missing.
const root = mkdtempSync(join(tmpdir(), "wt-load-wasm-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("loadWasmModule reports why a present wasm-dist artifact failed to load", async () => {
	cpSync(fileURLToPath(new URL("../src", import.meta.url)), join(root, "src"), {
		recursive: true,
	});
	const glueDir = join(root, "wasm-dist", "node");
	mkdirSync(glueDir, { recursive: true });
	writeFileSync(
		join(glueDir, "package.json"),
		'{"private":true,"type":"commonjs"}\n',
	);
	writeFileSync(
		join(glueDir, "webtransport_wasm.js"),
		'const import1 = require("env");\nmodule.exports = {};\n',
	);

	const { loadWasmModule } = await import(join(root, "src", "wasm.ts"));
	const err = await loadWasmModule().then(
		() => null,
		(e: unknown) => e,
	);
	expect(err).toBeInstanceOf(Error);
	const message = (err as Error).message;
	expect(message).toContain("build:wasm:dist");
	expect(message).toMatch(/['"]env['"]/);
	expect(message).not.toContain("not found:");
});
