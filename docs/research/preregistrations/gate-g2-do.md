# Preregistration — gate g2-do (id `g2-do/1`)

Registered before any licensed measurement runs; frozen at registration time,
sha256 carried by the run inputs. A failed rung is diagnosed, never
re-thresholded.

## 1. Relationship to G2

Gate G2 (FPS/MOBA tail latency) closed on the home rig as **hardware-scoped
INCOMPLETE, final**: both licensed attempts fired decision row 3
(`path-not-quiet` — off-box floor RTT p99 8.1–12.6 ms against the 4.0 ms
quiet bar), the measured cause being generator-side scheduler wake lateness
(floor `scheduleLag` p99 7.9–10.5 ms). That ruling is spent *for that rig*
and is not reopened. This gate asks G2's registered question on a **new rig
authority** whose whole selection rationale is that it removes the measured
cause: a rented pair of DigitalOcean `c-32-intel` droplets whose VPC idles at
sub-millisecond RTT p99 and whose generator scheduler wake lag measured
~2 ms p99 under load in the same day's G6-sharded qualification.

## 2. Incorporation by reference

The question, the 22-cell schedule, the gate rung (`G-off`, 100 sessions ×
150/s × 1150 B echo, 10 replicates, RTT bound **10.0 ms** p99), every clause,
every decision row, and every falsifier are those of the original G2
registration `registrations/g2-games.md` (sha256 `a971d8512020eece7b7d…`) and
of the frozen classifier `tools/load/latency-rtt-classify.ts` at this
candidate — **imported from G2 candidate `a1e18fd9` byte-identical in every
threshold** (`FLOOR_NOT_QUIET_MS = 4.0` included: the quiet bar that ended G2
at home stands unchanged here, and firing it on this rig would be a genuine,
terminal finding about the rig class). The two-attempt pre-ruling resets
under this authority: two licensed attempts, then final, whatever the rows
say.

## 3. Registered deltas (the port, all reviewed at this candidate)

1. **Data-path declaration.** `LATENCY_RTT_DATA_SUBNET=10.110.0` (the rig
   VPC /24). The family-LAN refusal is unconditional; the declared prefix is
   pinned here and echoed by the run environment
   (`tools/load/g2-offbox.ts dataSubnetPrefix`).
2. **Generator entry twin.** The generator is a Linux droplet running
   `tools/offbox/linux-generator-entry-g2.sh` — the Mac entry's twin: same
   CLI, same provenance lines, same watchdog and exit-code contract; only
   toolchain path defaults and the hash tool differ. Deployed at the entry
   path the conductor's `LATENCY_OFFBOX_ENTRY` names; its sha256 is recorded
   by the conductor per PD-1 and pinned in the scratch registration at
   deploy time.
3. **Codec-test alignment.** Three expectations in the imported
   `latency-instrumentation.test.ts` updated to the v3 stamp decode shape
   (fields the current shared codec returns; no threshold involved), plus
   `g2-offbox.test.ts` gaining the subnet-declaration cases of delta 1.
4. **Instrument restoration.** The intervening G6 refactor had stripped
   `load-client`'s latency mode (`--latency-stamp`/`--arrival`/`--tick-hz`
   and its probe), and the binary swallows unknown flags silently — the
   critic's review caught that the pinned instrument could not measure.
   `crates/reference/src/load_client.rs` is restored byte-for-byte from
   `a1e18fd9`; the shared `latency_probe.rs` gains only per-bin
   `#[allow(dead_code)]` on its v3-only items.
5. **Reproducible host falsifier.** The classifier's O2 no longer imports
   the home-cable constant: the conductor records the declared prefix in
   each cell's generator fragment (`dataSubnetPrefix`), and O2 grades
   `urlHost` against the *artifact's* recorded prefix — historical
   artifacts without the field grade under `10.99.0` unchanged, and the
   family-LAN refusal is unconditional either way. The independent re-grade
   must assert the recorded prefix equals the registered `10.110.0` and
   that every off-box `urlHost` is inside it.
6. **Entry-twin binding.** At grade time, the manifest's `entrySha256` must
   equal the sha256 of `tools/offbox/linux-generator-entry-g2.sh` as read
   from the candidate tree (`git show <candidate>:…`) — a deploy-time pin
   alone would let a doctored twin pin itself. The dispatch environment
   sets `LATENCY_RTT_OFFBOX_ENTRY` explicitly; the conductor's manifest
   `preregistration` field is inherited-stale (it names the home gate's
   page) and runs under this dispatch are governed by this document.

Everything else in the imported suite is unchanged from `a1e18fd9`; the
candidate below carries all six deltas.

## 4. Identities

- Candidate: `41631974d6373894f2c1905a0ba83d9ee8f0d26d`
  (`probe/g6-pace-drain-01`, pushed).
- Rig: 2 × DO `c-32-intel`, ams3, shared VPC, ubuntu-26-04; identities
  recorded in the scratch registration at creation. Server droplet runs the
  conductor+server; generator droplet builds and runs `load-client` at the
  candidate via the entry twin.
- Producer/classifier: `tools/load/latency-rtt-conduct.ts` /
  `tools/load/latency-rtt-classify.ts` at the candidate; verdict reproduced
  independently from the run artifacts on a second machine, byte-identical.

## 5. Run rules

Same-day rig qualification precedes dispatch: the G6-sharded quartet
(R-down/R-up with `--subnet 10.110.0.0/24`, the bidirectional loaded leg,
sink precheck) must grade clean — it qualifies the same wire this gate's
floor arms then measure on the registered terms. One licensed dispatch of
the full 22-cell schedule per attempt; infra refusals (droplet provisioning,
entry-twin staging, conductor pre-dispatch refusals) retain artifacts and
license same-day redispatch; a completed run is graded as the decision rows
say. Two attempts maximum under this authority, then final.
