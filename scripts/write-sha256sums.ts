import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const inputDirArg = process.argv[2];
const inputDir = inputDirArg
	? path.resolve(root, inputDirArg)
	: path.join(root, "packages", "webtransport", "prebuilds");

const entries = await readdir(inputDir, { withFileTypes: true });
const files = entries
	.filter((entry) => entry.isFile() && entry.name.endsWith(".node"))
	.map((entry) => entry.name)
	.sort();

const lines: string[] = [];
for (const file of files) {
	const content = await readFile(path.join(inputDir, file));
	const checksum = createHash("sha256").update(content).digest("hex");
	lines.push(`${checksum}  ${file}`);
}

await writeFile(
	path.join(inputDir, "SHA256SUMS"),
	`${lines.join("\n")}\n`,
	"utf8",
);
console.log(
	`Wrote SHA256SUMS for ${files.length} binary file(s) in ${inputDir}`,
);
