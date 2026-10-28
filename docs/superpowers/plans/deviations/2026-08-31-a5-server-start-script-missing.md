# Deviation — A5 server start script `/tmp/ws-wt-start-server.sh` is missing

**Date:** 2026-08-31
**Candidate:** `8f5cc723` (fresh A5 stage-only re-run)
**Plan:** unchanged (Plan SHA `9374b7470223655bff5d118c1a8812f62e62515aa8ac56e38ff61eb4f4b961d9`)

## Discovery

The honest A5 focused re-run (Architect + Critic APPROVED) executed
section 9.5 against HEAD `8f5cc723`, candidate `busyms-attested-focused-r1`,
purpose `focused`. Real-time run results:

```
EXACT_STAGE_APPROVAL_OK
controller: mac supervisor pid=20629 (control pipes ready)
controller: rig supervisor pid=20805 (ssh control channel ready)
controller: seal FAIL bulk-one-way/physical/ws rep 1: E_TLS: WebSocket open failed
controller: seal FAIL bulk-one-way/physical/wt rep 1: E_HANDSHAKE_TIMEOUT: connect timed out after 10000ms
controller: focused index finalized under .release-evidence/transport-comparison/8f5cc723c7352d24ae127fa38cc8d3029a174d3b/busyms-attested-focused-r1 with zero flats (0 PASS / 2 index entries)
controller real-run: ok, evidence at .release-evidence/transport-comparison/8f5cc723c7352d24ae127fa38cc8d3029a174d3b/busyms-attested-focused-r1/campaign-index.json
TRUST_PROTOCOL: expectedPassCount 2 got 0
```

The Mac↔rig control channels came up; both WS and WT seal attempts failed
immediately because the rig-side server never bound. Inspecting the rig
shows the actual root cause:

```
$ ssh hermes-admin@10.99.0.2 ls -la /tmp/ws-wt-start-server.sh
ls: cannot access '/tmp/ws-wt-start-server.sh': No such file or directory
$ ssh hermes-admin@10.99.0.2 ls -la /tmp/ws-wt-server.log
-rw-rw-r-- 1 hermes-admin hermes-admin 0 Aug 31 22:15 /tmp/ws-wt-server.log
```

`/tmp/ws-wt-start-server.sh` is the script the controller SSH-invokes on the
rig to start the server (`tools/compare/bin/compare-controller.ts:2450`):

```bash
setsid nohup /tmp/ws-wt-start-server.sh --transport ws --scenario bulk-one-way \
  --port 4433 --bind 10.99.0.2 --run-id busyms-attested-focused-r1-... \
  </dev/null >/tmp/ws-wt-server.log 2>&1 & disown; sleep 2; ...
```

That script is not created anywhere in the repo, the rig supervisor, or the
controller's setup flow. A `grep -rn "ws-wt-start-server" tools/compare`
returns only the invocation site — no producer. The rig-side `setsid nohup
… </dev/null >/tmp/ws-wt-server.log 2>&1 & disown` makes the failure
silent: the wrapper command always exits 0 (`pid-attempt-done` is printed
after the spawn line completes regardless of whether the script existed),
so the controller never knows the server failed to start. The Mac client
then times out (E_TLS for WS, E_HANDSHAKE_TIMEOUT for WT).

## A5 stop gate

Plan §8.A5 stop gate: "exactly two indexed measured primary PASS entries,
both `promotable:false`; zero FAIL/REFUSED; zero flats." This run
honestly produced 0 PASS / 2 FAIL / 0 REFUSED / 0 flats. The stop gate
is **not** met. Phase B must not start.

## Resolution path (out of A5 scope)

This is a runtime defect in the A3 production path, not a Phase A trust
contract issue. The fix is to either:

1. Generate `/tmp/ws-wt-start-server.sh` on the rig (via
   `stage-only install-minted` or a controller pre-arm step) and have the
   existing server-spawn command use it, or
2. Inline the server start into the controller's SSH command without the
   wrapper script, or
3. Restore whichever earlier post-A3 path used to create the wrapper.

Until this is fixed, `compare-controller.ts` cannot produce a real
`bulk-one-way/physical` PASS seal. Remediation must precede the next
A5 focused retry. Plan bytes are unchanged.

## Honest evidence retained

- Run log: `.release-evidence/transport-comparison/a5-focused-run-20260831T221527.log`
- Campaign index: `.release-evidence/transport-comparison/8f5cc723c7352d24ae127fa38cc8d3029a174d3b/busyms-attested-focused-r1/campaign-index.json`
  (0 PASS / 2 FAIL / 0 REFUSED / 0 promotable / 0 flats)
- Integrity-only evidence: `.release-evidence/transport-comparison/8f5cc723c7352d24ae127fa38cc8d3029a174d3b/busyms-attested-focused-r1/integrity-only/`
  (`terminal-kind=FAIL`, `exit-status=0`,
  `stdout=VERIFY_CAMPAIGN_INDEX_OK pass=0 fail=2 refused=0 promotable=0 sealed=0`)
- Controller terminal record: `controller-terminal.json` (controller
  self-report `terminalKind=PASS`; the controller's
  success-classifier missed the 0-PASS condition — the wrapper's
  integrity-only path correctly classified the run as FAIL).
- Staged bytes (mode 0444) under
  `.release-evidence/transport-comparison/.trust-staging/8f5cc723c7352d24ae127fa38cc8d3029a174d3b/busyms-attested-focused-r1/`.
- Architect + Critic APPROVED at
  `8f5cc723/exact-stage-architect-review.md` and
  `exact-stage-critic-review.md`.

## Theater-check

This is not theater: real Mac↔rig control channels came up, real
attempted seal produced 0 PASS / 2 FAIL, the integrity verifier
returned the correct non-zero SUMMARY, the EXIT trap ran cleanup, the
per-execution 0 PASS / 2 FAIL was honestly logged, no fixture-minted
artifacts were promoted, and the campaign root was not re-rooted for
a new HEAD to claim a fake success.
