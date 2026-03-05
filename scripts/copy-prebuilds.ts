import { mkdir, readdir, rm, copyFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const sourceDir = path.join(root, "crates", "native");
const targetDir = path.join(root, "packages", "webtransport", "prebuilds");

const entries = await readdir(sourceDir, { withFileTypes: true });
const binaries = entries
	.filter((entry) => entry.isFile() && entry.name.endsWith(".node"))
	.map((entry) => entry.name)
	.sort();

await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });

for (const file of binaries) {
	await copyFile(path.join(sourceDir, file), path.join(targetDir, file));
}

console.log(
	`Copied ${binaries.length} prebuild binary(ies) to packages/webtransport/prebuilds`,
);
