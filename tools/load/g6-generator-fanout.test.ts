import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
	armsFanoutScript,
	demultiplexFanout,
	ownedFanoutScript,
} from "./g6-generator-fanout.ts";

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

test("fan-out keeps simultaneous long lines whole (no interleaving past PIPE_BUF)", async () => {
	// Every process prints large lines at the same instant (a shared go file),
	// as the realm processes print their final reports after the barrier.
	const n = 4;
	const go = join(mkdtempSync(join(tmpdir(), "g6-fanout-")), "go");
	const script = ownedFanoutScript(
		Array.from({ length: n }, (_, i) => [
			"python3",
			"-c",
			[
				"import os, sys, time",
				'print("macgen: binary=x", flush=True)',
				`while not os.path.exists(${JSON.stringify(go)}): time.sleep(0.005)`,
				`for k in range(5): sys.stdout.write("J${i}" + str(k) * 300000 + "\\n"); sys.stdout.flush()`,
				'sys.stdout.write("tail\\n")',
			].join("\n"),
		]),
	);
	const child = spawn("bash", ["-c", script], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const untagged: string[] = [];
	const clients = demultiplexFanout(child, n, (line) => untagged.push(line));
	const outs = Promise.all(
		clients.map(
			(client) =>
				new Promise<string[]>((resolve) => {
					const out: string[] = [];
					createInterface({ input: client.stdout }).on("line", (l) =>
						out.push(l),
					);
					client.once("exit", () => setTimeout(() => resolve(out), 20));
				}),
		),
	);
	setTimeout(() => writeFileSync(go, ""), 3000);
	const lines = await outs;
	expect(untagged.length).toBe(0);
	for (const [i, out] of lines.entries())
		expect(out).toEqual([
			"macgen: binary=x",
			...[0, 1, 2, 3, 4].map((k) => `J${i}${String(k).repeat(300_000)}`),
			"tail",
		]);
}, 20_000);

test("fan-out refuses fewer than two or more than sixteen processes", () => {
	expect(() => ownedFanoutScript([["true"]])).toThrow("2..16");
	expect(() =>
		ownedFanoutScript(Array.from({ length: 17 }, () => ["true"])),
	).toThrow("2..16");
});

test("arms fan-out runs the pre-checks first, stops the forwarder, and exits with the worst main status", async () => {
	const dir = `/tmp/g6-arms-precheck-test-${process.pid}-${Date.now()}`;
	const ready = `${dir}/forwarder-ready.json`;
	const order = `${dir}.order`;
	const step = (name: string, extra = "") =>
		`echo 'macgen: binary=${name}'; echo ${name} >> ${order}; ${extra}`;
	const script = armsFanoutScript({
		main: [
			["bash", "-c", `${step("main0")} echo out0`],
			["bash", "-c", `${step("main1")} exit 5`],
		],
		precheck: {
			dir,
			readyPath: ready,
			certPath: `${dir}/cert.pem`,
			keyPath: `${dir}/key.pem`,
			// The real forwarder is stopped by pkill; this stand-in exits.
			forwarder: [
				"bash",
				"-c",
				`${step("forwarder")} touch ${ready}; sleep 0.3; exit 143`,
			],
			floor: ["bash", "-c", `${step("floor")} echo floor-report`],
			sink: {
				subscriber: ["bash", "-c", `${step("sub")} sleep 0.2; echo sub-report`],
				publisher: ["bash", "-c", `${step("pub")} echo pub-report`],
			},
		},
	});
	const child = spawn("bash", ["-c", script], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const untagged: string[] = [];
	const clients = demultiplexFanout(child, 6, (line) => untagged.push(line));
	const outs = await Promise.all(
		clients.map(
			(client) =>
				new Promise<{ out: string[]; code: unknown }>((resolve) => {
					const out: string[] = [];
					createInterface({ input: client.stdout }).on("line", (l) =>
						out.push(l),
					);
					client.once("exit", (code) =>
						setTimeout(() => resolve({ out, code }), 20),
					);
				}),
		),
	);
	const { readFileSync, rmSync, existsSync } = await import("node:fs");
	const ran = readFileSync(order, "utf8").trim().split("\n");
	rmSync(order, { force: true });
	// Forwarder, floor, then the sink pair; the main processes only after.
	expect(ran.slice(0, 2)).toEqual(["forwarder", "floor"]);
	expect(new Set(ran.slice(2, 4))).toEqual(new Set(["sub", "pub"]));
	expect(ran.slice(4)).toEqual(["main0", "main1"]);
	expect(outs[0]?.out).toEqual(["macgen: binary=main0", "out0"]);
	expect(outs[1]?.out).toEqual(["macgen: binary=main1"]);
	expect(outs[2]?.out).toEqual([
		"macgen: binary=forwarder",
		"precheck: rc=143",
	]);
	expect(outs[3]?.out).toEqual([
		"macgen: binary=floor",
		"floor-report",
		"precheck: rc=0",
	]);
	expect(outs[4]?.out.at(-1)).toBe("precheck: rc=0");
	expect(outs[5]?.out.at(-1)).toBe("precheck: rc=0");
	// The forwarder's deliberate stop never fails the cell; main 1's 5 does.
	expect(outs.map((o) => o.code)).toEqual([5, 5, 5, 5, 5, 5]);
	expect(existsSync(dir)).toBe(false);
	expect(untagged).toEqual([]);
}, 20_000);

test("arms fan-out confines the forwarder stop to its own session and dir", () => {
	const script = armsFanoutScript({
		main: [["true"]],
		precheck: {
			dir: "/tmp/g6-arms-precheck-x",
			readyPath: "/tmp/g6-arms-precheck-x/r",
			certPath: "/tmp/g6-arms-precheck-x/c",
			keyPath: "/tmp/g6-arms-precheck-x/k",
			forwarder: ["true"],
			floor: ["true"],
			sink: null,
		},
	});
	expect(script).toContain("pkill -TERM -s 0 -x g6-server");
	expect(script).not.toContain("pkill -f");
	expect(script).not.toContain("@@O3@@");
	expect(script).toContain(`trap 'rm -rf "$d" "$pre"' EXIT`);
	expect(() =>
		armsFanoutScript({
			main: [["true"]],
			precheck: {
				dir: "/tmp/elsewhere",
				readyPath: "/tmp/elsewhere/r",
				certPath: "c",
				keyPath: "k",
				forwarder: ["true"],
				floor: ["true"],
				sink: null,
			},
		}),
	).toThrow("pre-check dir");
});
