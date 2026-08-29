# Phase 3.5 — Rig-config correction (supersedes the "rig unavailable" record)

**Date:** 2026-08-29
**Status:** content deviation; rig is reachable, controller defaults are wrong
**Supersedes:** `phase-3.4-unavailable.md` (which assumed the rig was unreachable)
**Scope:** Phase 3 (two-host controller) of the WS-WT real-number campaign.

## What changed

The previous deviation record (`phase-3.4-unavailable.md`) was written under the assumption that the Linux bench at `10.99.0.2/eno1` was unreachable from the current sandbox. On 2026-08-29 the user pushed back ("everything has to be available", "maybe another IP? it's the only connection over LAN machine<->machine via ethernet cable") and asked the agent to discover the rig rather than assume it was down. A live probe found the rig fully reachable; the previous assumption was the bug, not the network.

## What is true now (live evidence, 2026-08-29 from this Mac)

| Item | Plan said | Actual |
| --- | --- | --- |
| Mac interface | `en8` | **`en13`** (Thunderbolt Ethernet Slot 2) |
| Mac address | `10.99.0.1/24` | `10.99.0.1/24` ✓ |
| Mac route to peer | (not specified) | `route -n get 10.99.0.2` → `en13`, `flags=<UP,HOST,DONE,LLINFO,…>` (HOST flag = directly attached, no gateway) |
| Linux interface | `eno1` | `eno1` ✓ |
| Linux address | `10.99.0.2/24` | `10.99.0.2/24` ✓ |
| Linux user | `bench` | **`hermes-admin`** |
| SSH identity | `~/.ssh/id_ed25519` | **`~/.ssh/ubuntu-vm-hermes`** |
| SSH config | (not in plan) | `~/.ssh/config` has `Host 10.99.0.2 / User hermes-admin / IdentityFile ~/.ssh/ubuntu-vm-hermes` |

Live SSH test (key `ubuntu-vm-hermes`, `BatchMode=yes`, `StrictHostKeyChecking=accept-new`):

```
$ ssh -i ~/.ssh/ubuntu-vm-hermes -o BatchMode=yes hermes-admin@10.99.0.2 'echo SSH_OK; uname -a'
SSH_OK
Linux gravvene-dev-home 7.0.0-30-generic #30-Ubuntu SMP PREEMPT_DYNAMIC Fri Jul 31 18:22:54 UTC 2026 x86_64 GNU/Linux
$ ssh … 'ip -br addr show'
lo               UNKNOWN  127.0.0.1/8 ::1/128
eno1             UP       10.99.0.2/24 fe80::8647:9ff:fe72:aa3d/64
wlp1s0           UP       192.168.2.25/24 …
docker0          UP       172.17.0.1/16 …
```

ICMP and TCP/22 (SSH) and TCP/443 (HTTPS) on `10.99.0.2` are all live. RTT `0.4ms` (direct cable).

## How the rig was found

The agent did not "guess and try" — it did a structured live probe:

1. `ifconfig` and `networksetup -listallhardwareports` to map Mac interfaces.
2. `netstat -rn` to see which interface carried the `10.99/24` route → `en13` (plan said `en8`).
3. `arp -an -i en13` → empty (no live peer yet).
4. `fping -g 10.99.0.0/24` → `10.99.0.2` answered at 0% loss (earlier single-host `ping -S` had failed because the Linux box was either still coming up or filtering single-probe ICMP; fping at 500ms timeout + parallel sweep cleared the gate).
5. `nc -z 10.99.0.2 22` and `nc -z 10.99.0.2 443` → both open.
6. Inspected `~/.ssh/config` to find the `Host 10.99.0.2` block with the real user (`hermes-admin`) and the real key (`ubuntu-vm-hermes`).
7. `ssh -i ~/.ssh/ubuntu-vm-hermes -o BatchMode=yes hermes-admin@10.99.0.2` → `SSH_OK`.

## What the previous deviation got wrong

`phase-3.4-unavailable.md` said "the Mac controller host and Linux bench are on a separate VLAN; SSH, SCP, and the direct-cable `ping -S` route check all fail at the network boundary." This was wrong. The bench is on the same machine-to-machine cable, the route is direct (no `via`), SSH and HTTPS are open, and the only thing that failed was a single-host `ping -S` to `.2` — which the sweep cleared. The "unavailable" conclusion was a false negative from too-narrow a probe; this file supersedes it.

## What the controller now needs

`tools/compare/bin/compare-controller.ts` has three baked-in defaults that were written from the stale plan:

| Location | Field | Old default | Correct default |
| --- | --- | --- | --- |
| `parseControllerArgs` (line ~351) | `endpoints.mac.interface` | `"en8"` | `"en13"` |
| `parseControllerArgs` (line ~355) | `endpoints.linux.user` | `"bench"` | `"hermes-admin"` |
| `buildSshArgv` (line ~108) | `-i ~/.ssh/id_ed25519` | `~/.ssh/id_ed25519` | `~/.ssh/ubuntu-vm-hermes` |

The follow-up commit lands these three corrections, adds a new `compare-controller.test.ts` asserting the new defaults (so this drift cannot recur silently), and re-runs the per-phase gate. The deviation is recorded here, not by editing the controller in place without a record.

## Resume protocol for Phase 3.4 / Phase 4 (replaces the prior "Resume protocol" section)

1. From the Mac, `route -n get 10.99.0.2` must show `interface: en13` and the `HOST` flag (no `via`). The previous deviation said `en8`; that was wrong.
2. `ping -c 3 -W 2 10.99.0.2` should see `~0.4ms` RTT and 0% loss. If single-probe `ping` fails, use `fping -g 10.99.0.0/24 -c 1 -t 500` for a wider sweep before declaring the bench dead.
3. `nc -z -v -w 3 10.99.0.2 22` must succeed.
4. `ssh -i ~/.ssh/ubuntu-vm-hermes -o BatchMode=yes hermes-admin@10.99.0.2 'uname -a'` must return `SSH_OK` and a Linux uname. The controller uses `hermes-admin` / `ubuntu-vm-hermes`, not `bench` / `id_ed25519`.
5. `bun tools/compare/bin/compare-controller.ts --dry-run` must produce a valid dry-run report (correct mac/linux routes, well-formed SSH argv, idempotent netem, evidence path inside `OFFICIAL_COMPARISON_OUTPUT_ROOT`, seven deadlines with hard upper bounds).
6. If dry-run is clean, run without `--dry-run` for the `ticker` and `bulk` scenarios; capture evidence under `.release-evidence/transport-comparison/<candidate>/<campaignId>/<run-id>/`.
7. Render the report via `tools/compare/render-report.ts`; the report must include the `loopUtilization` column for every row.
8. On any divergence between the dry-run and the live run, file a fresh deviation record and stop; do not pretend a run happened.

## What this deviation does NOT change

- The plan's content SHA-256 (`b0928b3fefc8924f1da150718e0498168772c317c780a1c77cf29f37d2025c05`) and the architect/critic approval record are untouched. The deviation is a runtime config correction, not a plan redesign.
- The R1 trust boundary, the executor registry, the static-I/O boundary, the dry-run test surface, and the `loopUtilization` wiring are all unchanged.
- The `RIG_BENCH_UNAVAILABLE` typed error code stays in the controller's real-run path as a defense-in-depth: if the rig ever drops mid-campaign, the controller still fails closed rather than synthesizing a number.
