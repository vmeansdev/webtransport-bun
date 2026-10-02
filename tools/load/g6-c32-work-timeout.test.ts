import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireDefined } from "./g6-c32-freeze-model.ts";
import { startOwnedCommand } from "./g6-c32-operation.ts";
import { runWorkBoundedCommand } from "./g6-c32-work-timeout.ts";

function present(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}
async function waitAbsent(pid: number, milliseconds = 2500): Promise<void> {
	const deadline = performance.now() + milliseconds;
	while (present(pid) && performance.now() < deadline) await Bun.sleep(10);
	if (present(pid)) throw Error(`self-expiring fixture ${pid} did not exit`);
}
/**
 * A SIGKILLed descendant is briefly a zombie until its reparented parent reaps
 * it, and kill(pid, 0) still succeeds for a zombie on macOS. Allow only that
 * reap window (far below the fixture's 1500 ms self-expiry) before asserting
 * the owned child is gone.
 */
async function reapedPromptly(pid: number): Promise<boolean> {
	const deadline = performance.now() + 250;
	while (present(pid) && performance.now() < deadline) await Bun.sleep(5);
	return !present(pid);
}
function leaderFixture(code: number | null) {
	const root = mkdtempSync(join(tmpdir(), "g6-work-owned-")),
		ready = join(root, "ready.json"),
		nonce = randomUUID();
	const child = `require("node:fs").writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,nonce:${JSON.stringify(nonce)}}));process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(0),1500);`;
	const leader = `const {spawn}=require("node:child_process");const {existsSync}=require("node:fs");const child=spawn(process.execPath,["-e",${JSON.stringify(child)}],{stdio:"ignore"});child.unref();const until=Date.now()+1000;const ready=()=>{if(existsSync(${JSON.stringify(ready)})){${code === null ? "setTimeout(()=>process.exit(0),2000);return;" : `process.exit(${code});`}}if(Date.now()>until)process.exit(89);setTimeout(ready,5);};ready();`;
	return {
		root,
		ready,
		argv: [process.execPath, "-e", leader],
		pid: () => {
			const packet = JSON.parse(readFileSync(ready, "utf8"));
			if (
				!Number.isSafeInteger(packet.pid) ||
				packet.pid < 2 ||
				packet.nonce !== nonce
			)
				throw Error("invalid fixture owner");
			return packet.pid as number;
		},
		async cleanup() {
			if (existsSync(ready)) {
				const packet = JSON.parse(readFileSync(ready, "utf8"));
				if (
					packet.nonce !== nonce ||
					!Number.isSafeInteger(packet.pid) ||
					packet.pid < 2
				)
					throw Error("invalid fixture cleanup owner");
				await waitAbsent(packet.pid);
			}
			rmSync(root, { recursive: true });
		},
	};
}

for (const code of [0, 37])
	test(`ordinary leader exit ${code} joins its stdio-detached same-group child`, async () => {
		const fixture = leaderFixture(code);
		try {
			const status = await runWorkBoundedCommand(
				fixture.argv,
				new Date(Date.now() + 1000).toISOString(),
			);
			expect(status).toBe(code);
			expect(await reapedPromptly(fixture.pid())).toBe(true);
		} finally {
			await fixture.cleanup();
		}
	}, 4000);

test("nested production supervisor cannot report successful cleanup while inner-owned child remains", async () => {
	const fixture = leaderFixture(0);
	try {
		const wrapper = `import {runWorkBoundedCommand} from ${JSON.stringify(`${import.meta.dir}/g6-c32-work-timeout.ts`)};process.exitCode=await runWorkBoundedCommand(${JSON.stringify(fixture.argv)},new Date(Date.now()+1000).toISOString());`;
		const result = await startOwnedCommand(
			{
				operationId: "nested-work",
				phase: "LOCAL_GATES",
				command: process.execPath,
				args: ["-e", wrapper],
				cwd: ".",
				env: {},
				stdin: "ignore",
				timeoutMs: 3000,
			},
			process.cwd(),
		).result;
		expect(result.status).toEqual({
			outcome: "SUCCEEDED",
			exitCode: 0,
			signal: null,
		});
		expect(result.ownership.cleanupComplete).toBe(true);
		expect(await reapedPromptly(fixture.pid())).toBe(true);
	} finally {
		await fixture.cleanup();
	}
}, 5000);

test("nested outer cancellation kills a wrapper during inner cleanup without leaving its child", async () => {
	const fixture = leaderFixture(null);
	try {
		const stoppedPath = join(fixture.root, "wrapper-stopped");
		const wrapper = `import {runWorkBoundedCommand} from ${JSON.stringify(`${import.meta.dir}/g6-c32-work-timeout.ts`)};process.once("SIGTERM",()=>setImmediate(()=>{require("node:fs").writeFileSync(${JSON.stringify(stoppedPath)},"stopping during inner cleanup");process.kill(process.pid,"SIGSTOP");}));process.exitCode=await runWorkBoundedCommand(${JSON.stringify(fixture.argv)},new Date(Date.now()+3000).toISOString());`;
		const handle = startOwnedCommand(
			{
				operationId: "nested-abort",
				phase: "LOCAL_GATES",
				command: process.execPath,
				args: ["-e", wrapper],
				cwd: ".",
				env: {},
				stdin: "ignore",
				timeoutMs: 3000,
			},
			process.cwd(),
		);
		const readyUntil = performance.now() + 1000;
		while (!existsSync(fixture.ready) && performance.now() < readyUntil)
			await Bun.sleep(5);
		expect(existsSync(fixture.ready)).toBe(true);
		const abortedAt = performance.now();
		handle.cancel();
		const result = await handle.result;
		expect(result.status.outcome).toBe("CANCELLED");
		expect(result.ownership.cleanupComplete).toBe(true);
		expect(existsSync(stoppedPath)).toBe(true);
		expect(performance.now() - abortedAt).toBeLessThan(600);
		// Outer group flags alone are not proof about the separately owned group.
		expect(await reapedPromptly(fixture.pid())).toBe(true);
	} finally {
		await fixture.cleanup();
	}
}, 5000);

test("repeated abort signals cannot terminate the watchdog before owned cleanup", async () => {
	const hanging =
		'process.on("SIGTERM",()=>{}); console.log(process.pid); setTimeout(()=>process.exit(0),1500)';
	const wrapper = spawn(
		process.execPath,
		[
			"-e",
			`import {runWorkBoundedCommand} from ${JSON.stringify(`${import.meta.dir}/g6-c32-work-timeout.ts`)}; process.exitCode=await runWorkBoundedCommand(${JSON.stringify([process.execPath, "-e", hanging])},new Date(Date.now()+5000).toISOString());`,
		],
		{ detached: true, stdio: ["ignore", "pipe", "pipe"] },
	);
	let group: number | undefined;
	const closed = new Promise<{ code: number | null; signal: string | null }>(
		(resolve, reject) => {
			wrapper.once("error", reject);
			wrapper.once("close", (code, signal) => resolve({ code, signal }));
		},
	);
	try {
		group = await new Promise<number>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(Error("owned child startup timed out")),
				2000,
			);
			let output = "";
			requireDefined(wrapper.stdout).on("data", (chunk) => {
				output += String(chunk);
				if (/^\d+\n/.test(output)) {
					clearTimeout(timer);
					resolve(Number(output.split("\n")[0]));
				}
			});
		});
		wrapper.kill("SIGTERM");
		await Bun.sleep(20);
		wrapper.kill("SIGTERM");
		wrapper.kill("SIGINT");
		wrapper.kill("SIGHUP");
		const result = await Promise.race([
			closed,
			Bun.sleep(2000).then(() => {
				throw Error("owned cleanup timed out");
			}),
		]);
		expect(result).toEqual({ code: 143, signal: null });
		expect(present(requireDefined(group))).toBe(false);
	} finally {
		wrapper.kill("SIGKILL");
		await Promise.race([closed, Bun.sleep(1000)]);
		if (group) await waitAbsent(group);
	}
}, 6000);

test("expired whole-cell clock starts no child", async () => {
	expect(
		await runWorkBoundedCommand(
			["does-not-exist"],
			new Date(Date.now() - 1).toISOString(),
		),
	).toBe(124);
});

test("CLI forwards literal argv, environment, cwd, stdin and exact independent output", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "g6-work-cli-")));
	const args = ["literal space", "a'b\"c", "--", "$notExpanded"];
	const source =
		'let input="";for await(const chunk of process.stdin)input+=String(chunk);process.stdout.write(JSON.stringify({args:process.argv.slice(1),env:process.env.G6_WRAPPER_FIXTURE,cwd:process.cwd(),input}));process.stderr.write(Buffer.from([0,255,10,67]));';
	const wrapper = spawn(
		process.execPath,
		[
			resolve(import.meta.dir, "g6-c32-work-timeout.ts"),
			new Date(Date.now() + 2000).toISOString(),
			"--",
			process.execPath,
			"-e",
			source,
			"--",
			...args,
		],
		{
			cwd: root,
			env: { G6_WRAPPER_FIXTURE: "literal fixture value" },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const stdout: Buffer[] = [],
		stderr: Buffer[] = [];
	wrapper.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	wrapper.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
	const closed = new Promise<number | null>((resolve) =>
		wrapper.once("close", resolve),
	);
	try {
		wrapper.stdin.end("exact input\n");
		const outcome = await Promise.race([
			closed,
			Bun.sleep(2500).then(() => {
				throw Error("CLI did not finish its original clock");
			}),
		]);
		expect(outcome).toBe(0);
		expect(JSON.parse(Buffer.concat(stdout).toString())).toEqual({
			args,
			env: "literal fixture value",
			cwd: root,
			input: "exact input\n",
		});
		expect(Buffer.concat(stderr)).toEqual(Buffer.from([0, 255, 10, 67]));
	} finally {
		wrapper.kill("SIGKILL");
		await Promise.race([closed, Bun.sleep(1000)]);
		rmSync(root, { recursive: true });
	}
}, 5000);

test("CLI blocked downstream output cannot keep it alive after the original cutoff", async () => {
	const start = performance.now();
	const wrapper = spawn(
		process.execPath,
		[
			resolve(import.meta.dir, "g6-c32-work-timeout.ts"),
			new Date(Date.now() + 500).toISOString(),
			"--",
			process.execPath,
			"-e",
			"process.stdout.write(Buffer.alloc(8*1024*1024,120));setTimeout(()=>process.exit(0),2000);",
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	// Deliberately leave stdout unread: neither buffering nor an exit-code-only
	// assignment may let this nested CLI outlive the one supplied cutoff.
	wrapper.stderr.resume();
	const exited = new Promise<{ code: number | null; signal: string | null }>(
		(resolve) =>
			wrapper.once("exit", (code, signal) => resolve({ code, signal })),
	);
	try {
		const outcome = await Promise.race([
			exited,
			Bun.sleep(1000).then(() => {
				throw Error("blocked CLI exceeded original cutoff");
			}),
		]);
		expect(outcome.code).not.toBe(0);
		expect(outcome.signal).toBeNull();
		expect(performance.now() - start).toBeLessThan(850);
	} finally {
		wrapper.kill("SIGKILL");
		wrapper.stdout.destroy();
		wrapper.stderr.destroy();
		await Promise.race([exited, Bun.sleep(1000)]);
	}
}, 2500);

test("absolute deadline bounds a hanging child and preserves ordinary failure", async () => {
	const start = performance.now();
	expect(
		await runWorkBoundedCommand(
			[process.execPath, "-e", "setInterval(()=>{},1000)"],
			new Date(Date.now() + 100).toISOString(),
		),
	).toBe(124);
	expect(performance.now() - start).toBeLessThan(2000);
	expect(
		await runWorkBoundedCommand(
			[process.execPath, "-e", "process.exit(19)"],
			new Date(Date.now() + 2000).toISOString(),
		),
	).toBe(19);
}, 5000);
