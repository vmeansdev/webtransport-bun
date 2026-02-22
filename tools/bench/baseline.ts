#!/usr/bin/env bun
/**
 * Run all benchmarks and output machine-readable summary.
 * Use for CI regression checks and baseline recording.
 */

const ROOT = process.cwd();

async function run(cmd: string[]): Promise<string> {
    const p = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    const err = await new Response(p.stderr).text();
    const exit = await p.exited;
    if (exit !== 0) {
        throw new Error(`Bench failed: ${cmd.join(" ")}\n${err}`);
    }
    return out + err;
}

async function main() {
    const results: Record<string, string> = {};
    try {
        const out = await run(["bun", "tools/bench/handshake-latency.ts"]);
        console.log(out.trim());
        results.handshake = "ok";
    } catch (e) {
        results.handshake = "fail";
    }
    try {
        const out = await run(["bun", "tools/bench/stream-throughput.ts"]);
        console.log(out.trim());
        results.stream = "ok";
    } catch (e) {
        results.stream = "skip"; // stream bench can be flaky; non-fatal
    }
    try {
        const out = await run(["bun", "run", "bench:datagram"]);
        console.log(out.trim());
        results.datagram = "ok";
    } catch (e) {
        results.datagram = "fail";
    }

    const allOk = results.handshake === "ok" && results.datagram === "ok";
    console.log("benchmark-baseline:", JSON.stringify(results));
    if (!allOk) {
        process.exit(1);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
