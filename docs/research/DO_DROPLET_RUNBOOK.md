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
and endpoint count are profile inputs. They are not
derived from `DO_SIZE`, `RAM_GB`, vCPU count, or any universal sizing rule.

`RUN_TAG` is not registration-supplied profile data. Generate it at run start
as a unique run-scoped value and retain it with the run's local artifacts.

`BUN_BIN` must be an absolute path to the registered or bundled Bun runtime.
It must not point at Node, and it must not be the forbidden mise Node path
`/Users/vmeansdev/.local/share/mise/installs/node/23.9.0/bin/node`.

Current registered-gate compatibility is effectively
`ENDPOINT_COUNT=128` and `CONNECT_CONCURRENCY=500`, but those two values are
constrained by different mechanisms and must be treated distinctly in operator
checks.

`CONNECT_CONCURRENCY` may appear in the manifest only as a compatibility mirror
of the current source-fixed value. On this candidate it is not a runtime tuning
knob the registration may vary.

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
export RUN_UUID="$(uuidgen | tr 'A-Z' 'a-z')"
export RUN_ID="g6-sharded-diagnostic-01-${RUN_UUID}"
export RUN_TAG="g6-sharded-diagnostic-01-${RUN_UUID}"
export EVIDENCE_PARENT=".scratch/do-rig-runs"
export EVIDENCE_DIR="$(mktemp -d "${EVIDENCE_PARENT}/${RUN_ID}.XXXXXX")"

test -d "$EVIDENCE_DIR"
test ! -e "${EVIDENCE_PARENT}/${RUN_ID}"

test -x "$BUN_BIN"
test "$BUN_BIN" != "/Users/vmeansdev/.local/share/mise/installs/node/23.9.0/bin/node"
"$BUN_BIN" --version > "$EVIDENCE_DIR/bun-version.txt"
```

The same `RUN_ID`, `RUN_TAG`, and `EVIDENCE_DIR` must not be reused across
separate runs. Before any resource mutation, fail closed if `RUN_ID`,
`RUN_TAG`, or `EVIDENCE_DIR` collides with an existing run record, and do not
silently reuse an existing artifact directory. Retain `EVIDENCE_DIR` after
failures. Preserve stdout, stderr, and exit status for every provisioning,
qualification, dispatch, evidence, and teardown step. Do not print credentials
while capturing those artifacts.

## 5. Authenticated `doctl` account preflight

Before any create attempt, verify the operator is using the intended local
authenticated `doctl` context. Use the default context only. Never pass
`--access-token`, never paste tokens into shell history, and never treat
historical SSH key IDs, public IPs, private IPs, or Droplet IDs as defaults.

Run and preserve the raw output for each command:

```bash
doctl version
doctl account get --format UUID,Status,DropletLimit
doctl compute region list --format Slug,Name,Available
doctl compute size list --format Slug,Memory,VCPUs,Disk,PriceHourly
doctl vpcs list --format ID,Name,IPRange,Region,Default
doctl compute ssh-key list --format ID,Name,FingerPrint
doctl compute image list --public --format Slug,Distribution,Created
doctl projects list --format ID,Name,IsDefault --output json
```

For each command above, preserve stdout, stderr, and exit status under the raw
evidence directory for the run.

Expected postconditions:

- `doctl version` returns the locally installed CLI version that will be used
  for the run. Record that exact version in the run manifest.
- `doctl account get` returns an authenticated account UUID, account status,
  and Droplet limit. Stop on authentication failure, locked account status, or
  any account state that prevents creating the registered rig.
- `doctl compute region list` shows the registered `DO_REGION` and it must be
  available for creation in that account.
- `doctl compute size list` shows the registered `DO_SIZE`. Record the
  selected size slug and its resolved memory and vCPU values in the run
  manifest. Do not infer a profile from some other visible size.
- `doctl vpcs list` shows either the explicit `DO_VPC_UUID` from the
  registration or one default VPC in the registered region when
  `DEFAULT_VPC=true`.
- `doctl compute ssh-key list` shows the selected SSH key ID and fingerprint.
  Record the chosen key ID in the run manifest. Historical SSH key IDs are
  evidence only, never defaults.
- `doctl compute image list --public` shows the selected public image slug.
  Record the chosen slug in the run manifest.
- `doctl projects list --output json` is the authority for project binding. If
  the profile is project-bound, resolve `DO_PROJECT_ID` from this output and
  record the project ID, project name, and `IsDefault` value in the run
  manifest. Later verification must use that same resolved UUID. If the run is
  not project-bound, record that explicitly. If the run uses the default
  project, record that explicitly too rather than implying it.

The run manifest must record all of the following before create:

- selected image slug;
- selected SSH key ID;
- selected region;
- selected size slug plus resolved RAM and vCPU values;
- project ID, project name, and default-project status, or an explicit
  no-project/default-project statement;
- VPC ID, VPC name, region, and whether the run is using an explicit VPC UUID
  or `DEFAULT_VPC=true`; and
- the exact `doctl` version.

Stop before provisioning if authentication fails or if no eligible region,
size, image, SSH key, VPC, or project selection can be resolved from these
outputs.

## 6. Unique-run tag collision preflight

`EVIDENCE_DIR` is already unique and fail-closed from §4. Before any create,
prove that the run-scoped `RUN_TAG` does not already resolve to existing
Droplets:

```bash
doctl compute droplet list \
  --tag-name "$RUN_TAG" \
  --format ID,Name,PublicIPv4,PrivateIPv4,Region,VPCUUID,Status,Tags \
  --output json
```

The expected result is an empty JSON array. Preserve that raw empty-list output
under `EVIDENCE_DIR`. Any returned match is a stop condition. Resolve the
collision manually before retrying. Never adopt, recycle, or silently reuse an
older Droplet because its name or tag appears to match the current run.
Preserve stdout, stderr, and exit status for this collision check as well.

## 7. Two-Droplet create template

Provision exactly two Droplets and only with explicit profile variables:
`SERVER_NAME`, `GENERATOR_NAME`, `DO_REGION`, `DO_SIZE`, `DO_IMAGE`,
`DO_SSH_KEY_ID`, and the unique `RUN_TAG`. Support conditional project binding
only when `DO_PROJECT_ID` is non-empty. Support exactly one networking mode:
either explicit `--vpc-uuid "$DO_VPC_UUID"` or `--enable-private-networking`
when `DEFAULT_VPC=true`. Never imply both, and never silently fall back from
one mode to the other.

Use a shell shape that does not emit an empty project flag:

```bash
project_args=()
if [ -n "$DO_PROJECT_ID" ]; then
  project_args=(--project-id "$DO_PROJECT_ID")
fi

network_args=()
if [ "${DEFAULT_VPC:-false}" = "true" ] && [ -n "$DO_VPC_UUID" ]; then
  printf '%s\n' "ambiguous VPC selection: set exactly one of DO_VPC_UUID or DEFAULT_VPC=true" >&2
  exit 1
elif [ "${DEFAULT_VPC:-false}" = "true" ]; then
  network_args=(--enable-private-networking)
elif [ -n "$DO_VPC_UUID" ]; then
  network_args=(--vpc-uuid "$DO_VPC_UUID")
else
  printf '%s\n' "missing VPC selection: set DO_VPC_UUID or DEFAULT_VPC=true" >&2
  exit 1
fi

doctl compute droplet create "$SERVER_NAME" "$GENERATOR_NAME" \
  --region "$DO_REGION" \
  --size "$DO_SIZE" \
  --image "$DO_IMAGE" \
  --ssh-keys "$DO_SSH_KEY_ID" \
  --tag-names "$RUN_TAG" \
  "${project_args[@]}" \
  "${network_args[@]}" \
  --wait \
  --output json | tee "$EVIDENCE_DIR/droplet-create.json"
```

Preserve stdout, stderr, and exit status for the create command in
`EVIDENCE_DIR`. The `tee` example above shows the stdout capture target and
does not replace separate stderr and exit-status preservation. Do not embed
historical addresses, credentials, Droplet IDs, or fixed project/VPC values in
the template. If create returns fewer than two Droplets, returns non-success
status, or leaves one role missing, stop and treat that as partial or failed
provisioning rather than repairing it by reusing old resources.

## 8. Identity capture and verification before SSH

Before any SSH or benchmark bootstrap, capture the resulting identities and
prove the rig matches the selected profile:

```bash
doctl compute droplet list \
  --tag-name "$RUN_TAG" \
  --format ID,Name,PublicIPv4,PrivateIPv4,Memory,VCPUs,Region,VPCUUID,Status,Tags \
  --output json | tee "$EVIDENCE_DIR/droplets.json"
doctl projects resources list "$DO_PROJECT_ID" \
  --format URN,AssignedAt,Status --output json \
  | tee "$EVIDENCE_DIR/project-resources.json"
doctl compute droplet get "$SERVER_ID" --format ID,Name,PublicIPv4,PrivateIPv4,VPCUUID,Status --output json \
  | tee "$EVIDENCE_DIR/server.json"
doctl compute droplet get "$GENERATOR_ID" --format ID,Name,PublicIPv4,PrivateIPv4,VPCUUID,Status --output json \
  | tee "$EVIDENCE_DIR/generator.json"
```

Run `doctl projects resources list` only when `DO_PROJECT_ID` is non-empty.
Preserve stdout, stderr, and exit status for each command separately even when
also using `tee` for stdout capture.

Required verification before SSH:

- exactly two Droplets match `RUN_TAG`;
- both Droplets are `active`;
- one Droplet is `SERVER_NAME` and one is `GENERATOR_NAME`;
- `SERVER_ID` and `GENERATOR_ID` resolve to distinct Droplets with distinct
  operator roles;
- both Droplets are in the registered region;
- both Droplets are attached to the expected VPC identity for the selected
  network mode;
- both Droplets resolve to the expected size characteristics, including the
  registered RAM and vCPU values captured during §5;
- both Droplets have private VPC addresses present; and
- when project-bound, `project-resources.json` includes URNs for both Droplet
  IDs with matching project assignment.

Public IPv4 addresses are for SSH administration only. The measured path is
always the private VPC path. All generator target addresses and all recorded
server service addresses must use the Droplet private IPs, never the public
addresses. Missing private networking, unexpected VPC placement, or any
identity mismatch is a stop condition.

## 9. Stop conditions for provisioning

Stop and preserve artifacts without guessing a fix when any of the following is
true:

- authentication fails or the default `doctl` context is not usable;
- no eligible region, size, image, SSH key, VPC, or project selection is
  visible in the authenticated account output;
- the unique-run collision preflight returns any existing tagged Droplet;
- create returns partial, failed, or ambiguous output;
- the identity capture shows anything other than exactly two active matching
  Droplets with distinct server/generator roles;
- project binding is required but cannot be resolved or later verified;
- private networking is absent, ambiguous, or not the measured path; or
- expected RAM, vCPU, region, VPC, tag, or name identity does not match the
  selected run manifest.

No broad cleanup shortcuts are permitted here: no `--all`, no wildcard target
selectors, no broad tag delete, and no implicit reuse of old resources by
name, tag, address, or remembered Droplet ID.

## 10. Current frozen profile and planning boundaries

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

## 11. Current-candidate compatibility stop

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

## 12. Preflight checklist before provisioning

Do not provision until all of the following are true:

- `doctl` is authenticated in the operator's local context and the account
  preflight in §5 has been captured.
- The three authority inputs in §2 are present and match the intended
  candidate.
- `RIG_PROFILE` is complete.
- `RUN_ID`, `RUN_TAG`, and `EVIDENCE_DIR` are defined and recorded.
- The run-tag collision check in §6 returned an empty list and was preserved in
  raw evidence.
- The selected project and network mode are explicit and unambiguous under
  §§5-8.
- `BUN_BIN` has been validated and its version recorded.
- The operator has explicitly set and verified `ENDPOINT_COUNT=128`.
- The profile still satisfies the current-candidate compatibility stop in §11,
  including effective `CONNECT_CONCURRENCY=500`.
- The operator is prepared to preserve raw artifacts and stop on missing
  authority inputs rather than guessing defaults.

## 13. Provisioning and dispatch rule

When the preflight passes, provision exactly the server and generator named by
the registration by following §§6-8: empty collision result first, then one
two-Droplet create call, then identity verification before SSH. Keep the
registered region, selected project binding, and one explicit VPC mode aligned
with the run manifest, and treat the private VPC addresses as the measurement
path. If any authority input, profile input, preflight output, or compatibility
requirement is missing or mismatched, stop before creating or mutating
DigitalOcean resources. In particular, refuse dispatch if the runbook has not
explicitly set and verified `ENDPOINT_COUNT=128`, if the effective producer
path does not remain at `CONNECT_CONCURRENCY=500`, or if the measured path is
not the private VPC network.

This runbook remains procedural only. Campaign approval, rung validity, and
terminal verdicts still come from the registration-bound campaign process, not
from the existence of this document.
