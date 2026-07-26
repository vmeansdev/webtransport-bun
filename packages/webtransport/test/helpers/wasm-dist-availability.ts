import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Shipped Node wasm-bindgen glue from `bun run build:wasm:dist`. */
export const wasmDistNodePath = fileURLToPath(
	new URL("../../wasm-dist/node/webtransport_wasm.js", import.meta.url),
);

export function isWasmDistRequired(): boolean {
	return process.env.WEBTRANSPORT_REQUIRE_WASM_DIST === "1";
}

export const wasmDistAvailable = existsSync(wasmDistNodePath);

if (isWasmDistRequired() && !wasmDistAvailable) {
	throw new Error(
		`WEBTRANSPORT_REQUIRE_WASM_DIST=1 but wasm-dist is missing at ${wasmDistNodePath}. ` +
			"Run `bun run build:wasm:dist` before the dist behavioral suite.",
	);
}
