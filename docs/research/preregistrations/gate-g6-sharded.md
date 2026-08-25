# Preregistration — gate g6-sharded (id `g6-sharded/1`)

Registered before any licensed measurement runs. This document is frozen at
registration time; its sha256 is carried by the run inputs and echoed into the
evidence. A failed rung is diagnosed, never re-thresholded.

## 1. Question

Does a pair of DigitalOcean `c-32-intel` droplets (32 dedicated Intel vCPU,
64 GB, AMS3, VPC private networking), with the server deployed in its intended
horizontally-sharded shape — **16 instances sharing one UDP port via
SO_REUSEPORT, steered by QUIC-LB connection IDs through the
`steer_by_cid` eBPF program** — sustain the registered MMO steady shape at
each rung of the ladder within the clauses of §3?

The registered MMO steady shape, per session (identical to gate
`g6-mmo-closeout/1` §1.2): upstream 4 datagrams/s of 64 B (every 8th an
acked action), downstream demand 5 snapshot ticks/s × 3 datagrams × 1150 B,
through a 120 s steady window, 128 client endpoints, connect concurrency 500.

## 2. Ladder

Three rungs, each graded independently; the run dispatches all three in one
session of the rig, sequentially, smallest first:

- **5000** — the shape gate g6-mmo-closeout/1 stamped as a valid MISS on the
  home rig; here it binds that stamp to this deployment shape.
- **15000** — the strong-evidence rung: prior characterization (retained,
  `.scratch/do-rig-2026-08-25/`) showed every clause green with margin.
- **20000** — the frontier rung: characterization evidence is mixed on S3
  (emitter duty 96.8–98.5 % in the neighbourhood); a MISS here is a genuine,
  acceptable outcome and is the reason this rung is registered.

## 3. Clauses (frozen in `tools/load/g6-sharded-grade.ts`, `G6_SHARDED_CLAUSES`)

Per rung:

- **S1 ingest** — server-ingested upstream / client-sent upstream (steady
  window) ≥ **0.995**
- **S2 delivery** — client-received snapshots (steady+drain) / server-issued
  ≥ **0.995**. The issued figure is the **steady+drain** emitter counter:
  emission stops at the steady edge, so the drain tail contains only
  late-resolved bookings of steady-window sends — the steady-only counter
  systematically undercounts at the hot edge (async result booking) and
  would inflate this clause.
- **S3 duty** — server-issued snapshots (same steady+drain counter) /
  registered demand (sessions × 15 × 120) ≥ **0.99**
- **S4 ack RTT** — client ack RTT p99 (steady+drain) ≤ **25 ms**
- **S5 session survival** — sessions lost during steady ≤ **0.1 %** of the
  rung

A rung with every clause passing is a PASS; any clause failing is a MISS.
Both are terminal verdicts for that rung under this registration.

## 4. Validity (refusals, not misses; `G6_SHARDED_VALIDITY`)

A rung produces no verdict if any of: candidate SHA mismatch; configured
shard count ≠ 16; client endpoints ≠ 128; paced emitter enabled (the
registered emitter is the per-player batch path with persistent buffers);
steady window ≠ 120 s; conductor or client exit nonzero; any connect error
(`sessionsErr > 0`); emitter send errors ≠ 0; zero snapshots issued; empty
ack-RTT histogram; **shard survival** — fewer than 16 shard entries with
complete boundary windows, duplicate server ids, or per-shard
sessions-at-steady not summing to the rung (a shard dying mid-steady must
refuse, never deflate the aggregate into an honest-looking MISS); **window
integrity** — any shard's steady window wall-clock outside 120 s ± 250 ms
(event-loop-clocked marks stretch under load and would inflate S1).

Run-scoped: the post-run `steer_stats` dump must show steered short-header
packets ≥ **0.9 ×** the summed steady upstream across all rungs. A merely
non-zero bound would validate a 99.9 %-kernel-hash run on residue; the
fallback counter cannot serve, since it legitimately holds every Initial.

## 5. Producer, grader, and independence

- Producer: `tools/load/g6-sharded-scan.ts` (schema `g6-sharded-scan/1`) with
  `tools/load/g6-shard-server.ts` shards, at the registered candidate.
- Grader: `tools/load/g6-sharded-grade.ts` at the same candidate. The
  verdict JSON is produced on the rig and independently reproduced from the
  raw scan artifacts on a second machine; both runs must agree byte-for-byte
  on the `rungs` array.
- The registration document (scratch side) pins: candidate SHA, this file's
  sha256, droplet identities, and the same-day rig-qualification artifacts.

## 6. Rig qualification (same day, before dispatch)

All four must grade clean over the VPC path, using the campaign's registered
tools with `--subnet` set to the VPC:

- R-down: ≥ 75k pps clean at 1150 B, loss ≤ 0.1 %, idle RTT p99 ≤ 5 ms,
  MTU ≥ 1280
- R-up: ≥ 20k pps clean at 64 B, loss ≤ 0.1 %
- **Bidirectional loaded leg** (this campaign's addition, mandatory since the
  home-rig generator failed exactly here): simultaneous 750 Mbit/s @ 1150 B
  down + 12 Mbit/s @ 64 B up for 20 s, 0.5 % loss ceiling each direction
- Sink precheck on the generator: ≥ 116,250 pps offered, delivery ≥ 0.995

## 7. Run rules

One licensed dispatch of the three-rung ladder. The BPF maps are freshly
re-pinned (`tools/load/g6-shard-bpf-setup.sh 16`) immediately before
dispatch, which zeroes `steer_stats` — qualification residue never feeds the
steering floor. The dump is taken with exactly
`bpftool map dump pinned /sys/fs/bpf/quic-lb/steer_stats -j` after the last
rung; an unusable dump is a refusal, not an error.

Infrastructure refusals (droplet provisioning, BPF pin setup, connect-phase
stall before steady) retain their artifacts and license a redispatch the
same day. A rung that reaches its steady window is graded from that attempt
— except that a **validity refusal** (any §4 item other than the run-scoped
steering floor) also licenses one same-day redispatch of that rung: a flaky
connect error must cost a retry, not leave the rung permanently
verdict-less. Caveat, accepted at registration: if frontier-rung overload
ever migrates into the connect phase, that rung can only refuse, never
produce its registered acceptable MISS — a refusal there is itself a
finding. Rungs are graded independently: an invalid rung does not
invalidate its siblings (except the steering floor, which invalidates all).
