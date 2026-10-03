import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { demultiplexFanout, ownedFanoutScript } from "./g6-generator-fanout.ts";

test("fan-out script starts every process in order and exits with the worst status", async () => {
	const script = ownedFanoutScript([
		[
			"bash",
			"-c",
			"echo 'macgen: binary=a'; echo out-a; echo err-a >&2; exit 0",
		],
		["bash", "-c", "echo 'macgen: binary=b'; echo \"it's b\"; exit 3"],
		["bash", "-c", "echo 'macgen: binary=c'; echo out-c"],
	]);
	const child = spawn("bash", ["-c", script], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const untagged: string[] = [];
	const clients = demultiplexFanout(child, 3, (line) => untagged.push(line));
	const lines = await Promise.all(
		clients.map(
			(client) =>
				new Promise<{ out: string[]; err: string[]; code: unknown }>(
					(resolve) => {
						const out: string[] = [];
						const err: string[] = [];
						createInterface({ input: client.stdout }).on("line", (l) =>
							out.push(l),
						);
						createInterface({ input: client.stderr }).on("line", (l) =>
							err.push(l),
						);
						client.once("exit", (code) =>
							setTimeout(() => resolve({ out, err, code }), 20),
						);
					},
				),
		),
	);
	expect(lines[0]?.out).toEqual(["macgen: binary=a", "out-a"]);
	expect(lines[0]?.err).toEqual(["err-a"]);
	expect(lines[1]?.out).toEqual(["macgen: binary=b", "it's b"]);
	expect(lines[2]?.out).toEqual(["macgen: binary=c", "out-c"]);
	expect(lines.map((l) => l.code)).toEqual([3, 3, 3]);
	expect(untagged).toEqual([]);
});

test("fan-out refuses fewer than two or more than sixteen processes", () => {
	expect(() => ownedFanoutScript([["true"]])).toThrow("2..16");
	expect(() =>
		ownedFanoutScript(Array.from({ length: 17 }, () => ["true"])),
	).toThrow("2..16");
});
