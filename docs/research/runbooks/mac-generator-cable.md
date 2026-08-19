# Cable day: this Mac as the off-box load generator

**Status:** prepared 2026-08-19, link not yet connected. Everything marked
`[verified]` was run on this Mac today; everything marked `[human]` needs the
cable and a person; everything marked `[ssh]` can be automated once the link is
up. Nothing in the "Verified now" section depends on the cable.

**Topology**

```
  this Mac (arm64, 10 cores, 64 GB)          Windows host `home-windows`
  ┌──────────────────────────┐               ┌──────────────────────────────┐
  │  load generator          │               │  Hyper-V                     │
  │  10.99.0.1/24            │──── cable ────│  external vSwitch "bench"    │
  │  (Wi-Fi keeps the        │               │      │                       │
  │   default route)         │               │      └── runner VM           │
  └──────────────────────────┘               │          10.99.0.2/24        │
                                             │          (LAN 192.168.2.35   │
                                             │           stays for CI/ssh)  │
                                             └──────────────────────────────┘
```

The runner VM keeps its existing LAN NIC. The cable adds a *second* NIC used for
nothing but bench traffic, so a mistake on the bench subnet cannot take the
self-hosted runner off GitHub mid-dispatch.

Why this Mac rather than `v-ubuntu-loadgen`: 10 cores vs 3 vCPU, 64 GB vs a
1280 MB static allocation that has already failed two power-ons for host-RAM
slack, and no Hyper-V internal-switch hop on the generator side. The loadgen VM
stays as the documented fallback; do not power it on for this path.

---

## Verified now (no cable required)

| Check | Result |
| --- | --- |
| `cargo test -p reference` on `rebind4-staging` | 6/6 pass, arm64 |
| `cargo test -p reference` on `probe/latency-01` tree | 20/20 pass, incl. `latency_probe::tests::monotonic_clock_advances` |
| `cargo test -p reference` on `probe/session-scale-01` tree | 20/20 pass |
| `load-client --release` (latency-stamped) builds | yes, 40.9 s cold |
| `scale-client --release` builds | yes |
| Generator runs end-to-end here | 20 sessions × 50/s against `reference-server` on loopback: `sessions ok=20 err=0`, `datagrams sent=7994 err=0`, RTT histogram populated (min 134 µs, max 350 µs), `PASS` |
| `CLOCK_MONOTONIC` FFI pin | `bun test tools/offbox/mac-clock-pin.test.ts` — 6/6; clock id 6 confirmed to be uptime not epoch, sub-10 µs resolution, `Bun.nanoseconds()` offset drift 459 ns over 200 ms (fast path qualifies) |
| Pre-flight harness | `bun test tools/offbox/preflight.test.ts` — 32/32; parsers additionally checked against real macOS `ping` and real `iperf3 3.21` JSON produced on this box |
| ssh entrypoint refusals | `bun test tools/offbox/mac-generator-entry.test.ts` — 8/8 |
| `iperf3` | present, 3.21, `/opt/homebrew/bin/iperf3` |

**Clock scope.** RTT is single-clock and therefore valid off-box. One-way
latency is *not* available across the cable — two hosts, two counters, no shared
epoch — so every off-box design must be RTT-gated. The on-box `ingest` /
`egressOneWay` legs stop being meaningful the moment the generator moves here.

---

## Predicted link ceiling — read this before registering a gate

This Mac already has a **USB 10/100/1000 LAN** adapter configured
(`networksetup -listallnetworkservices`). If that is the adapter the cable
plugs into, the link is 1 GbE, and at the gates' 1150 B payload the wire's
own ceiling is:

```
on-wire frame = 1150 payload + 8 UDP + 20 IPv4 + 14 Ethernet + 4 FCS
              + 8 preamble/SFD + 12 inter-frame gap   = 1216 B = 9728 bits
1 Gbit/s ÷ 9728 bits                                  ≈ 102,800 pps
```

So a 1 GbE cable tops out around **103k pps at 1150 B** — essentially the same
number as the on-box Cubic pipe (~105k) that the ceiling attribution already
closed. That is fine for G2 (15k aggregate, ~7× headroom) and for every other
gate on the current ledger, but it does **not** deliver the 160k the ceiling
closure named as needing a physical path. 2.5 GbE would give ~257k pps.

Action: on cable day, record the negotiated speed (step 6) before assuming this
path lifts anything. If it is 1 GbE, the honest statement is "off-box removes
generator co-residence", not "off-box raises the ceiling".

---

## Cable day

### 1. `[human]` Physical

Plug the cable between this Mac's Ethernet adapter and the spare NIC on
`home-windows`. If the Windows box has only one NIC, stop — the LAN NIC must not
be repurposed or the runner leaves GitHub.

### 2. `[human]` Windows: an external vSwitch on the new NIC

Hyper-V Manager → Virtual Switch Manager → New virtual network switch →
External → select the **new** NIC → name it `bench`.

**Leave "Allow management operating system to share this network adapter"
UNCHECKED.** With it unchecked the Windows host takes no address on the bench
link, the frames are switched straight to the VM, and Windows Firewall is not in
the path at all — which removes a whole class of cable-day mystery. It also
means you cannot ping the Windows host over the cable; that is intended.

PowerShell equivalent (as Administrator):

```powershell
Get-NetAdapter                       # find the new NIC's Name
New-VMSwitch -Name bench -NetAdapterName "<NIC name>" -AllowManagementOS $false
```

### 3. `[human]` Windows: give the runner VM a second NIC

```powershell
Add-VMNetworkAdapter -VMName "<runner VM name>" -SwitchName bench -Name bench
```

The VM can stay running; Hyper-V hot-adds NICs to Generation 2 VMs. Confirm the
existing LAN adapter is untouched:

```powershell
Get-VMNetworkAdapter -VMName "<runner VM name>"   # expect two, LAN + bench
```

### 4. `[ssh]` Runner VM: address the new NIC

Over the *existing* LAN ssh (`192.168.2.35`), never over the new link:

```bash
ip -br link                                  # the new NIC appears, no address
sudo tee /etc/netplan/60-bench.yaml >/dev/null <<'EOF'
network:
  version: 2
  ethernets:
    <new-iface>:
      addresses: [10.99.0.2/24]
      dhcp4: false
      # No gateway and no nameservers: the LAN NIC keeps the default route, so
      # a bench-subnet mistake cannot take the runner off GitHub.
EOF
sudo netplan apply
ip -br addr show <new-iface>                 # expect 10.99.0.2/24
ip route | head                              # default route must still be the LAN one
```

If `ufw` is active, allow the bench subnet only:

```bash
sudo ufw status
sudo ufw allow from 10.99.0.0/24 to any port 4400:4500 proto udp   # gate ports
sudo ufw allow from 10.99.0.0/24 to any port 5201 proto tcp        # iperf3 control
sudo ufw allow from 10.99.0.0/24 to any port 5201 proto udp        # iperf3 data
```

### 5. `[human]` This Mac: address the interface

System Settings → Network → the Ethernet adapter → Details → TCP/IP →
Configure IPv4: **Manually**

* IP address `10.99.0.1`
* Subnet mask `255.255.255.0`
* **Router: blank**, DNS: blank

The blank router is the important part: it keeps the default route on Wi-Fi so
only `10.99.0.0/24` crosses the cable. Then drag the Ethernet service **below**
Wi-Fi in Network → … → Set Service Order.

Command-line equivalent (needs admin):

```bash
networksetup -listallnetworkservices                 # find the service name
sudo networksetup -setmanual "<service>" 10.99.0.1 255.255.255.0
sudo networksetup -setdnsservers "<service>" Empty
```

Then confirm nothing else claimed the subnet — this Mac currently has **five
active `utun` interfaces** (Tailscale, v2RayTun) and any of them could answer
for a peer address:

```bash
route -n get 10.99.0.2 | grep interface     # must be the cable's enN, never utunN
```

### 6. `[human]` Record the negotiated link speed

```bash
networksetup -getMedia "<service>"           # expect "1000baseT" on a 1 GbE adapter
```

Anything reporting `100baseTX` means a bad cable or a bad port — re-seat before
measuring, or every number below is a fact about the cable rather than the path.

### 7. `[ssh]` Start iperf3 on the runner, then pre-flight from the Mac

On the runner (over LAN ssh), bound to the bench address so a mis-routed test
cannot silently run over the LAN:

```bash
iperf3 -s -B 10.99.0.2 -p 5201
```

On this Mac:

```bash
# See exactly what it will do first — this executes nothing.
bun tools/offbox/preflight.ts --peer 10.99.0.2 --plan

# The real thing (~2.5 minutes: 60 s of ping plus 6 × 15 s UDP rungs).
bun tools/offbox/preflight.ts --peer 10.99.0.2 \
    --out .bench-evidence/preflight-$(date +%F).json
```

Expected, on a healthy 1 GbE cable:

| Phase | Expect |
| --- | --- |
| route | `interface en7` (or whatever the adapter is) — **never** `utunN` |
| MTU | 3/3 DF pings at 1472 B → `mtuBytes: 1500` |
| RTT | 0% loss, `p50Ms` 0.15–0.4, `p99Ms` under ~1 |
| TCP | ~940 Mbit/s |
| UDP | `lossPct` at or under 0.5 up to ~100k pps, then rising |
| ceiling | `cleanPpsCeiling` ≈ 95k–103k |

The harness **refuses** rather than measures if the peer is a Tailscale address,
a `192.168.2.x` LAN address, outside `10.99.0.0/24`, or routes over a tunnel.
Both falsified generator paths — Wi-Fi (64% loss) and Tailscale (3.3k pps) — are
reachable from this Mac by name, so they are refused by name.

### 8. `[human]` Provision the generator clone

The runner cannot build a macOS binary, so this Mac builds its own from the
candidate SHA. One-time:

```bash
git clone <repo> ~/wt-macgen
cd ~/wt-macgen && cargo build --release -p reference --bin load-client   # warms the cache
```

`tools/offbox/mac-generator-entry.sh` then fetches and checks out the candidate
on each invocation and refuses a dirty clone, an abbreviated SHA, or a branch
name. Keep the clone dedicated: it gets `git checkout --detach`ed under you.

### 9. `[human]` Enable runner→Mac ssh (only if orchestration option B is taken)

System Settings → General → Sharing → **Remote Login: on**, "Allow access for"
limited to your user. Then, from the runner over the LAN, install its key:

```bash
ssh-copy-id -i ~/.ssh/<runner key>.pub <mac-user>@10.99.0.1
ssh <mac-user>@10.99.0.1 tools/offbox/mac-generator-entry.sh --candidate <sha> --plan
```

Scope it to the cable subnet in the macOS application firewall, and remember to
turn Remote Login back off when the gate campaign ends.

### 10. `[human]` Keep the Mac awake for the run

```bash
caffeinate -dimsu -w $$          # or prefix the dispatch: caffeinate -dims <cmd>
```

A generator that sleeps mid-arm produces a schedule-lag tail that looks exactly
like a saturated generator.

---

## The STOP rule a gate registers

Copy into the gate's pre-registration, filling in the gate's own numbers:

> **Link validity.** This run is offered over the direct Mac↔runner cable
> (`10.99.0.0/24`). The run is INVALID unless a pre-flight artifact from the
> **same calendar day** shows the path carrying at least the gate's offered
> aggregate rate of `<N>` datagrams/s at `1150` B with loss at or under
> `<L>`%, an MTU of at least `1500` B, and an idle RTT p99 at or under
> `<R>` ms. The pre-flight is written before the gate runs and its hash is
> logged in the dispatch record. A run whose pre-flight fails any clause is
> reported incomplete; it is not re-run against a second pre-flight taken
> afterwards.

Machine-checkable, so no one has to eyeball it:

```ts
import { evaluatePreflight } from "./tools/offbox/preflight-lib.ts";

const verdict = evaluatePreflight(artifact, {
  offeredPps: 15_000,
  maxLossPct: 0.5,
  payloadBytes: 1150,
  runDateIso: runStartedAt,
  minMtuBytes: 1500,
  maxIdleRttP99Ms: 2,
});
// verdict.reasons lists every failing clause, not just the first.
```

Two deliberate strictnesses. The payload must match: pps is the hard currency on
this rig and a 1500 B pre-flight does not license a 1150 B gate — the pps at the
same bitrate differ by about 30%. And the ceiling is read off the best rung that
stayed *under the loss bound*, never the best rung: the off-box BBR arm
delivered more while dropping 52%, and that is a fact about the path, not a
capacity.

---

## Orchestration: how a dispatched job drives a generator on this Mac

The runner-side job owns the server; the Mac owns the generator. Two shapes were
considered.

### Option A — rendezvous (orchestrator drives both ends)

The dispatched workflow runs the server arm only and publishes readiness; the
Mac-side orchestrator polls for it and starts the generator in lockstep.

*Against it, decisively:* the evidence rules for this effort require one
dispatch producing one artifact with one hash on the candidate tree. A
rendezvous splits the evidence across two hosts that share no clock, adds a
handshake whose failure mode is a half-run that still writes a plausible
artifact, and makes "was the generator the candidate?" unanswerable from the
dispatch record. It also needs a readiness channel that UDP does not provide.

### Option B — runner→Mac ssh **(recommended)**

The dispatched job spawns the generator on the Mac over ssh, exactly the shape
the h7 off-box sweep already used for `v-ubuntu-loadgen`
(`SWEEP_OFFBOX_SSH` / `WT_PROBE_OFFBOX_SSH`, `worker-load-sweep.ts`). One
dispatch, one artifact, provenance folded in, and the existing classifier's
`offboxSsh != null` remote-marking check keeps working — that check exists
precisely to stop a mislabelled local run from being read as off-box.

Cost: one human step (step 9) that cable day pays anyway.

**Three ways the loadgen-VM precedent does not transfer, all of them fatal if
missed:**

1. **`timeout(1) does not exist on macOS.`** The precedent's invocation is
   `ssh dest timeout N load-client ...`. Against this Mac that fails with
   "command not found" and the harness sees an empty run with a successful ssh.
   `mac-generator-entry.sh` carries its own watchdog and reports
   `macgen: exit=watchdog` so a deadline kill is distinguishable from a
   load-client failure.
2. **The binary cannot be shipped.** The precedent `scp`ed a Linux binary to a
   Linux VM. A Linux runner cannot produce a macOS/arm64 `load-client`, so the
   Mac builds from the candidate SHA and reports what it built.
3. **A non-interactive ssh shell has no `cargo`.** No profile is sourced, so
   Homebrew and the rustup shims are off `PATH`. The entrypoint sets it
   explicitly.

### Interface contract for the gate harness

A gate invokes the generator as:

```
ssh -o BatchMode=yes <mac-dest> tools/offbox/mac-generator-entry.sh \
    --candidate <40-hex sha> --deadline <seconds> \
    -- <load-client argv, with --url https://10.99.0.2:<port>>
```

and reads the result with `parseGeneratorReport(stdout, candidateSha)` from
`tools/offbox/generator-report.ts`.

* Everything after `--` reaches `load-client` untouched and in order.
* stdout carries `macgen:` provenance lines interleaved with load-client's own
  stdout, verbatim and unreordered, so existing `load-client:` parsers keep
  working unchanged.
* Exit `0` = load-client's success; `3` = provenance or build failure (never a
  result); `4` = the watchdog fired (an infra fault under the rerun policy, not
  a miss); anything else is load-client's own code.
* `parseGeneratorReport` returns a `problems[]` that is empty only when the run
  is stampable: header present, head equals the candidate, clone clean, binary
  hashed, no watchdog, and a `latency-json` that parsed.

**The floor arm.** The honesty floor is the *generator's* schedule lag, so an
off-box gate must read it from the Mac's own `latency-json` — a floor measured
on the runner describes a machine that is not producing the load.
`floorReportIsUsable(report, expectedGeneratorHost)` enforces that: it refuses a
floor whose `macgen: host=` is not the generator, and refuses a floor taken over
zero driving sessions. Mechanically this means the conductor's floor cells go
through the *same* generator launcher as its measurement cells — the floor rung
is a rung, not a special case — and the classifier's existing floor statistics
(median across floor arms, quiet check, drift spread) are then applied to the
Mac's histogram exactly as they are applied on-box. Nothing in this module
re-derives a percentile; `latency-histogram.ts` remains the single answer.

One measured caution for whoever registers the floor bound: in today's local
smoke (20 sessions × 50/s, unloaded Mac, `--arrival uniform`) `scheduleLag` ran
a **871 µs mean with a 40.6 ms maximum**. That maximum is a wake-lateness
outlier on an idle machine with no cable and no gate load, and it says the Mac's
floor must be *measured on the day* rather than assumed to be small because the
host is big. Do not carry the loadgen VM's floor across.

---

## What remains for cable day

Human, in order: steps 1, 2, 3, 5, 6, 8, 10, plus 9 if option B is taken.
Automatable once the link is up: steps 4 and 7.

Nothing above changes a gate registration; tickets 25–27 own those. This
document and `tools/offbox/` are prep only.
