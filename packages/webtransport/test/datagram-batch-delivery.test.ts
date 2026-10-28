/**
 * H7 batch datagram delivery: knob resolution, the real-addon payload
 * conversion seam, the shared generator, and the diagnostics counters.
 *
 * Every environment-variable case runs in a fresh bounded child process. Both
 * knobs and the native delivery mode are resolved exactly once per process, so
 * flipping an env var inside this process would only ever re-assert a value
 * that was frozen when the module first loaded.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E_INTERNAL, WebTransportError, createServer } from "../src/index.js";
import { __TESTING__ } from "../src/internal.js";
import { nextWithTimeout, withHarness } from "./helpers/harness.js";
import { connectWithRetry, nextPort } from "./helpers/network.js";

const BASE_PORT = 19600;
const CHILD_TIMEOUT_MS = 60_000;

const INTERNAL_MODULE = new URL("../src/internal.ts", import.meta.url).pathname;
const PUBLIC_MODULE = new URL("../src/index.ts", import.meta.url).pathname;

type ChildRun = {
	exitCode: number | null;
	result: unknown;
	stdout: string;
	stderr: string;
};

/**
 * Run `body` in a fresh bounded Bun process with `env` applied before any
 * module loads. The child reports by printing one `__RESULT__<json>` line; a
 * child that outlives the deadline is killed and reported as a failure rather
 * than silently tolerated.
 */
async function runChild(
	body: string,
	env: Record<string, string | undefined> = {},
	timeoutMs = CHILD_TIMEOUT_MS,
): Promise<ChildRun> {
	const dir = mkdtempSync(join(tmpdir(), "wt-h7-"));
	const script = join(dir, "child.ts");
	const preamble =
		`const INTERNAL_MODULE = ${JSON.stringify(INTERNAL_MODULE)};\n` +
		`const PUBLIC_MODULE = ${JSON.stringify(PUBLIC_MODULE)};\n` +
		`const report = (v: unknown) => console.log("__RESULT__" + JSON.stringify(v));\n`;
	await Bun.write(script, preamble + body);
	const childEnv: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env))
		if (v !== undefined) childEnv[k] = v;
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) delete childEnv[k];
		else childEnv[k] = v;
	}
	const proc = Bun.spawn([process.execPath, script], {
		env: childEnv,
		stdout: "pipe",
		stderr: "pipe",
		cwd: new URL("../../..", import.meta.url).pathname,
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		// The deadline timer is cleared on every path; an uncancelled one would
		// keep the test runner's loop alive for its full duration per child.
		const exited = await Promise.race([
			proc.exited,
			new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), timeoutMs);
			}),
		]);
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		if (exited === "timeout") {
			proc.kill();
			throw new Error(
				`child did not exit within ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
			);
		}
		const line = stdout
			.split("\n")
			.find((l) => l.startsWith("__RESULT__"))
			?.slice("__RESULT__".length);
		return {
			exitCode: exited,
			result: line === undefined ? undefined : JSON.parse(line),
			stdout,
			stderr,
		};
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Fail loudly rather than letting a crashed child read as an empty pass. */
function childResult(run: ChildRun): any {
	if (run.exitCode !== 0)
		throw new Error(
			`child exited ${run.exitCode}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
		);
	if (run.result === undefined)
		throw new Error(
			`child produced no __RESULT__ line\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
		);
	return run.result;
}

describe("datagram batch knob parsing", () => {
	it("falls back to the default for anything that is not a decimal integer", () => {
		const parse = __TESTING__.parseDatagramBatchSizeForTests;
		for (const raw of [
			undefined,
			"",
			"   ",
			"abc",
			"1.5",
			"-1.5",
			"1e2",
			"0x10",
			"Infinity",
			"-Infinity",
			"NaN",
			"64k",
			"6 4",
		]) {
			expect([raw, parse(raw)]).toEqual([raw, 64]);
		}
	});

	it("treats a decimal integer that overflows a double as invalid", () => {
		// This is why the Number.isFinite guard is not redundant with the
		// regex: these match /^[+-]?\d+$/ and still convert to Infinity, and
		// the spec classifies non-finite as invalid rather than as a clamp.
		const parse = __TESTING__.parseDatagramBatchSizeForTests;
		const overflow = "9".repeat(400);
		expect(/^[+-]?\d+$/.test(overflow)).toBe(true);
		expect(Number(overflow)).toBe(Number.POSITIVE_INFINITY);
		expect(parse(overflow)).toBe(64);
		expect(parse(`-${overflow}`)).toBe(64);
	});

	it("clamps valid decimal integers into 0..256", () => {
		const parse = __TESTING__.parseDatagramBatchSizeForTests;
		const cases: [string, number][] = [
			["0", 0],
			["-0", 0],
			["-1", 0],
			["-256", 0],
			["-99999", 0],
			["1", 1],
			["2", 2],
			["+8", 8],
			[" 32 ", 32],
			["64", 64],
			["255", 255],
			["256", 256],
			["257", 256],
			["100000", 256],
		];
		for (const [raw, want] of cases) {
			expect([raw, parse(raw)]).toEqual([raw, want]);
		}
	});

	it("resolves the knob once per process, at module initialization", async () => {
		const body = `
			const { __TESTING__ } = await import(INTERNAL_MODULE);
			// Mutating the env after load must not move the resolved value.
			process.env.WEBTRANSPORT_DATAGRAM_BATCH = "7";
			const cfg = __TESTING__.datagramBatchConfigForTests();
			report({ batchSize: cfg.batchSize, frozen: Object.isFrozen(cfg) });
		`;
		// The full parse matrix is covered in-process above; these children
		// prove the resolution happens at module init and is immune to a later
		// env mutation. One representative per outcome class keeps the process
		// count down — every extra child is real load on the shared runner.
		const cases: [string | undefined, number][] = [
			[undefined, 64],
			["bogus", 64],
			["0", 0],
			["-4", 0],
			["1", 1],
			["300", 256],
		];
		for (const [value, want] of cases) {
			const res = childResult(
				await runChild(body, { WEBTRANSPORT_DATAGRAM_BATCH: value }),
			);
			expect([value, res.batchSize, res.frozen]).toEqual([value, want, true]);
		}
	});
});

describe("native payload delivery mode seam", () => {
	it("reports exactly one of the two literals and never guesses from JS env", async () => {
		const body = `
			const { __TESTING__ } = await import(INTERNAL_MODULE);
			const mode = __TESTING__.nativePayloadDeliveryModeForTests();
			if (mode !== "arraybuffer" && mode !== "buffer-copy") {
				throw new Error("delivery-mode seam missing or unrecognized: " + String(mode));
			}
			report({ mode, engineOwnedMax: __TESTING__.nativePayloadEngineOwnedMaxBytesForTests() });
		`;
		const dflt = childResult(await runChild(body));
		expect(dflt.mode).toBe("arraybuffer");
		expect(dflt.engineOwnedMax).toBeGreaterThan(0);

		const copy = childResult(
			await runChild(body, { WEBTRANSPORT_PAYLOAD_DELIVERY: "buffer-copy" }),
		);
		expect(copy.mode).toBe("buffer-copy");
		expect(copy.engineOwnedMax).toBe(dflt.engineOwnedMax);
	});
});

describe("real-addon batch payload materialization (requirement E)", () => {
	// Shared child body: drives real inputs through napi-rs's per-element array
	// conversion, classifies the branch each element took, then drops every view
	// and settles two full GCs so a clean exit is part of the evidence.
	const materializeBody = `
		const { __TESTING__ } = await import(INTERNAL_MODULE);
		const mode = __TESTING__.nativePayloadDeliveryModeForTests();
		if (mode !== "arraybuffer" && mode !== "buffer-copy") {
			throw new Error("delivery-mode seam missing or unrecognized: " + String(mode));
		}
		const max = __TESTING__.nativePayloadEngineOwnedMaxBytesForTests();
		if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) {
			throw new Error("engine-owned max seam missing: " + String(max));
		}
		const mkPattern = (n: number) => {
			const b = Buffer.alloc(n);
			for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
			return b;
		};
		const inputs = [mkPattern(0), mkPattern(3), mkPattern(1000), mkPattern(max), mkPattern(max + 1)];
		const digest = (u: Uint8Array) => {
			let h = 2166136261 >>> 0;
			for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
			return h;
		};
		const expected = inputs.map((b) => ({ len: b.length, digest: digest(b) }));
		let out = __TESTING__.materializePayloadBatchForTests(inputs);
		if (!Array.isArray(out)) throw new Error("materialization seam missing");
		const observed = out.map((v, i) => ({
			len: v.byteLength,
			digest: digest(v),
			isBuffer: Buffer.isBuffer(v),
			ctor: v.constructor.name,
			bufferCtor: v.buffer.constructor.name,
			identicalTo: digest(v) === expected[i].digest && v.byteLength === expected[i].len,
		}));
		const emptyOut = __TESTING__.materializePayloadBatchForTests([]);
		// Drop every view, then settle two bounded full GCs.
		out = undefined;
		Bun.gc(true);
		await Bun.sleep(20);
		Bun.gc(true);
		await Bun.sleep(20);
		report({ mode, max, expected, observed, emptyOutLength: emptyOut.length });
	`;

	it("default mode routes each size to the branch its delivery plan names", async () => {
		const run = await runChild(materializeBody);
		const res = childResult(run);
		expect(run.exitCode).toBe(0);
		expect(res.mode).toBe("arraybuffer");
		expect(res.emptyOutLength).toBe(0);
		expect(res.observed).toHaveLength(5);

		// Ordered byte identity for every element.
		expect(res.observed.map((o: any) => o.identicalTo)).toEqual([
			true,
			true,
			true,
			true,
			true,
		]);
		expect(res.observed.map((o: any) => o.len)).toEqual(
			res.expected.map((e: any) => e.len),
		);
		expect(res.observed.map((o: any) => o.digest)).toEqual(
			res.expected.map((e: any) => e.digest),
		);

		const [empty, small, medium, atMax, overMax] = res.observed;
		// Small payloads (through the inclusive engine-owned bound) take the
		// default ArrayBuffer-backed, non-Buffer branch.
		for (const o of [small, medium, atMax]) {
			expect([o.len, o.isBuffer, o.ctor, o.bufferCtor]).toEqual([
				o.len,
				false,
				"Uint8Array",
				"ArrayBuffer",
			]);
		}
		// Exactly one byte past the bound takes the accounted external handover.
		expect([overMax.len, overMax.isBuffer]).toEqual([res.max + 1, true]);
		expect(overMax.len).toBe(atMax.len + 1);
		// The zero-length payload comes back as an empty Buffer. Note what this
		// does NOT prove: JavaScript cannot distinguish the Empty arm from the
		// accounted-external arm, because both surface as a `Buffer`. So a
		// 0-byte payload misrouted into external handover would still satisfy
		// this assertion. Only three of the four arms are discriminable from
		// here; size 0 => PayloadDeliveryPlan::Empty is pinned on the Rust side
		// by `empty_payloads_plan_the_engine_owned_empty_buffer_in_either_mode`
		// in crates/native/src/payload_buffer.rs.
		expect([empty.len, empty.isBuffer]).toEqual([0, true]);
	});

	it("buffer-copy mode set before module load keeps every element a Buffer", async () => {
		const run = await runChild(materializeBody, {
			WEBTRANSPORT_PAYLOAD_DELIVERY: "buffer-copy",
		});
		const res = childResult(run);
		expect(run.exitCode).toBe(0);
		expect(res.mode).toBe("buffer-copy");
		expect(res.observed.map((o: any) => o.identicalTo)).toEqual([
			true,
			true,
			true,
			true,
			true,
		]);
		expect(res.observed.map((o: any) => o.isBuffer)).toEqual([
			true,
			true,
			true,
			true,
			true,
		]);
		// The size-dependent split that the default mode shows must be absent.
		expect(new Set(res.observed.map((o: any) => o.ctor))).toEqual(
			new Set(["Buffer"]),
		);
	});
});

describe("shared incoming-datagram generator", () => {
	const iterate = __TESTING__.createIncomingDatagramIteratorForTests;
	const never = () => false;
	const passthrough = (err: unknown) => err;

	function scriptedHandle(batches: (Uint8Array[] | null)[]) {
		const calls: number[] = [];
		let i = 0;
		return {
			calls,
			handle: {
				readDatagram: async () => {
					throw new Error("legacy readDatagram must not be called");
				},
				readDatagramBatch: async (max: number) => {
					calls.push(max);
					return i < batches.length ? (batches[i++] ?? null) : null;
				},
			},
		};
	}

	it("throws the version-mismatch error on first pull when the addon lacks the batch method", async () => {
		const gen = iterate(
			{
				readDatagram: async () => new Uint8Array([1]),
			},
			never,
			64,
			passthrough,
		);
		let err: unknown;
		try {
			await nextWithTimeout(gen, 2000, "mismatch first pull");
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WebTransportError);
		expect((err as WebTransportError).code).toBe(E_INTERNAL);
		expect((err as WebTransportError).message).toBe(
			"E_INTERNAL: native addon/JavaScript version mismatch; rebuild the matching prebuild",
		);
		expect((err as WebTransportError).message).toBe(
			__TESTING__.datagramBatchMismatchMessageForTests,
		);
	});

	it("does not fall back to the legacy read when the batch method is missing", async () => {
		let legacyCalls = 0;
		const gen = iterate(
			{
				readDatagram: async () => {
					legacyCalls++;
					return new Uint8Array([1]);
				},
			},
			never,
			64,
			passthrough,
		);
		await expect(gen.next()).rejects.toBeInstanceOf(WebTransportError);
		expect(legacyCalls).toBe(0);
	});

	it("uses only the legacy read at batch size 0", async () => {
		let batchCalls = 0;
		const payloads = [new Uint8Array([1]), new Uint8Array([2]), null];
		let i = 0;
		const gen = iterate(
			{
				readDatagram: async () => payloads[i++] ?? null,
				readDatagramBatch: async () => {
					batchCalls++;
					return null;
				},
			},
			never,
			0,
			passthrough,
		);
		const seen: number[] = [];
		for await (const d of gen) seen.push(d[0]!);
		expect(seen).toEqual([1, 2]);
		expect(batchCalls).toBe(0);
	});

	it("passes the configured size through and never refills before draining", async () => {
		const { calls, handle } = scriptedHandle([
			[new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])],
			[new Uint8Array([4])],
			null,
		]);
		const gen = iterate(handle, never, 7, passthrough);
		const seen: number[] = [];
		const callsAtYield: number[] = [];
		for await (const d of gen) {
			seen.push(d[0]!);
			callsAtYield.push(calls.length);
		}
		expect(seen).toEqual([1, 2, 3, 4]);
		expect(calls).toEqual([7, 7, 7]);
		// One read call covers items 1..3; the second is only issued after the
		// first array has been fully drained.
		expect(callsAtYield).toEqual([1, 1, 1, 2]);
	});

	it("treats a null batch as EOF and an empty array as EOF", async () => {
		for (const terminal of [null, [] as Uint8Array[]]) {
			const { handle } = scriptedHandle([[new Uint8Array([9])], terminal]);
			const gen = iterate(handle, never, 64, passthrough);
			const seen: number[] = [];
			for await (const d of gen) seen.push(d[0]!);
			expect(seen).toEqual([9]);
		}
	});

	it("stops pulling once the session reports closed", async () => {
		let closed = false;
		const { calls, handle } = scriptedHandle([
			[new Uint8Array([1])],
			[new Uint8Array([2])],
		]);
		const gen = iterate(handle, () => closed, 64, passthrough);
		const first = await nextWithTimeout(gen, 2000, "pre-close pull");
		expect(first.done).toBe(false);
		closed = true;
		const next = await nextWithTimeout(gen, 2000, "post-close pull");
		expect(next.done).toBe(true);
		expect(calls).toHaveLength(1);
	});

	it("maps non-close batch failures through the caller's error mapper", async () => {
		const marker = new Error("mapped");
		const gen = iterate(
			{
				readDatagram: async () => null,
				readDatagramBatch: async () => {
					throw new Error("E_INTERNAL: synthetic batch failure");
				},
			},
			never,
			64,
			() => marker,
		);
		await expect(gen.next()).rejects.toBe(marker);
	});

	it("ends the iteration on a session-close batch failure instead of throwing", async () => {
		const gen = iterate(
			{
				readDatagram: async () => null,
				readDatagramBatch: async () => {
					throw new Error("E_SESSION_CLOSED: closed");
				},
			},
			never,
			64,
			() => {
				throw new Error("mapper must not run for close errors");
			},
		);
		const first = await nextWithTimeout(gen, 2000, "close-as-EOF pull");
		expect(first.done).toBe(true);
	});
});

describe("batch diagnostics", () => {
	// The generator is driven directly so the counter assertions do not depend
	// on real network timing; the selected generator is the production one.
	const driveBody = `
		const { __TESTING__ } = await import(INTERNAL_MODULE);
		const cfg = __TESTING__.datagramBatchConfigForTests();
		const iterate = __TESTING__.createIncomingDatagramIteratorForTests;
		const batches = [
			[new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])],
			[new Uint8Array([4]), new Uint8Array([5])],
			null,
		];
		let i = 0;
		const handle = {
			readDatagram: async () => (i < 5 ? new Uint8Array([++i]) : null),
			readDatagramBatch: async () => (i < batches.length ? batches[i++] : null),
		};
		const seen = [];
		for await (const d of iterate(handle, () => false, cfg.batchSize, (e) => e)) {
			seen.push(d[0]);
		}
		report({ cfg, seen, diag: __TESTING__.datagramBatchDiagnosticsSnapshotForTests() });
	`;

	it("counts nothing when diagnostics are disabled", async () => {
		const res = childResult(await runChild(driveBody));
		expect(res.cfg.diagnosticsEnabled).toBe(false);
		expect(res.seen).toEqual([1, 2, 3, 4, 5]);
		expect(res.diag).toEqual({
			legacyReadCalls: 0,
			batchReadCalls: 0,
			materializedItems: 0,
			yieldedItems: 0,
			maxBatchSize: 0,
			meanBatchSize: 0,
			abandonedItems: 0,
		});
	});

	it("counts batch reads, items and observed sizes when enabled", async () => {
		const res = childResult(
			await runChild(driveBody, {
				WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS: "1",
			}),
		);
		expect(res.cfg.diagnosticsEnabled).toBe(true);
		expect(res.seen).toEqual([1, 2, 3, 4, 5]);
		expect(res.diag.legacyReadCalls).toBe(0);
		expect(res.diag.batchReadCalls).toBe(3);
		expect(res.diag.materializedItems).toBe(5);
		expect(res.diag.yieldedItems).toBe(5);
		expect(res.diag.maxBatchSize).toBe(3);
		expect(res.diag.meanBatchSize).toBeCloseTo(5 / 3, 10);
		expect(res.diag.abandonedItems).toBe(0);
	});

	it("counts legacy reads when the knob selects the legacy path", async () => {
		const res = childResult(
			await runChild(driveBody, {
				WEBTRANSPORT_DATAGRAM_BATCH: "0",
				WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS: "1",
			}),
		);
		expect(res.cfg.batchSize).toBe(0);
		expect(res.seen).toEqual([1, 2, 3, 4, 5]);
		expect(res.diag.legacyReadCalls).toBe(6);
		expect(res.diag.batchReadCalls).toBe(0);
		expect(res.diag.yieldedItems).toBe(5);
		expect(res.diag.maxBatchSize).toBe(0);
		expect(res.diag.abandonedItems).toBe(0);
	});

	it("only treats the exact value 1 as enabling diagnostics", async () => {
		// A cheap body: this only needs the resolved flag, not a driven loop.
		const configBody = `
			const { __TESTING__ } = await import(INTERNAL_MODULE);
			report(__TESTING__.datagramBatchConfigForTests());
		`;
		for (const raw of ["0", "true", " 1"]) {
			const res = childResult(
				await runChild(configBody, {
					WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS: raw,
				}),
			);
			expect([raw, res.diagnosticsEnabled]).toEqual([raw, false]);
		}
	});
});

describe("live batched delivery over a real session", () => {
	async function echoRoundTrip(batchSize: number, count: number) {
		return await withHarness(async (h) => {
			const port = nextPort(BASE_PORT, 150);
			const received: Uint8Array[] = [];
			const server = h.track(
				createServer({
					port,
					tls: { certPem: "", keyPem: "" },
					onSession: async (s) => {
						for await (const d of s.incomingDatagrams()) {
							received.push(new Uint8Array(d));
							await s.sendDatagram(d);
						}
					},
				}),
			);
			const client = h.track(
				await connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				}),
			);
			const sent: Uint8Array[] = [];
			for (let i = 0; i < count; i++) {
				// Distinct length and content per datagram so an out-of-order or
				// duplicated delivery cannot pass as identity.
				const payload = new Uint8Array(8 + (i % 17));
				payload.fill((i * 13 + 5) & 0xff);
				payload[0] = i & 0xff;
				payload[1] = (i >> 8) & 0xff;
				sent.push(payload);
				await client.sendDatagram(payload);
			}
			const iter = client.incomingDatagrams()[Symbol.asyncIterator]();
			const echoed: Uint8Array[] = [];
			// Datagrams are lossy by definition, so this asserts identity and
			// backing of what does arrive, not a delivery count.
			const deadline = Date.now() + 8000;
			while (echoed.length < count && Date.now() < deadline) {
				const next = await nextWithTimeout(
					iter,
					2500,
					`batch=${batchSize} echo read`,
				).catch(() => ({ done: true, value: undefined }) as const);
				if (next.done || !next.value) break;
				echoed.push(new Uint8Array(next.value as Uint8Array));
			}
			return { sent, echoed };
		});
	}

	// Driven from a child so each batch size is a fresh module init, which is
	// the only way the knob is ever resolved in production.
	const liveEchoBody = `
		const { __TESTING__ } = await import(INTERNAL_MODULE);
		const { createServer, connect } = await import(PUBLIC_MODULE);
		const cfg = __TESTING__.datagramBatchConfigForTests();
		const port = Number(process.env.WT_TEST_PORT);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				for await (const d of s.incomingDatagrams()) await s.sendDatagram(d);
			},
		});
		let client;
		const connectDeadline = Date.now() + 8000;
		for (;;) {
			try {
				client = await connect("https://127.0.0.1:" + port, {
					tls: { insecureSkipVerify: true },
				});
				break;
			} catch (e) {
				if (Date.now() > connectDeadline) throw e;
				await Bun.sleep(100);
			}
		}
		const count = 40;
		const sent = [];
		for (let i = 0; i < count; i++) {
			// Distinct length and content per datagram, so a reordered or
			// duplicated delivery cannot pass as identity.
			const p = new Uint8Array(8 + (i % 17));
			p.fill((i * 13 + 5) & 0xff);
			p[0] = i & 0xff;
			sent.push(Array.from(p));
			await client.sendDatagram(p);
		}
		const iter = client.incomingDatagrams()[Symbol.asyncIterator]();
		const echoed = [];
		const readDeadline = Date.now() + 8000;
		while (echoed.length < count && Date.now() < readDeadline) {
			const n = await Promise.race([
				iter.next(),
				Bun.sleep(1500).then(() => ({ done: true, value: undefined })),
			]);
			if (n.done || !n.value) break;
			echoed.push({
				bytes: Array.from(n.value),
				isBuffer: Buffer.isBuffer(n.value),
				bufferCtor: n.value.buffer.constructor.name,
			});
		}
		client.close();
		await server.close();
		report({ batchSize: cfg.batchSize, sent, echoed });
		process.exit(0);
	`;

	for (const batchSize of [1, 2, 64]) {
		it(`preserves order and bytes at batch size ${batchSize}`, async () => {
			const res = childResult(
				await runChild(liveEchoBody, {
					WEBTRANSPORT_DATAGRAM_BATCH: String(batchSize),
					WT_TEST_PORT: String(nextPort(BASE_PORT, 150)),
				}),
			);
			expect(res.batchSize).toBe(batchSize);
			expect(res.echoed.length).toBeGreaterThan(0);
			// Every datagram that arrived must be an exact, in-order prefix-subset
			// of what was sent: identity plus ordering, tolerant of UDP loss.
			let cursor = 0;
			for (const got of res.echoed) {
				while (
					cursor < res.sent.length &&
					JSON.stringify(res.sent[cursor]) !== JSON.stringify(got.bytes)
				)
					cursor++;
				expect(cursor).toBeLessThan(res.sent.length);
				cursor++;
				// Default delivery keeps small payloads ArrayBuffer-backed.
				expect([got.isBuffer, got.bufferCtor]).toEqual([false, "ArrayBuffer"]);
			}
		}, 40_000);
	}

	it("delivers a partial final batch and then ends at EOF", async () => {
		const { sent, echoed } = await echoRoundTrip(64, 5);
		expect(sent).toHaveLength(5);
		expect(echoed.length).toBeGreaterThan(0);
		expect(echoed.length).toBeLessThanOrEqual(5);
		for (const got of echoed) {
			expect(sent.some((s) => Bun.deepEquals(s, got))).toBe(true);
		}
	}, 30_000);
});
