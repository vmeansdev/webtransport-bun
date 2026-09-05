import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { validateOperationReceipt } from "./g6-c32-freeze-model.ts";
import {
	BunCommandAdapter,
	type CampaignClock,
	type CommandAdapter,
	type CommandExecutionResult,
	type CommandSpec,
	isOwnedSupervisorToken,
	OWNED_COMMAND_OUTPUT_LIMIT_BYTES,
	recordOperation,
	startOwnedCommand,
	validateOperationStatusRecord,
} from "./g6-c32-operation.ts";

const temporaryRoots: string[] = [];

class FakeClock implements CampaignClock {
	readonly #wallTimes: string[];
	readonly #monotonicTimes: bigint[];

	constructor(wallTimes: string[], monotonicTimes: bigint[]) {
		this.#wallTimes = [...wallTimes];
		this.#monotonicTimes = [...monotonicTimes];
	}

	wallNow(): string {
		const value = this.#wallTimes.shift();
		if (!value) throw new Error("fake wall clock exhausted");
		return value;
	}

	monotonicNowNs(): bigint {
		const value = this.#monotonicTimes.shift();
		if (value === undefined) throw new Error("fake monotonic clock exhausted");
		return value;
	}
}

class FakeAdapter implements CommandAdapter {
	readonly seen: CommandSpec[] = [];
	readonly #results: CommandExecutionResult[];

	constructor(results: CommandExecutionResult[]) {
		this.#results = [...results];
	}

	async execute(spec: CommandSpec): Promise<CommandExecutionResult> {
		this.seen.push(spec);
		const result = this.#results.shift();
		if (!result) throw new Error("fake command results exhausted");
		return result;
	}
}

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "g6-c32-operation-"));
	temporaryRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function decoded(value: string | Uint8Array): string {
	return typeof value === "string" ? value : new TextDecoder().decode(value);
}

async function bounded<T>(
	promise: Promise<T>,
	milliseconds: number,
): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), milliseconds);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function descendantSpec(root: string, directExit = false): CommandSpec {
	const ready = join(root, "descendant-ready");
	const child = `import {writeFileSync} from "node:fs"; process.on("SIGTERM",()=>{}); writeFileSync(${JSON.stringify(ready)},String(process.pid)); process.stdout.write("descendant stdout\\n"); process.stderr.write("descendant stderr\\n"); setTimeout(()=>process.exit(0),2000); setInterval(()=>{},50);`;
	const parent = `import {spawn} from "node:child_process"; const child=spawn(process.execPath,["-e",${JSON.stringify(child)}],{stdio:["ignore","inherit","inherit"]}); process.stdout.write("parent stdout\\n"); ${directExit ? "setTimeout(()=>process.exit(37),100);" : 'child.on("exit",()=>process.exit(0));'}`;
	return {
		operationId: "owned-descendant",
		phase: "LOCAL_GATES",
		command: process.execPath,
		args: ["-e", parent],
		cwd: ".",
		env: {},
		timeoutMs: 600,
		stdin: "ignore",
	};
}

function processPresent(pid: number, group = false): boolean {
	try {
		process.kill(group ? -pid : pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
		throw error;
	}
}

async function waitUntil(
	check: () => boolean,
	milliseconds: number,
): Promise<boolean> {
	const deadline = performance.now() + milliseconds;
	while (!check() && performance.now() < deadline) await Bun.sleep(5);
	return check();
}

function autonomousFixture(
	mode: "startup" | "forwarding" | "frozen" | "signal-error" | "late-join",
) {
	const root = makeRoot(),
		ownerPath = join(root, "owner.json"),
		readyPath = join(root, "ready"),
		resultPath = join(root, "result.json");
	const target = `require("node:fs").writeFileSync(${JSON.stringify(readyPath)},String(process.pid));process.on("SIGTERM",()=>{});process.stdout.write("active output");${mode === "signal-error" || mode === "late-join" ? "" : "setTimeout(()=>process.exit(0),2000);"}`;
	const spec = {
		...descendantSpec(root),
		args: ["-e", target],
		timeoutMs: mode === "forwarding" ? 3000 : 1000,
	};
	const signalPatch =
		mode === "signal-error"
			? 'const originalKill=process.kill;process.kill=function(pid,signal){if(pid<0&&signal!==0)throw Object.assign(Error("fixture signal denied"),{code:"EPERM"});return originalKill.call(process,pid,signal);};'
			: mode === "late-join"
				? 'const originalKill=process.kill,originalNow=process.hrtime.bigint;process.kill=function(pid,signal){const result=originalKill.call(process,pid,signal);if(pid<0&&signal==="SIGKILL")process.hrtime.bigint=()=>originalNow()+2000000000n;return result;};'
				: "";
	const code = `import {startOwnedCommand} from ${JSON.stringify(`${import.meta.dir}/g6-c32-operation.ts`)};import {writeFileSync} from "node:fs";import {Writable} from "node:stream";${signalPatch}const sink=new Writable({write(_chunk,_encoding,_callback){}});const handle=startOwnedCommand(${JSON.stringify(spec)},${JSON.stringify(root)},undefined,${mode === "forwarding" ? "{forwardOutput:{stdout:sink,stderr:sink}}" : "{}"});writeFileSync(${JSON.stringify(ownerPath)},JSON.stringify({pid:handle.pid,token:handle.supervisorToken}));${mode === "startup" ? 'process.kill(process.pid,"SIGSTOP");' : ""}const result=await handle.result;writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(result));process.exit(result.status.outcome==="SUCCEEDED"?0:1);`;
	const driver = spawn(process.execPath, ["-e", code], { stdio: "ignore" });
	const closed = new Promise<void>((resolve) =>
		driver.once("close", () => resolve()),
	);
	const owner = () => {
		const value: unknown = JSON.parse(readFileSync(ownerPath, "utf8"));
		if (
			typeof value !== "object" ||
			value === null ||
			!("pid" in value) ||
			!("token" in value) ||
			!Number.isSafeInteger(value.pid) ||
			Number(value.pid) < 2 ||
			!isOwnedSupervisorToken(value.token)
		)
			throw Error("invalid fixture supervisor ownership");
		return { pid: Number(value.pid), token: value.token };
	};
	return {
		driver,
		closed,
		owner,
		ownerPath,
		readyPath,
		resultPath,
		async cleanup() {
			driver.kill("SIGCONT");
			driver.kill("SIGKILL");
			if ((await bounded(closed, 1000)) === null)
				throw Error("fixture driver did not join");
			if (!existsSync(ownerPath)) return;
			const identity = owner();
			if (await waitUntil(() => !processPresent(identity.pid, true), 250))
				return;
			// Failure cleanup signals only the still-live exact nonce-bearing anchor.
			const witness = spawnSync(
				"/bin/ps",
				["-ww", "-p", String(identity.pid), "-o", "pid=,pgid=,command="],
				{ encoding: "utf8", timeout: 1000 },
			);
			const ids = witness.stdout.match(/^\s*(\d+)\s+(\d+)\s/);
			if (
				witness.error ||
				witness.status !== 0 ||
				Number(ids?.[1]) !== identity.pid ||
				Number(ids?.[2]) !== identity.pid ||
				!witness.stdout.includes(`const supervisorToken="${identity.token}";`)
			)
				throw Error("fixture cleanup refuses unverified supervisor");
			process.kill(-identity.pid, "SIGKILL");
			if (!(await waitUntil(() => !processPresent(identity.pid, true), 1000)))
				throw Error("fixture supervisor did not disappear");
		},
	};
}

describe("real owned command lifecycle", () => {
	for (const mode of ["startup", "forwarding"] as const)
		test(`parent death during ${mode} immediately cleans the inner-owned group`, async () => {
			const fixture = autonomousFixture(mode);
			try {
				expect(
					await waitUntil(
						() =>
							existsSync(fixture.ownerPath) &&
							(mode === "startup" || existsSync(fixture.readyPath)),
						1500,
					),
				).toBe(true);
				const identity = fixture.owner();
				expect(processPresent(identity.pid, true)).toBe(true);
				fixture.driver.kill("SIGKILL");
				expect(
					await waitUntil(() => !processPresent(identity.pid, true), 250),
				).toBe(true);
				if (mode === "forwarding")
					expect(
						processPresent(Number(readFileSync(fixture.readyPath, "utf8"))),
					).toBe(false);
			} finally {
				await fixture.cleanup();
			}
		}, 4000);

	test("autonomous absolute cutoff cleans its group while the parent clock is suspended", async () => {
		const fixture = autonomousFixture("frozen");
		try {
			expect(await waitUntil(() => existsSync(fixture.readyPath), 1500)).toBe(
				true,
			);
			const identity = fixture.owner();
			fixture.driver.kill("SIGSTOP");
			const targetPid = Number(readFileSync(fixture.readyPath, "utf8"));
			expect(await waitUntil(() => !processPresent(targetPid), 1000)).toBe(
				true,
			);
			// The stopped parent cannot reap its zombie supervisor. Do not equate
			// that group's EPERM probe with absence or with a completed receipt.
			expect(existsSync(fixture.resultPath)).toBe(false);
			fixture.driver.kill("SIGCONT");
			expect(await bounded(fixture.closed, 1500)).not.toBeNull();
			const result = JSON.parse(readFileSync(fixture.resultPath, "utf8"));
			expect(result.status.outcome).not.toBe("SUCCEEDED");
			expect(
				await waitUntil(() => !processPresent(identity.pid, true), 200),
			).toBe(true);
		} finally {
			await fixture.cleanup();
		}
	}, 4000);

	test("signal refusal remains failure even when autonomous cleanup later proves absence", async () => {
		const fixture = autonomousFixture("signal-error");
		try {
			expect(await bounded(fixture.closed, 2000)).not.toBeNull();
			const result = JSON.parse(readFileSync(fixture.resultPath, "utf8"));
			expect(result.status.outcome).not.toBe("SUCCEEDED");
			expect(
				await waitUntil(() => !processPresent(fixture.owner().pid, true), 200),
			).toBe(true);
			expect(fixture.driver.exitCode).toBe(1);
		} finally {
			await fixture.cleanup();
		}
	}, 4000);

	test("late cleanup observation cannot turn a missed absolute cutoff into success", async () => {
		const fixture = autonomousFixture("late-join");
		try {
			expect(await bounded(fixture.closed, 2000)).not.toBeNull();
			const result = JSON.parse(readFileSync(fixture.resultPath, "utf8"));
			expect(result.ownership.groupAbsent).toBe(true);
			expect(result.ownership.commandExitCode).toBe(0);
			expect(result.status.outcome).toBe("TIMED_OUT");
		} finally {
			await fixture.cleanup();
		}
	}, 4000);
	test("optional forwarding preserves binary bytes with backpressure before success", async () => {
		const root = makeRoot(),
			chunks: Buffer[] = [],
			errors: Buffer[] = [];
		const sink = (pages: Buffer[]) =>
			new Writable({
				highWaterMark: 1,
				write(chunk, _encoding, callback) {
					setTimeout(() => {
						pages.push(Buffer.from(chunk));
						callback();
					}, 5);
				},
			});
		const out = sink(chunks),
			err = sink(errors);
		const result = await startOwnedCommand(
			{
				...descendantSpec(root),
				args: [
					"-e",
					'process.stdout.write(Buffer.from([0,255,10,65]));process.stderr.write("exact stderr\\n");',
				],
				timeoutMs: 2000,
			},
			root,
			undefined,
			{ forwardOutput: { stdout: out, stderr: err } },
		).result;
		expect(result.status.outcome).toBe("SUCCEEDED");
		expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 255, 10, 65]));
		expect(Buffer.concat(errors).toString()).toBe("exact stderr\n");
		expect(result.ownership.outputComplete).toBe(true);
		out.destroy();
		err.destroy();
	}, 4000);

	test("blocked forwarded output cannot outlive the original owned deadline or become success", async () => {
		const root = makeRoot();
		const sink = new Writable({ write(_chunk, _encoding, _callback) {} });
		const started = performance.now();
		try {
			const result = await startOwnedCommand(
				{
					...descendantSpec(root),
					args: ["-e", 'process.stdout.write("held output");'],
					timeoutMs: 500,
				},
				root,
				undefined,
				{ forwardOutput: { stdout: sink, stderr: sink } },
			).result;
			expect(performance.now() - started).toBeLessThan(800);
			expect(result.status.outcome).not.toBe("SUCCEEDED");
			expect(result.ownership.outputComplete).toBe(false);
		} finally {
			sink.destroy();
		}
	}, 2000);

	test("a forwarded stream failure cannot convert exit zero into success", async () => {
		const root = makeRoot();
		const sink = new Writable({
			write(_chunk, _encoding, callback) {
				callback(Error("fixture sink refused bytes"));
			},
		});
		try {
			const result = await startOwnedCommand(
				{
					...descendantSpec(root),
					args: ["-e", 'process.stdout.write("rejected output");'],
					timeoutMs: 1000,
				},
				root,
				undefined,
				{ forwardOutput: { stdout: sink, stderr: sink } },
			).result;
			expect(result.status.outcome).toBe("FAILED");
			expect(decoded(result.stderr)).toContain("fixture sink refused bytes");
		} finally {
			sink.destroy();
		}
	}, 2500);

	test("an expired absolute owned cutoff starts no supervisor", async () => {
		const handle = startOwnedCommand(
			{ ...descendantSpec(makeRoot()), timeoutMs: 5000 },
			process.cwd(),
			undefined,
			{ deadlineMonotonicNs: process.hrtime.bigint() - 1n },
		);
		const result = await handle.result;
		expect(handle.pid).toBeNull();
		expect(result.status.outcome).toBe("TIMED_OUT");
	}, 6000);
	test("earlier absolute cutoff is not renewed by a longer relative timeout", async () => {
		const started = performance.now();
		const result = await startOwnedCommand(
			{ ...descendantSpec(makeRoot()), timeoutMs: 5000 },
			process.cwd(),
			undefined,
			{ deadlineMonotonicNs: process.hrtime.bigint() + 300_000_000n },
		).result;
		expect(result.status.outcome).toBe("TIMED_OUT");
		expect(performance.now() - started).toBeLessThan(550);
		expect(result.ownership.groupAbsent).toBe(true);
	}, 2000);

	test("settled forwarding removes its listeners after a bounded incomplete result", async () => {
		const callbacks: (() => void)[] = [];
		const sink = new Writable({
			highWaterMark: 1,
			write(_chunk, _encoding, callback) {
				callbacks.push(callback);
			},
		});
		try {
			const result = await startOwnedCommand(
				{
					...descendantSpec(makeRoot()),
					timeoutMs: 500,
					args: ["-e", 'process.stdout.write("delayed");'],
				},
				process.cwd(),
				undefined,
				{ forwardOutput: { stdout: sink, stderr: sink } },
			).result;
			expect(result.ownership.outputComplete).toBe(false);
			expect(callbacks.length).toBe(1);
			for (const callback of callbacks) callback();
			expect(
				await waitUntil(
					() =>
						sink.listenerCount("error") === 0 &&
						sink.listenerCount("drain") === 0 &&
						sink.listenerCount("close") === 0,
					100,
				),
			).toBe(true);
		} finally {
			sink.destroy();
		}
	}, 2000);
	for (const directExit of [false, true])
		test(`whole timeout survives ${directExit ? "direct exit with inherited pipes" : "a TERM-resistant descendant"}`, async () => {
			const root = makeRoot(),
				spec = descendantSpec(root, directExit);
			const started = performance.now(),
				running = new BunCommandAdapter(root).execute(spec);
			const timely = await bounded(running, 900);
			// The pre-fix fixture self-exits, so the RED test also has a bounded join.
			const joined = timely ?? (await bounded(running, 2500));
			expect(joined).not.toBeNull();
			expect(timely).not.toBeNull();
			if (!joined) return;
			expect(performance.now() - started).toBeLessThan(900);
			expect(joined.status.outcome).toBe("TIMED_OUT");
			expect(decoded(joined.stdout)).toContain("parent stdout");
			expect(decoded(joined.stdout)).toContain("descendant stdout");
			expect(decoded(joined.stderr)).toContain("descendant stderr");
			const pid = Number(readFileSync(join(root, "descendant-ready"), "utf8"));
			const until = performance.now() + 1000;
			while (performance.now() < until) {
				try {
					process.kill(pid, 0);
				} catch {
					break;
				}
				await Bun.sleep(10);
			}
			expect(() => process.kill(pid, 0)).toThrow();
		}, 6000);

	test("abort bounds collection and retains partial output from inherited pipes", async () => {
		const root = makeRoot(),
			controller = new AbortController();
		const spec = { ...descendantSpec(root), timeoutMs: 5000 };
		const running = new BunCommandAdapter(root).execute(
			spec,
			controller.signal,
		);
		const deadline = performance.now() + 1000;
		while (
			!existsSync(join(root, "descendant-ready")) &&
			performance.now() < deadline
		)
			await Bun.sleep(10);
		controller.abort();
		const timely = await bounded(running, 900);
		const joined = timely ?? (await bounded(running, 2500));
		expect(joined).not.toBeNull();
		expect(timely).not.toBeNull();
		if (!joined) return;
		expect(joined.status.outcome).toBe("CANCELLED");
		expect(decoded(joined.stdout)).toContain("descendant stdout");
		expect(decoded(joined.stderr)).toContain("descendant stderr");
	}, 6000);

	test("ordinary exit preserves its distinctive status and exact output", async () => {
		const root = makeRoot();
		const result = await new BunCommandAdapter(root).execute({
			...descendantSpec(root),
			args: [
				"-e",
				'process.stdout.write("out\\n"); process.stderr.write("err\\n"); process.exit(37);',
			],
			timeoutMs: 2000,
		});
		expect(result.status).toEqual({
			outcome: "FAILED",
			exitCode: 37,
			signal: null,
		});
		expect(decoded(result.stdout)).toBe("out\n");
		expect(decoded(result.stderr)).toBe("err\n");
	}, 4000);

	test("successful completion joins and preserves binary output across page boundaries", async () => {
		const root = makeRoot();
		const source =
			"const data=Buffer.alloc(131075);for(let i=0;i<data.length;i++)data[i]=i%251;for(let i=0;i<data.length;i+=997)process.stdout.write(data.subarray(i,i+997));process.stderr.write(data.subarray(0,65537));";
		const result = await startOwnedCommand(
			{ ...descendantSpec(root), args: ["-e", source], timeoutMs: 2000 },
			root,
		).result;
		const expected = Buffer.alloc(131075);
		for (let index = 0; index < expected.length; index += 1)
			expected[index] = index % 251;
		expect({
			status: result.status,
			diagnostics: decoded(result.stderr).slice(65537),
			ownership: result.ownership,
		}).toMatchObject({
			status: { outcome: "SUCCEEDED", exitCode: 0, signal: null },
		});
		expect(result.ownership).toMatchObject({
			cleanupComplete: true,
			targetOutputComplete: true,
			outputComplete: true,
			groupAbsent: true,
		});
		expect(Buffer.from(result.stdout)).toEqual(expected);
		expect(Buffer.from(result.stderr)).toEqual(expected.subarray(0, 65537));
	}, 4000);

	test("shared handle retains literal command argv and proves its own group joined", async () => {
		const root = makeRoot(),
			spec = {
				...descendantSpec(root),
				command: "/bin/sh",
				args: ["-c", "exit 37"],
				timeoutMs: 2000,
			};
		const handle = startOwnedCommand(spec, root);
		expect(handle.pid).not.toBeNull();
		expect(handle.processGroupId).toBe(handle.pid);
		const witness = spawnSync(
			"/bin/ps",
			["-ww", "-p", String(handle.pid), "-o", "pid=,pgid=,command="],
			{ encoding: "utf8", timeout: 1000 },
		);
		const result = await handle.result;
		expect(handle.supervisorToken).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(
			Reflect.set(handle, "supervisorToken", "different-incarnation"),
		).toBe(false);
		expect(witness.status).toBe(0);
		expect(witness.stdout).toContain(
			` -e const supervisorToken="${handle.supervisorToken}";`,
		);
		expect(
			witness.stdout.trim().endsWith([spec.command, ...spec.args].join(" ")),
		).toBe(true);
		expect(result.ownership).toMatchObject({
			pid: handle.pid,
			processGroupId: handle.pid,
			commandExitCode: 37,
			commandSignal: null,
			supervisorJoined: true,
			supervisorSignal: "SIGKILL",
			groupAbsent: true,
			outputComplete: true,
			cleanupComplete: true,
		});
		expect(result.ownership.commandPid).not.toBeNull();
		expect(result.status).toEqual({
			outcome: "FAILED",
			exitCode: 37,
			signal: null,
		});
	}, 4000);

	test("group cancellation does not signal a separate process owned by the test", async () => {
		const root = makeRoot();
		const unrelated = spawn(
			process.execPath,
			["-e", "setTimeout(()=>process.exit(0),2000)"],
			{ stdio: "ignore" },
		);
		const unrelatedExited = new Promise<void>((resolve) =>
			unrelated.once("exit", () => resolve()),
		);
		try {
			const handle = startOwnedCommand(
				{ ...descendantSpec(root), timeoutMs: 2000 },
				root,
			);
			const deadline = performance.now() + 1000;
			while (
				!existsSync(join(root, "descendant-ready")) &&
				performance.now() < deadline
			)
				await Bun.sleep(10);
			handle.cancel();
			const result = await handle.result;
			expect(result.status.outcome).toBe("CANCELLED");
			expect(result.ownership.cleanupComplete).toBe(true);
			expect(unrelated.exitCode).toBeNull();
			expect(unrelated.signalCode).toBeNull();
		} finally {
			unrelated.kill("SIGTERM");
			expect(await bounded(unrelatedExited, 1000)).not.toBeNull();
		}
	}, 5000);

	test("escaped target pipes remain explicitly incomplete while the owned group is cleaned", async () => {
		const root = makeRoot();
		const ready = join(root, "escaped-ready");
		const descendant = `require("node:fs").writeFileSync(${JSON.stringify(ready)},String(process.pid));process.stdout.write("escaped partial\\n");setTimeout(()=>process.exit(0),1100);`;
		const command = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{detached:true,stdio:["ignore","inherit","inherit"]});setTimeout(()=>process.exit(0),100);`;
		const started = performance.now();
		const result = await startOwnedCommand(
			{ ...descendantSpec(root), args: ["-e", command], timeoutMs: 500 },
			root,
		).result;
		expect(performance.now() - started).toBeLessThan(900);
		expect(result.status.outcome).not.toBe("SUCCEEDED");
		expect(result.ownership.cleanupComplete).toBe(true);
		expect(result.ownership.targetOutputComplete).toBe(false);
		expect(result.ownership.groupAbsent).toBe(true);
		expect(decoded(result.stdout)).toContain("escaped partial");
		expect(decoded(result.stderr)).toContain("retained bytes are partial");
		// The deliberately separate fixture exits itself; do not group-signal it.
		const pid = Number(readFileSync(ready, "utf8")),
			deadline = performance.now() + 1500;
		while (performance.now() < deadline) {
			try {
				process.kill(pid, 0);
			} catch {
				break;
			}
			await Bun.sleep(10);
		}
		expect(() => process.kill(pid, 0)).toThrow();
	}, 4000);

	test("output limits retain a bounded raw prefix and cannot turn exit0 into PASS", async () => {
		const root = makeRoot();
		const result = await startOwnedCommand(
			{
				...descendantSpec(root),
				args: [
					"-e",
					`process.stderr.write("retained error prefix\\n");process.stdout.write(Buffer.alloc(${OWNED_COMMAND_OUTPUT_LIMIT_BYTES + 65536},120));setTimeout(()=>process.exit(0),2000);`,
				],
				timeoutMs: 2000,
			},
			root,
		).result;
		expect({
			status: result.status,
			bytes: result.stdout.length,
			diagnostics: decoded(result.stderr),
			ownership: result.ownership,
		}).toMatchObject({
			status: { outcome: "FAILED" },
			ownership: { cleanupComplete: true },
		});
		expect(result.stdout.length).toBe(OWNED_COMMAND_OUTPUT_LIMIT_BYTES);
		expect(decoded(result.stderr)).toContain("retained error prefix");
		expect(decoded(result.stderr)).toContain("stdout exceeded");
		expect(result.ownership.cleanupComplete).toBe(true);
	}, 4000);

	test("pre-abort starts nothing and missing executables retain an explicit failure", async () => {
		const root = makeRoot(),
			controller = new AbortController();
		controller.abort();
		const cancelled = startOwnedCommand(
			descendantSpec(root),
			root,
			controller.signal,
		);
		expect(cancelled.pid).toBeNull();
		expect(cancelled.supervisorToken).toBeNull();
		expect((await cancelled.result).status.outcome).toBe("CANCELLED");
		expect(existsSync(join(root, "descendant-ready"))).toBe(false);
		const failed = await startOwnedCommand(
			{
				...descendantSpec(root),
				command: "/definitely/missing/g6-owned-command",
				timeoutMs: 1500,
			},
			root,
		).result;
		expect({
			status: failed.status,
			diagnostics: decoded(failed.stderr),
			ownership: failed.ownership,
		}).toMatchObject({
			status: { outcome: "FAILED", exitCode: null, signal: null },
			ownership: { cleanupComplete: true },
		});
		expect(decoded(failed.stderr)).toContain("process start failed");
		expect(failed.ownership.cleanupComplete).toBe(true);
	}, 4000);
});

describe("G6 c32 recorded command boundary", () => {
	test("redacts SSH identity paths from retained action arguments", async () => {
		const root = makeRoot();
		const identityPath = "/private/operator/g6-id_ed25519";
		const result = await recordOperation(
			{
				runId: "g6-c32-redaction-test",
				sequence: 1,
				attempt: 1,
				artifactDirectory: join(root, "operations"),
				artifactPathPrefix: "operations",
				spec: {
					operationId: "copy-identity",
					phase: "PREPARE",
					command: "/usr/bin/scp",
					args: [identityPath, "root@example:/root/.ssh/id_ed25519"],
					cwd: ".",
					env: { G6_C32_SSH_IDENTITY_PATH: identityPath },
					timeoutMs: 1_000,
					stdin: "ignore",
				},
			},
			{
				clock: new FakeClock(
					["2026-09-04T12:00:00.000Z", "2026-09-04T12:00:00.100Z"],
					[0n, 100_000_000n],
				),
				adapter: new FakeAdapter([
					{
						stdout: "",
						stderr: "",
						status: { outcome: "SUCCEEDED", exitCode: 0, signal: null },
					},
				]),
				executionRoot: root,
			},
		);
		const retainedArgs = JSON.stringify(result.receipt.action.args);
		expect(retainedArgs).not.toContain(identityPath);
		expect(retainedArgs).not.toContain("id_ed25519");
		expect(result.receipt.action.args).toContain("<redacted-ssh-identity>");
	});

	test("retains off-runner bounds and provider observation timestamps", async () => {
		const root = makeRoot();
		const result = await recordOperation(
			{
				runId: "g6-c32-provider-timing-test",
				sequence: 1,
				attempt: 1,
				artifactDirectory: join(root, "operations"),
				artifactPathPrefix: "operations",
				spec: {
					operationId: "provider-observation",
					phase: "INVENTORY",
					command: "doctl",
					args: ["compute", "droplet", "get", "101", "--output", "json"],
					cwd: ".",
					env: {},
					timeoutMs: 1_000,
					stdin: "ignore",
				},
				remoteObservationAt: () => "2026-08-30T12:00:00.050Z",
			},
			{
				clock: new FakeClock(
					["2026-08-30T12:00:00.000Z", "2026-08-30T12:00:00.100Z"],
					[0n, 100_000_000n],
				),
				adapter: new FakeAdapter([
					{
						stdout: '[{"id":101,"created_at":"2026-08-30T12:00:00Z"}]',
						stderr: "",
						status: { outcome: "SUCCEEDED", exitCode: 0, signal: null },
					},
				]),
				executionRoot: root,
			},
		);
		expect(result.receipt.remoteTiming).toEqual({
			requestStartedAt: "2026-08-30T12:00:00.000Z",
			responseFinishedAt: "2026-08-30T12:00:00.100Z",
			observationAt: "2026-08-30T12:00:00.050Z",
		});
		expect(
			validateOperationReceipt(
				JSON.parse(readFileSync(result.receiptPath, "utf8")),
			).remoteTiming,
		).toEqual(result.receipt.remoteTiming);
	}, 15_000);

	test("default adapter passes only explicitly allowed environment values", async () => {
		const root = makeRoot();
		const inheritedKey = "G6_C32_OPERATION_INHERITED_SECRET";
		const previous = process.env[inheritedKey];
		process.env[inheritedKey] = "must-not-reach-child";
		try {
			const result = await recordOperation(
				{
					runId: "g6-c32-environment-test",
					sequence: 1,
					attempt: 1,
					artifactDirectory: join(root, "operations"),
					artifactPathPrefix: "operations",
					spec: {
						operationId: "environment-allow-list",
						phase: "LOCAL_GATES",
						command: process.execPath,
						args: [
							"-e",
							`process.stdout.write(JSON.stringify({ allowed: process.env.G6_C32_ALLOWED, inherited: process.env.${inheritedKey} ?? null }))`,
						],
						cwd: ".",
						env: { G6_C32_ALLOWED: "visible" },
						timeoutMs: 5_000,
						stdin: "ignore",
					},
				},
				{
					clock: new FakeClock(
						["2026-08-30T12:00:00.000Z", "2026-08-30T12:00:00.100Z"],
						[0n, 100_000_000n],
					),
					executionRoot: root,
				},
			);
			const childEnvironment = JSON.parse(
				readFileSync(result.stdoutPath, "utf8"),
			) as unknown;
			expect(childEnvironment).toEqual({
				allowed: "visible",
				inherited: null,
			});
			expect(result.receipt.action.environmentKeys).toEqual(["G6_C32_ALLOWED"]);
			expect(readFileSync(result.receiptPath, "utf8")).not.toContain("visible");
		} finally {
			if (previous === undefined) delete process.env[inheritedKey];
			else process.env[inheritedKey] = previous;
		}
	}, 15_000);

	test("publishes timestamped stdout, stderr, status, and receipt for every outcome", async () => {
		const root = makeRoot();
		const clock = new FakeClock(
			[
				"2026-08-30T12:00:00.000Z",
				"2026-08-30T12:00:00.125Z",
				"2026-08-30T12:01:00.000Z",
				"2026-08-30T12:01:00.250Z",
				"2026-08-30T12:02:00.000Z",
				"2026-08-30T12:02:00.500Z",
				"2026-08-30T12:03:00.000Z",
				"2026-08-30T12:03:00.750Z",
			],
			[
				0n,
				125_000_000n,
				1_000_000_000n,
				1_250_000_000n,
				2_000_000_000n,
				2_500_000_000n,
				3_000_000_000n,
				3_750_000_000n,
			],
		);
		const outcomes: CommandExecutionResult[] = [
			{
				stdout: "success stdout\n",
				stderr: "",
				status: { outcome: "SUCCEEDED", exitCode: 0, signal: null },
			},
			{
				stdout: "",
				stderr: "failed stderr\n",
				status: { outcome: "FAILED", exitCode: 23, signal: null },
			},
			{
				stdout: "partial timeout\n",
				stderr: "timed out\n",
				status: { outcome: "TIMED_OUT", exitCode: null, signal: "SIGTERM" },
			},
			{
				stdout: "partial cancellation\n",
				stderr: "cancelled\n",
				status: { outcome: "CANCELLED", exitCode: null, signal: "SIGTERM" },
			},
		];
		const adapter = new FakeAdapter(outcomes);
		const specs: CommandSpec[] = [
			{
				operationId: "success",
				phase: "LOCAL_GATES",
				command: "bun",
				args: ["test", "fixture.test.ts"],
				cwd: ".",
				env: { PATH: "/usr/bin", DO_TOKEN: "never-persist-this" },
				timeoutMs: 1_000,
				stdin: "ignore",
			},
			{
				operationId: "nonzero",
				phase: "LOCAL_GATES",
				command: "false",
				args: [],
				cwd: ".",
				env: { PATH: "/usr/bin" },
				timeoutMs: 1_000,
				stdin: "ignore",
			},
			{
				operationId: "timeout",
				phase: "SSH_READY",
				command: "ssh",
				args: ["root@host", "true"],
				cwd: ".",
				env: { PATH: "/usr/bin" },
				timeoutMs: 10,
				stdin: "ignore",
			},
			{
				operationId: "cancelled",
				phase: "ARTIFACT_COPY",
				command: "scp",
				args: ["-o", "BatchMode=no", "source", "root@host:destination"],
				cwd: ".",
				env: { PATH: "/usr/bin" },
				timeoutMs: 1_000,
				stdin: "ignore",
			},
		];

		for (const [index, spec] of specs.entries()) {
			const expectedOutcome = outcomes[index];
			const expectedDuration = [
				"125000000",
				"250000000",
				"500000000",
				"750000000",
			][index];
			if (!expectedOutcome || !expectedDuration) {
				throw new Error(`missing expected fixture at index ${index}`);
			}
			const result = await recordOperation(
				{
					runId: "g6-c32-operation-test",
					sequence: index + 1,
					attempt: 1,
					artifactDirectory: join(root, "operations"),
					artifactPathPrefix: "operations",
					spec,
				},
				{ clock, adapter, executionRoot: root },
			);
			const names = readdirSync(result.directoryPath).sort();
			expect(names).toEqual([
				"operation.receipt.json",
				"operation.status",
				"operation.stderr",
				"operation.stdout",
			]);
			const receipt = validateOperationReceipt(
				JSON.parse(readFileSync(result.receiptPath, "utf8")),
			);
			const status = validateOperationStatusRecord(
				JSON.parse(readFileSync(result.statusPath, "utf8")),
			);
			expect(receipt.status).toEqual(expectedOutcome.status);
			expect(status.status).toEqual(receipt.status);
			expect(status.envelope).toEqual(receipt.envelope);
			expect(receipt.envelope.recordedAt).toBe(receipt.finishedAt);
			expect(receipt.durationMonotonicNs).toBe(expectedDuration);
			expect(receipt.stdoutPath.endsWith("/operation.stdout")).toBeTrue();
			expect(receipt.stderrPath.endsWith("/operation.stderr")).toBeTrue();
			const persistedMetadata = `${readFileSync(result.receiptPath, "utf8")}${readFileSync(result.statusPath, "utf8")}`;
			expect(persistedMetadata).not.toContain("never-persist-this");
		}

		expect(adapter.seen[0]?.args).toEqual(["test", "fixture.test.ts"]);
		expect(adapter.seen[2]?.args).toEqual(["-n", "root@host", "true"]);
		expect(adapter.seen[3]?.args).toEqual([
			"-o",
			"BatchMode=yes",
			"source",
			"root@host:destination",
		]);
		expect(adapter.seen.every((spec) => spec.stdin === "ignore")).toBeTrue();

		for (const directory of readdirSync(join(root, "operations"))) {
			const files = readdirSync(join(root, "operations", directory));
			for (const output of files.filter((name) =>
				/\.(?:stdout|stderr|status)$/.test(name),
			)) {
				expect(output).toBeString();
				expect(files).toContain("operation.receipt.json");
			}
		}
	}, 15_000);
});
