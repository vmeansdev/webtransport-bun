# DigitalOcean Droplet Runbook for G6 Sharded Diagnostics

**Status:** operator runbook for temporary benchmark infrastructure only
**Scope:** `g6-sharded-diagnostic-01` and explicitly registered successors
**Last updated:** 2026-08-28

## 1. Safety boundary

This runbook describes a temporary two-Droplet benchmark rig for
`g6-sharded-diagnostic-01` and any successor that is explicitly registered to
reuse the same procedure. It is not a production deployment guide. It assumes
an already authenticated local `doctl` context. Never print or persist access
tokens, SSH private keys, or other credentials in terminal output, logs, or
artifacts.

Public Droplet addresses are for administration only. The measured path is the
private VPC path between the server and generator. This runbook does not grant
campaign approval, dispatch authority, threshold authority, or validity
authority.

## 2. Authority and precedence

Use these authorities in this order:

1. Tracked frozen protocol:
   `docs/research/preregistrations/gate-g6-sharded.md`
2. Externally supplied candidate registration:
   `.scratch/bare-metal-campaign/registrations/g6-sharded-diagnostic-01.md`
3. Externally supplied common campaign rules:
   `.scratch/bare-metal-campaign/registration-common.md`

The current registration binds the candidate SHA, registration digest, Droplet
identities, profile, rung list, and same-day qualification evidence. If either
external registration artifact is absent, stop before any dispatch or
provisioning work. `DISPATCH_HANDOFF.md` or any other handoff note may
coordinate work, but it is not threshold authority or validity authority.

## 3. Registration-supplied rig profile

Before provisioning, the operator must have a registration-supplied
`RIG_PROFILE` manifest. Do not infer profile values from Droplet size, RAM, or
historical runs. The manifest must define:

- `PROFILE_ID`
- `DO_REGION`
- `DO_SIZE`
- `RAM_GB`
- `DO_IMAGE`
- `DO_SSH_KEY_ID`
- `DO_VPC_UUID` or `DEFAULT_VPC=true`
- `DO_PROJECT_ID` when applicable
- `RUN_TAG`
- `SERVER_NAME`
- `GENERATOR_NAME`
- `SHARD_COUNT`
- `BPF_MAX_INSTANCES`
- `SERVER_ID_MIN`
- `SERVER_ID_MAX`
- `RUNG_LIST`
- `FRONTIER_RUNG`
- `ENDPOINT_COUNT`
- `CONNECT_CONCURRENCY`
- `UDP_BUFFER_AND_SYSCTL_PROFILE`
- `ULIMIT_PROFILE`
- `BUN_BIN`
- `RSS_LIMIT_MB`
- `CONNECT_TIMEOUT_SECONDS`
- `CANDIDATE_SHA`
- `PREREGISTRATION_SHA256`

`SHARD_COUNT`, BPF map size, server ID range, tuning profile, rung list,
endpoint count, and connect concurrency are profile inputs. They are not
derived from `DO_SIZE`, `RAM_GB`, vCPU count, or any universal sizing rule.

`BUN_BIN` must be an absolute path to the registered or bundled Bun runtime.
It must not point at Node, and it must not be the forbidden mise Node path
`/Users/vmeansdev/.local/share/mise/installs/node/23.9.0/bin/node`.

Current registered-gate compatibility is effectively
`ENDPOINT_COUNT=128` and `CONNECT_CONCURRENCY=500`, but those two values are
constrained by different mechanisms and must be treated distinctly in operator
checks.

## 4. Pre-mutation local run identity

Before any `doctl compute` create, delete, tag, project, or other resource
mutation, define a unique-per-run `RUN_ID`, a unique-per-run `RUN_TAG`, and a
unique-per-run `EVIDENCE_DIR`:

1. Define an operator-scoped `RUN_ID` that is unique for this run.
2. Define a `RUN_TAG` that is unique for this run.
3. Define an `EVIDENCE_DIR` path that is unique for this run and create it immediately.
4. Validate that `BUN_BIN` exists and is executable.
5. Reject the forbidden mise Node path.
6. Record the Bun version from `BUN_BIN`.

Example shell shape:

```bash
export RUN_ID="g6-sharded-diagnostic-01-$(date -u +%Y%m%dT%H%M%SZ)-${USER}"
export RUN_TAG="g6-sharded-diagnostic-01-${USER}-$(date -u +%Y%m%dT%H%M%SZ)"
export EVIDENCE_DIR=".scratch/do-rig-runs/${RUN_ID}"
mkdir -p "$EVIDENCE_DIR"

test -x "$BUN_BIN"
test "$BUN_BIN" != "/Users/vmeansdev/.local/share/mise/installs/node/23.9.0/bin/node"
"$BUN_BIN" --version > "$EVIDENCE_DIR/bun-version.txt"
```

The same `RUN_ID`, `RUN_TAG`, and `EVIDENCE_DIR` must not be reused across
separate runs. Retain `EVIDENCE_DIR` after failures. Preserve stdout, stderr,
and exit status for every provisioning, qualification, dispatch, evidence, and
teardown step. Do not print credentials while capturing those artifacts.

## 5. Current frozen profile and planning boundaries

This table is planning input only. It is not a verdict table, and it does not
license a run by itself.

| Profile role | Size | RAM | Session band | Shards |
| --- | --- | ---: | --- | --- |
| Current frozen G6 gate | `c-32-intel` | 64 GB | registered `5000,15000,20000` on the current candidate | registered 16 |
| c-32 scale planning | `c-32-intel` | 64 GB | planning through 1m | `S_32`, registration-bound |
| c-60 scale planning | `c-60-intel` | 120 GB | planning 1.5m-2m | `S_60 > S_32`, registration-bound |
| Other sizes such as `c-40-intel` | registration-bound | registration-bound | registration-bound | registration-bound |

The 1m and 1.5m-2m entries are planning targets, not historical PASS claims.
Larger vCPU counts may require more registered shards where the candidate and
grader support them, but the capacity research does not justify a universal
shards-per-vCPU formula.

## 6. Current-candidate compatibility stop

Before touching the rig, compare profile values against the current whole path:

- Producer: `tools/load/g6-sharded-scan.ts`
- Server wrapper: `tools/load/g6-shard-server.ts`
- Grader: `tools/load/g6-sharded-grade.ts`
- BPF setup path: `tools/load/g6-shard-bpf-setup.sh`

The current candidate hard-stops when `SHARD_COUNT > 16`. The scan conductor
rejects `SCAN_SHARDS > 16`, the server wrapper rejects server IDs outside
`1..16`, and the grader requires exactly 16 shard entries. Passing `16` to the
BPF setup alone is insufficient because the BPF script does not expand the rest
of the path. Any future `>16` profile requires a source-bound successor and a
registration that expands the producer, server wrapper, grader, and BPF path
together.

For endpoint count, the producer defaults `SCAN_ENDPOINTS` to `64` and passes
the selected endpoint count through to the scan artifact. The current
preregistration and grader validity contract require `ENDPOINT_COUNT=128`, so
this runbook must explicitly set and verify `128` before dispatch rather than
claiming the producer rejects other values.

For connect concurrency, `tools/load/g6-sharded-scan.ts` fixes
`CONNECT_CONCURRENCY` at `500`. That value is not profile-plumbed, separately
recorded as an operator-selected parameter, or independently graded, so `500`
is an effective source compatibility requirement for the current candidate, not
a claim of runtime validation.

This runbook therefore refuses any non-`128` endpoint profile or non-`500`
connect-concurrency profile before dispatch because the current
registration/source/evidence contract cannot support it. Future endpoint or
concurrency values require source plumbing plus grader and preregistration
changes before rig work starts.

## 7. Preflight checklist before provisioning

Do not provision until all of the following are true:

- `doctl` is authenticated in the operator's local context.
- The three authority inputs in §2 are present and match the intended
  candidate.
- `RIG_PROFILE` is complete.
- `RUN_ID`, `RUN_TAG`, and `EVIDENCE_DIR` are defined and recorded.
- `BUN_BIN` has been validated and its version recorded.
- The operator has explicitly set and verified `ENDPOINT_COUNT=128`.
- The profile still satisfies the current-candidate compatibility stop in §6,
  including effective `CONNECT_CONCURRENCY=500`.
- The operator is prepared to preserve raw artifacts and stop on missing
  authority inputs rather than guessing defaults.

## 8. Provisioning and dispatch rule

When the preflight passes, provision exactly the server and generator named by
the registration, in the registered region and VPC configuration, and treat the
private VPC addresses as the measurement path. Record the resulting Droplet
identities and addresses in `EVIDENCE_DIR`. If any authority input, profile
input, or compatibility requirement is missing or mismatched, stop before
creating or mutating DigitalOcean resources. In particular, refuse dispatch if
the runbook has not explicitly set and verified `ENDPOINT_COUNT=128`, or if the
effective producer path does not remain at `CONNECT_CONCURRENCY=500`.

This runbook remains procedural only. Campaign approval, rung validity, and
terminal verdicts still come from the registration-bound campaign process, not
from the existence of this document.
