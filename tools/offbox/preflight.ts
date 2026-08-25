#!/usr/bin/env bun
/**
 * Cable pre-flight: characterize the Mac↔runner link before any gate trusts it.
 *
 * The off-box work that came before this measured a virtual-switch path whose
 * raw capacity (163k pps, 0% loss on clean seconds) had nothing to do with what
 * QUIC delivered over it (62k on Cubic, 42k on BBR). The lesson is not that the
 * link measurement was wrong — it is that a gate that never measured the link
 * cannot tell a transport result from a path result. So the link becomes a
 * *registered property* of the run: this writes down what the cable carried, on
 * the day of the run, at the gate's payload size, and `evaluatePreflight` decides
 * whether that licenses the gate.
 *
 * Nothing here assumes the cable exists. `--plan` prints every command with its
 * expected output and executes none of it, which is how the harness is reviewed
 * and how the runbook's expected outputs stay honest.
 *
 * Phases:
 *   guard   — refuse anything but the registered cable subnet (LAN and Tailscale
 *             are both reachable from this Mac and both are falsified paths)
 *   route   — the peer must route over a real interface, never `utun*`
 *   mtu     — largest DF-set ICMP payload that crosses
 *   rtt     — idle p50/p99 from per-packet samples, not ping's average
 *   tcp     — iperf3 TCP, one number for "is the wire plausibly 1 GbE"
 *   udp     — iperf3 UDP rate sweep at the gate payload; loss per rung
 *   ceiling — highest delivered pps under the registered loss bound
 *
 * Usage:
 *   bun tools/offbox/preflight.ts --peer 10.99.0.2 --plan
 *   bun tools/offbox/preflight.ts --peer 10.99.0.2 --out .bench-evidence/preflight.json
 *
 * The peer must be running `iperf3 -s` (see the runbook). Everything else is
 * local.
 */

import { mkdirSync } from "node:fs";
import { arch, cpus, hostname, platform, totalmem } from "node:os";
import { dirname } from "node:path";
import { canonicalGeneratorIdentity } from "./host-identity.ts";
import {
	chooseRttBaseline,
	DEFAULT_CABLE_SUBNET,
	derivePpsCeiling,
	guardPeerAddress,
	type IperfTcpResult,
	interfaceIsTunnelled,
	mtuFromDfPayload,
	PREFLIGHT_SCHEMA_VERSION,
	type PreflightArtifact,
	parseIperf3Tcp,
	parseIperf3Udp,
	parseRouteInterface,
	pingSaysTooBig,
	type RttBaseline,
	summarizeRtt,
	type UdpRung,
} from "./preflight-lib.ts";

type Options = {
	peer: string;
	subnet: string;
	payloadBytes: number;
	/** Offered rates for the UDP sweep, in Mbit/s. */
	rateSweepMbit: number[];
	udpSeconds: number;
	tcpSeconds: number;
	pingCount: number;
	/** Largest DF payload to try; 1472 B is a 1500 B path. */
	mtuProbeMax: number;
	lossBoundPct: number;
	iperfPort: number;
	out: string | null;
	/**
	 * ssh destination on the peer used to take the idle-RTT baseline from the
	 * peer's side of the wire (peer pings the generator). Registered by §11c
	 * amendment 2 of gate-g10-broadcast: the generator's own ping stamps its
	 * samples through 4–9 ms of send-side scheduling jitter the wire does not
	 * have; the generator-side baseline stays in the artifact, disclosed.
	 */
	rttPeerSsh: string | null;
	plan: boolean;
};

function parseArgs(argv: string[]): Options {
	const opts: Options = {
		peer: "",
		subnet: DEFAULT_CABLE_SUBNET,
		payloadBytes: 1150,
		// 1 GbE at 1150 B is ~108k pps. The sweep straddles that: the top rungs
		// exist to find the ceiling, not to be reached.
		rateSweepMbit: [100, 250, 500, 750, 900, 1000],
		udpSeconds: 15,
		tcpSeconds: 10,
		// 60 s at ping's non-root floor of 0.1 s. 600 samples puts the 99th at the
		// sixth-worst — thin for a tail, and labelled as a baseline, not a gate.
		pingCount: 600,
		mtuProbeMax: 1472,
		lossBoundPct: 0.5,
		iperfPort: 5201,
		out: null,
		rttPeerSsh: null,
		plan: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = () => argv[++i] ?? "";
		switch (arg) {
			case "--peer":
				opts.peer = next();
				break;
			case "--subnet":
				opts.subnet = next();
				break;
			case "--payload-bytes":
				opts.payloadBytes = Number(next());
				break;
			case "--rates-mbit":
				opts.rateSweepMbit = next()
					.split(",")
					.map((v) => Number(v.trim()))
					.filter((v) => Number.isFinite(v) && v > 0);
				break;
			case "--udp-seconds":
				opts.udpSeconds = Number(next());
				break;
			case "--tcp-seconds":
				opts.tcpSeconds = Number(next());
				break;
			case "--ping-count":
				opts.pingCount = Number(next());
				break;
			case "--loss-bound-pct":
				opts.lossBoundPct = Number(next());
				break;
			case "--iperf-port":
				opts.iperfPort = Number(next());
				break;
			case "--out":
				opts.out = next();
				break;
			case "--rtt-peer-ssh":
				opts.rttPeerSsh = next();
				break;
			case "--plan":
				opts.plan = true;
				break;
			default:
				throw new Error(`preflight: unknown argument ${arg}`);
		}
	}
	if (!opts.peer) throw new Error("preflight: --peer is required");
	return opts;
}

type Step = { what: string; argv: string[]; expect: string };

/**
 * Every command the pre-flight runs, as data.
 *
 * Built before anything executes so `--plan` and the real run cannot drift: the
 * runbook's expected outputs are printed from the same list the run uses.
 */
function steps(opts: Options): Step[] {
	// The generator is historically the Mac; a Linux generator (rented rig)
	// speaks iproute2 and spells don't-fragment differently.
	const linux = process.platform === "linux";
	const list: Step[] = [
		{
			what: "route",
			argv: linux
				? ["ip", "route", "get", opts.peer]
				: ["route", "-n", "get", opts.peer],
			expect: `interface: the cable's interface (enX / bridgeX), never utunN — a utun means Tailscale answered`,
		},
		{
			what: "mtu",
			argv: [
				"ping",
				...(linux ? ["-M", "do"] : ["-D"]),
				"-c",
				"3",
				"-s",
				String(opts.mtuProbeMax),
				opts.peer,
			],
			expect: `3 packets received, 0.0% loss → path MTU ${mtuFromDfPayload(opts.mtuProbeMax)}; "message too long" means the path is smaller`,
		},
		{
			what: "rtt",
			argv: ["ping", "-c", String(opts.pingCount), "-i", "0.1", opts.peer],
			expect:
				"0.0% loss, sub-millisecond times on a direct cable (0.15-0.4 ms is typical)",
		},
		...(opts.rttPeerSsh
			? [
					{
						what: "rtt-peer",
						argv: [
							"ssh",
							opts.rttPeerSsh,
							`ping -c ${opts.pingCount} -i 0.1 <generator-cable-address>`,
						],
						expect:
							"the same wire from the peer's side; this baseline is what evaluatePreflight reads, the generator-side one stays disclosed",
					},
				]
			: []),
		{
			what: "tcp",
			argv: [
				"iperf3",
				"-c",
				opts.peer,
				"-p",
				String(opts.iperfPort),
				"-J",
				"-t",
				String(opts.tcpSeconds),
			],
			expect:
				"~940 Mbit/s receiver on 1 GbE; a number near 100 Mbit/s means the link negotiated 100BASE-TX",
		},
	];
	for (const mbit of opts.rateSweepMbit) {
		list.push({
			what: `udp@${mbit}M`,
			argv: [
				"iperf3",
				"-c",
				opts.peer,
				"-p",
				String(opts.iperfPort),
				"-J",
				"-u",
				"-b",
				`${mbit}M`,
				"-l",
				String(opts.payloadBytes),
				"-t",
				String(opts.udpSeconds),
			],
			expect: `lost_percent <= ${opts.lossBoundPct} up to the ceiling, then rising; ${Math.round((mbit * 1e6) / (opts.payloadBytes * 8))} pps offered`,
		});
	}
	return list;
}

async function run(argv: string[]): Promise<{
	stdout: string;
	stderr: string;
	exitCode: number;
}> {
	const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));
	const plan = steps(opts);

	if (opts.plan) {
		console.log(
			`preflight --plan: peer=${opts.peer} subnet=${opts.subnet} payload=${opts.payloadBytes}B lossBound=${opts.lossBoundPct}%`,
		);
		console.log(
			`preflight --plan: guard = ${JSON.stringify(guardPeerAddress(opts.peer, opts.subnet))}`,
		);
		for (const step of plan) {
			console.log(
				`\n[${step.what}]\n  $ ${step.argv.join(" ")}\n  expect: ${step.expect}`,
			);
		}
		console.log(
			`\npreflight --plan: peer must be running  iperf3 -s -p ${opts.iperfPort}  (see docs/research/runbooks/mac-generator-cable.md)`,
		);
		return;
	}

	const notes: string[] = [];
	const guards: PreflightArtifact["guards"] = [];

	const addressGuard = guardPeerAddress(opts.peer, opts.subnet);
	guards.push({
		name: "peer-on-cable-subnet",
		ok: addressGuard.ok,
		detail: addressGuard.ok
			? `${opts.peer} in ${opts.subnet}`
			: addressGuard.reason,
	});
	if (!addressGuard.ok) {
		// A refused address is not a slow pre-flight, it is the wrong wire. Stop
		// before producing numbers that would read as if they were the cable's.
		console.error(`preflight: REFUSED\n  ${addressGuard.reason}`);
		process.exit(2);
	}

	const startedAt = new Date().toISOString();

	// route ------------------------------------------------------------------
	const routeStep = plan.find((s) => s.what === "route");
	const routeOut = routeStep ? await run(routeStep.argv) : null;
	const interfaceName = routeOut ? parseRouteInterface(routeOut.stdout) : null;
	const routeOk =
		interfaceName !== null && !interfaceIsTunnelled(interfaceName);
	guards.push({
		name: "peer-routes-over-wire",
		ok: routeOk,
		detail:
			interfaceName === null
				? "route -n get produced no interface"
				: routeOk
					? `interface ${interfaceName}`
					: `interface ${interfaceName} is a tunnel, not the cable`,
	});
	if (!routeOk) {
		console.error(
			`preflight: REFUSED\n  ${opts.peer} routes over ${interfaceName ?? "(unknown)"} — not the cable`,
		);
		process.exit(2);
	}

	// mtu ---------------------------------------------------------------------
	let mtuPayload: number | null = null;
	const mtuStep = plan.find((s) => s.what === "mtu");
	if (mtuStep) {
		const res = await run(mtuStep.argv);
		const text = `${res.stdout}\n${res.stderr}`;
		const loss = /0 packets received|100(?:\.0)?% packet loss/.test(text);
		if (res.exitCode === 0 && !loss) {
			mtuPayload = opts.mtuProbeMax;
		} else {
			notes.push(
				pingSaysTooBig(text)
					? `DF ping at ${opts.mtuProbeMax} B was rejected as too long — path MTU is below ${mtuFromDfPayload(opts.mtuProbeMax)}`
					: `DF ping at ${opts.mtuProbeMax} B did not come back; MTU unestablished`,
			);
		}
	}

	// rtt ---------------------------------------------------------------------
	let generatorRtt: RttBaseline | null = null;
	const rttStep = plan.find((s) => s.what === "rtt");
	if (rttStep) {
		const res = await run(rttStep.argv);
		generatorRtt = summarizeRtt(res.stdout);
		if (generatorRtt.samples === 0)
			notes.push("idle ping produced no RTT samples");
	}

	// rtt from the peer's side of the same wire --------------------------------
	let peerRtt: RttBaseline | null = null;
	const rttPeerStep = plan.find((s) => s.what === "rtt-peer");
	if (rttPeerStep) {
		// macOS `route -n get` prints a `local:` line only for some route kinds;
		// the interface's own address is authoritative when it doesn't.
		let localAddress = routeOut
			? (routeOut.stdout.match(/^\s*local:\s*(\S+)/m)?.[1] ?? "")
			: "";
		if (!localAddress && interfaceName) {
			const res =
				process.platform === "linux"
					? await run(["ip", "-o", "-4", "addr", "show", "dev", interfaceName])
					: await run(["ipconfig", "getifaddr", interfaceName]);
			localAddress =
				process.platform === "linux"
					? (res.stdout.match(/inet (\S+?)\//)?.[1] ?? "")
					: res.stdout.trim();
		}
		if (!localAddress) {
			notes.push(
				"rtt-peer requested but neither the route lookup nor the interface produced a local address; peer baseline not taken",
			);
		} else {
			const argv = rttPeerStep.argv.map((a) =>
				a.replace("<generator-cable-address>", localAddress),
			);
			const res = await run(argv);
			peerRtt = summarizeRtt(res.stdout);
			if (peerRtt.samples === 0) {
				notes.push(
					`peer-side idle ping produced no RTT samples: ${res.stderr.slice(0, 200)}`,
				);
				peerRtt = null;
			}
		}
	}
	const { rtt, vantage: rttVantage } = chooseRttBaseline(generatorRtt, peerRtt);

	// tcp ---------------------------------------------------------------------
	let tcp: IperfTcpResult | null = null;
	const tcpStep = plan.find((s) => s.what === "tcp");
	if (tcpStep) {
		const res = await run(tcpStep.argv);
		try {
			tcp = parseIperf3Tcp(JSON.parse(res.stdout));
		} catch (err) {
			notes.push(
				`iperf3 TCP failed: ${String(err)} ${res.stderr.slice(0, 200)}`,
			);
		}
	}

	// udp sweep ---------------------------------------------------------------
	const udpRungs: UdpRung[] = [];
	for (const [index, mbit] of opts.rateSweepMbit.entries()) {
		const step = plan.find((s) => s.what === `udp@${mbit}M`);
		if (!step) continue;
		console.log(
			`preflight: udp rung ${index + 1}/${opts.rateSweepMbit.length} at ${mbit} Mbit/s (${opts.payloadBytes} B)`,
		);
		const res = await run(step.argv);
		try {
			const rung = parseIperf3Udp(JSON.parse(res.stdout), opts.payloadBytes);
			rung.offeredBitsPerSec = mbit * 1e6;
			udpRungs.push(rung);
			console.log(
				`preflight:   offered=${Math.round(rung.offeredPps)}pps delivered=${Math.round(rung.deliveredPps)}pps loss=${rung.lossPct.toFixed(3)}% jitter=${rung.jitterMs?.toFixed(3) ?? "n/a"}ms`,
			);
		} catch (err) {
			notes.push(
				`iperf3 UDP ${mbit}M failed: ${String(err)} ${res.stderr.slice(0, 200)}`,
			);
		}
	}

	const ceiling =
		udpRungs.length > 0 ? derivePpsCeiling(udpRungs, opts.lossBoundPct) : null;

	const artifact: PreflightArtifact = {
		schemaVersion: PREFLIGHT_SCHEMA_VERSION,
		startedAt,
		generator: {
			hostname: canonicalGeneratorIdentity(hostname()),
			platform: platform(),
			arch: arch(),
			cpus: cpus().length,
			memoryBytes: totalmem(),
		},
		link: {
			// The local address is whatever the kernel picks for this peer; recorded
			// from the route lookup's interface rather than guessed.
			localAddress: routeOut
				? (routeOut.stdout.match(/^\s*local:\s*(\S+)/m)?.[1] ?? "")
				: "",
			peerAddress: opts.peer,
			subnet: opts.subnet,
			interfaceName,
			mtuBytes: mtuPayload === null ? null : mtuFromDfPayload(mtuPayload),
			mtuProbePayloadBytes: mtuPayload,
		},
		guards,
		rtt,
		rttVantage,
		rttGeneratorSide: generatorRtt,
		tcp,
		udpRungs,
		ceiling,
		registeredProperties: {
			mtuBytes: mtuPayload === null ? null : mtuFromDfPayload(mtuPayload),
			idleRttP50Ms: rtt?.p50Ms ?? null,
			idleRttP99Ms: rtt?.p99Ms ?? null,
			cleanPpsCeiling: ceiling?.cleanPps ?? null,
			lossBoundPct: opts.lossBoundPct,
			payloadBytes: opts.payloadBytes,
		},
		notes,
	};

	const out =
		opts.out ?? `.bench-evidence/preflight-${startedAt.slice(0, 10)}.json`;
	mkdirSync(dirname(out), { recursive: true });
	await Bun.write(out, `${JSON.stringify(artifact, null, 2)}\n`);
	console.log(
		`preflight: wrote ${out} — mtu=${artifact.link.mtuBytes ?? "n/a"} rttP50=${rtt?.p50Ms ?? "n/a"}ms rttP99=${rtt?.p99Ms ?? "n/a"}ms (${rttVantage}) tcp=${tcp ? (tcp.bitsPerSec / 1e6).toFixed(0) : "n/a"}Mbit/s cleanPps=${ceiling?.cleanPps ? Math.round(ceiling.cleanPps) : "n/a"}`,
	);
	for (const note of notes) console.warn(`preflight: note — ${note}`);
}

if (import.meta.main) {
	await main();
}
