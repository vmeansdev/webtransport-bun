import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { WasmModule } from "../../src/backend-wasm.js";

/** Node wasm-bindgen glue produced by `crates/wasm/build-wasm.sh` (pkg mode). */
export const wasmPkgPath = fileURLToPath(
	new URL("../../../../crates/wasm/pkg/webtransport_wasm.js", import.meta.url),
);

export function isWasmRequired(): boolean {
	return process.env.WEBTRANSPORT_REQUIRE_WASM === "1";
}

export const wasmAvailable = existsSync(wasmPkgPath);

if (isWasmRequired() && !wasmAvailable) {
	throw new Error(
		`WEBTRANSPORT_REQUIRE_WASM=1 but wasm pkg is missing at ${wasmPkgPath}. ` +
			"Run `bun run build:wasm` before the wasm suite.",
	);
}

export async function loadWasmModule(): Promise<WasmModule> {
	if (!wasmAvailable) {
		throw new Error(`wasm pkg missing at ${wasmPkgPath}`);
	}
	return (await import(wasmPkgPath)) as unknown as WasmModule;
}
