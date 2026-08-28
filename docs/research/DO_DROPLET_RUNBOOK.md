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
- `PROJECT_MODE` as exactly `bound` or `unbound`
- `DO_PROJECT_ID` when `PROJECT_MODE=bound`
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
- role-specific prerequisite declarations for Bun, Rust, and iperf3, including
  the registered remote runtime/toolchain paths
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

`PROJECT_MODE=bound` means the run is project-bound and the registration must
supply an explicit `DO_PROJECT_ID`, even when that UUID is the account's
default project. The operator must verify that exact UUID against the captured
`doctl projects list` output, pass `--project-id`, and later verify project
resource membership.

`PROJECT_MODE=unbound` is allowed only when the registration explicitly says
the run must use no project binding. In that mode, do not resolve a project
UUID, do not pass `--project-id`, and do not run project-resource verification.

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
7. Execute the remaining shell examples in a dedicated Bash session with
   `set -euo pipefail`.

Example shell shape:

```bash
set -euo pipefail

export RUN_UUID="$(uuidgen | tr 'A-Z' 'a-z')"
export RUN_ID="g6-sharded-diagnostic-01-${RUN_UUID}"
export RUN_TAG="g6-sharded-diagnostic-01-${RUN_UUID}"
export EVIDENCE_PARENT=".scratch/do-rig-runs"
mkdir -p "$EVIDENCE_PARENT"

existing_run_dir="$(
  find "$EVIDENCE_PARENT" -mindepth 1 -maxdepth 1 -type d -name "${RUN_ID}.*" -print -quit
)"
if [ -n "$existing_run_dir" ]; then
  printf '%s\n' "existing run artifact directory already matches RUN_ID" >&2
  exit 1
fi

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

Use one canonical fail-closed capture helper for every `doctl` example in this
runbook. It must preserve raw stdout, stderr, and the real exit status
separately, and it must still write the status artifact before returning a
nonzero exit under `set -euo pipefail`.

```bash
capture_doctl() {
  local label="$1"
  local stdout_ext="$2"
  shift 2

  local stdout_path="$EVIDENCE_DIR/${label}.stdout.${stdout_ext}"
  local stderr_path="$EVIDENCE_DIR/${label}.stderr.txt"
  local status_path="$EVIDENCE_DIR/${label}.status"
  local status

  if "$@" >"$stdout_path" 2>"$stderr_path"; then
    status=0
  else
    status=$?
  fi

  printf '%s\n' "$status" >"$status_path"

  if [ "$status" -ne 0 ]; then
    return "$status"
  fi
}
```

First prove the operator is in the default `doctl` context:

```bash
capture_doctl doctl-auth-list text doctl auth list --output text
grep -Fx "default (current)" "$EVIDENCE_DIR/doctl-auth-list.stdout.text"
export DOCTL_CONTEXT_NAME=default
```

Stop unless the captured context listing proves `default (current)`. Do not
print tokens. After that proof succeeds, capture the account preflight:

```bash
capture_doctl doctl-version text doctl version
capture_doctl doctl-account-get text doctl account get --format UUID,Status,DropletLimit
capture_doctl doctl-account-get-json json doctl account get --format UUID,Status,DropletLimit --output json
capture_doctl doctl-region-list text doctl compute region list --format Slug,Name,Available
capture_doctl doctl-region-list-json json doctl compute region list --format Slug,Name,Available --output json
capture_doctl doctl-size-list text doctl compute size list --format Slug,Memory,VCPUs,Disk,PriceHourly
capture_doctl doctl-size-list-json json doctl compute size list --format Slug,Memory,VCPUs,Disk,PriceHourly --output json
capture_doctl doctl-vpcs-list text doctl vpcs list --format ID,Name,IPRange,Region,Default
capture_doctl doctl-vpcs-list-json json doctl vpcs list --format ID,Name,IPRange,Region,Default --output json
capture_doctl doctl-ssh-key-list text doctl compute ssh-key list --format ID,Name,FingerPrint
capture_doctl doctl-ssh-key-list-json json doctl compute ssh-key list --format ID,Name,FingerPrint --output json
capture_doctl doctl-image-list text doctl compute image list --public --format Slug,Distribution,Created
capture_doctl doctl-image-list-json json doctl compute image list --public --format Slug,Distribution,Created --output json
capture_doctl doctl-projects-list json doctl projects list --format ID,Name,IsDefault --output json
```

Expected postconditions:

- `doctl auth list --output text` proves the operator is in the default active
  context by showing `default (current)`. Stop otherwise.
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
- `doctl projects list --output json` is the authority for project binding.
  When `PROJECT_MODE=bound`, verify that the registration-supplied
  `DO_PROJECT_ID` appears exactly once in this output, then record that
  project's UUID, name, and `IsDefault` value in the run manifest. A
  default-project run is still `PROJECT_MODE=bound`: the registration must
  still supply the explicit project UUID and the operator must still pass and
  verify it. When `PROJECT_MODE=unbound`, record that the registration
  explicitly requires no project and skip project UUID/resource verification.
- `doctl vpcs list --output json` is the authority for VPC resolution. Resolve
  exactly one `EXPECTED_VPC_UUID` plus `EXPECTED_VPC_REGION` before create and
  record them in the run manifest.

The run manifest must record all of the following before create:

- selected image slug;
- selected SSH key ID;
- selected region;
- selected size slug plus resolved RAM and vCPU values;
- `PROJECT_MODE` plus either project ID, project name, and default-project
  status for a bound run, or an explicit no-project statement for an unbound
  run;
- `EXPECTED_VPC_UUID`, VPC name, `EXPECTED_VPC_REGION`, and whether the run
  reached that UUID through explicit `DO_VPC_UUID` or `DEFAULT_VPC=true`; and
- the exact `VPC_CIDR`/`IPRange` retained for the private-path preflight; and
- the exact `doctl` version.

Stop before provisioning if authentication fails or if no eligible region,
size, image, SSH key, VPC, or project selection can be resolved from these
outputs.

Resolve and record the authenticated account and CLI identity from the
captured outputs:

```bash
DOCTL_VERSION="$(sed -n '1p' "$EVIDENCE_DIR/doctl-version.stdout.text")"
if [ -z "$DOCTL_VERSION" ]; then
  printf '%s\n' "doctl version output is empty" >&2
  exit 1
fi

DO_ACCOUNT_UUID="$(jq -er '
  if type != "object" then error("account output is not an object")
  elif ((.uuid // .UUID) | type) != "string" or ((.uuid // .UUID) | length) == 0 then error("account UUID is missing")
  elif (.status // .Status) != "active" then error("account status is not active")
  else (.uuid // .UUID)
  end
' "$EVIDENCE_DIR/doctl-account-get-json.stdout.json")"

export DOCTL_VERSION DO_ACCOUNT_UUID
```

Resolve project binding mechanically from the captured project list before any
create:

```bash
if [ "$PROJECT_MODE" = "bound" ]; then
  project_match_count="$(jq -r --arg do_project_id "$DO_PROJECT_ID" '[.[] | select(.id == $do_project_id)] | length' "$EVIDENCE_DIR/doctl-projects-list.stdout.json")"
  if [ "$project_match_count" != "1" ]; then
    printf '%s\n' "expected exactly one project match for PROJECT_MODE=bound" >&2
    exit 1
  fi

  DO_PROJECT_NAME="$(jq -r --arg do_project_id "$DO_PROJECT_ID" '.[] | select(.id == $do_project_id) | .name' "$EVIDENCE_DIR/doctl-projects-list.stdout.json")"
  DO_PROJECT_IS_DEFAULT="$(jq -r --arg do_project_id "$DO_PROJECT_ID" '.[] | select(.id == $do_project_id) | .is_default' "$EVIDENCE_DIR/doctl-projects-list.stdout.json")"

  if [ -z "$DO_PROJECT_ID" ] || [ "$DO_PROJECT_ID" = "null" ] || [ -z "$DO_PROJECT_NAME" ] || [ "$DO_PROJECT_NAME" = "null" ]; then
    printf '%s\n' "missing project UUID for PROJECT_MODE=bound" >&2
    exit 1
  fi
  export DO_PROJECT_ID DO_PROJECT_NAME DO_PROJECT_IS_DEFAULT
elif [ "$PROJECT_MODE" = "unbound" ]; then
  DO_PROJECT_ID=""
  DO_PROJECT_NAME=""
  DO_PROJECT_IS_DEFAULT=""
else
  printf '%s\n' "invalid PROJECT_MODE: expected bound or unbound" >&2
  exit 1
fi
```

Resolve one concrete `EXPECTED_VPC_UUID` before any create:

```bash
EXPECTED_MEMORY_MB="$(jq -r --arg do_size "$DO_SIZE" '.[] | select(.slug == $do_size) | .memory' "$EVIDENCE_DIR/doctl-size-list-json.stdout.json")"
EXPECTED_VCPUS="$(jq -r --arg do_size "$DO_SIZE" '.[] | select(.slug == $do_size) | .vcpus' "$EVIDENCE_DIR/doctl-size-list-json.stdout.json")"
EXPECTED_RAM_GB="$((EXPECTED_MEMORY_MB / 1024))"

if [ -z "$EXPECTED_MEMORY_MB" ] || [ "$EXPECTED_MEMORY_MB" = "null" ] || [ -z "$EXPECTED_VCPUS" ] || [ "$EXPECTED_VCPUS" = "null" ]; then
  printf '%s\n' "failed to resolve expected size characteristics" >&2
  exit 1
fi

if [ "$EXPECTED_RAM_GB" != "$RAM_GB" ]; then
  printf '%s\n' "registered RAM_GB does not match size-resolved memory" >&2
  exit 1
fi

if [ "${DEFAULT_VPC:-false}" = "true" ] && [ -n "${DO_VPC_UUID:-}" ]; then
  printf '%s\n' "ambiguous VPC selection: set exactly one of DO_VPC_UUID or DEFAULT_VPC=true" >&2
  exit 1
elif [ "${DEFAULT_VPC:-false}" = "true" ]; then
  vpc_match_count="$(jq -r --arg do_region "$DO_REGION" '[.[] | select((.region == $do_region or .region.slug == $do_region) and .default == true)] | length' "$EVIDENCE_DIR/doctl-vpcs-list-json.stdout.json")"
  if [ "$vpc_match_count" != "1" ]; then
    printf '%s\n' "expected exactly one default VPC in the registered region" >&2
    exit 1
  fi
  EXPECTED_VPC_UUID="$(jq -r --arg do_region "$DO_REGION" '.[] | select((.region == $do_region or .region.slug == $do_region) and .default == true) | .id' "$EVIDENCE_DIR/doctl-vpcs-list-json.stdout.json")"
  EXPECTED_VPC_NAME="$(jq -r --arg do_region "$DO_REGION" '.[] | select((.region == $do_region or .region.slug == $do_region) and .default == true) | .name' "$EVIDENCE_DIR/doctl-vpcs-list-json.stdout.json")"
  EXPECTED_VPC_REGION="$(jq -r --arg do_region "$DO_REGION" '.[] | select((.region == $do_region or .region.slug == $do_region) and .default == true) | (.region.slug // .region)' "$EVIDENCE_DIR/doctl-vpcs-list-json.stdout.json")"
elif [ -n "${DO_VPC_UUID:-}" ]; then
  vpc_match_count="$(jq -r --arg do_vpc_uuid "$DO_VPC_UUID" '[.[] | select(.id == $do_vpc_uuid)] | length' "$EVIDENCE_DIR/doctl-vpcs-list-json.stdout.json")"
  if [ "$vpc_match_count" != "1" ]; then
    printf '%s\n' "expected exactly one explicit VPC match" >&2
    exit 1
  fi
  EXPECTED_VPC_UUID="$DO_VPC_UUID"
  EXPECTED_VPC_NAME="$(jq -r --arg do_vpc_uuid "$DO_VPC_UUID" '.[] | select(.id == $do_vpc_uuid) | .name' "$EVIDENCE_DIR/doctl-vpcs-list-json.stdout.json")"
  EXPECTED_VPC_REGION="$(jq -r --arg do_vpc_uuid "$DO_VPC_UUID" '.[] | select(.id == $do_vpc_uuid) | (.region.slug // .region)' "$EVIDENCE_DIR/doctl-vpcs-list-json.stdout.json")"
else
  printf '%s\n' "missing VPC selection: set DO_VPC_UUID or DEFAULT_VPC=true" >&2
  exit 1
fi

if [ -z "$EXPECTED_VPC_UUID" ] || [ "$EXPECTED_VPC_UUID" = "null" ] || [ -z "$EXPECTED_VPC_NAME" ] || [ "$EXPECTED_VPC_NAME" = "null" ] || [ -z "$EXPECTED_VPC_REGION" ] || [ "$EXPECTED_VPC_REGION" = "null" ]; then
  printf '%s\n' "failed to resolve expected VPC UUID, name, or region" >&2
  exit 1
fi

if [ "$EXPECTED_VPC_REGION" != "$DO_REGION" ]; then
  printf '%s\n' "resolved VPC region does not match DO_REGION" >&2
  exit 1
fi

VPC_CIDR="$(jq -er --arg expected_vpc_uuid "$EXPECTED_VPC_UUID" '
  [ .[] | select(.id == $expected_vpc_uuid) ]
  | if length == 1
    then (.[0].ip_range // .[0].IPRange // empty)
    else error("VPC is not uniquely resolved for CIDR extraction")
    end
  | select(type == "string" and length > 0)
' "$EVIDENCE_DIR/doctl-vpcs-list-json.stdout.json")"

for required_var in DO_REGION DO_SIZE DO_IMAGE DO_SSH_KEY_ID SERVER_NAME GENERATOR_NAME RUN_TAG; do
  if [ -z "${!required_var:-}" ]; then
    printf 'missing required provisioning variable: %s\n' "$required_var" >&2
    exit 1
  fi
done

region_match_count="$(jq -r --arg do_region "$DO_REGION" '[.[] | select(.slug == $do_region)] | length' "$EVIDENCE_DIR/doctl-region-list-json.stdout.json")"
region_available_match_count="$(jq -r --arg do_region "$DO_REGION" '[.[] | select(.slug == $do_region and .available == true)] | length' "$EVIDENCE_DIR/doctl-region-list-json.stdout.json")"
if [ "$region_match_count" != "1" ] || [ "$region_available_match_count" != "1" ]; then
  printf '%s\n' "registered DO_REGION is not exactly one available discovered region" >&2
  exit 1
fi
DO_REGION_NAME="$(jq -er --arg do_region "$DO_REGION" '
  [ .[] | select(.slug == $do_region) ]
  | if length == 1 and .[0].available == true then .[0].name else error("region is not uniquely available") end
' "$EVIDENCE_DIR/doctl-region-list-json.stdout.json")"
DO_REGION_AVAILABLE=true

image_match_count="$(jq -r --arg do_image "$DO_IMAGE" '[.[] | select(.slug == $do_image)] | length' "$EVIDENCE_DIR/doctl-image-list-json.stdout.json")"
if [ "$image_match_count" != "1" ]; then
  printf '%s\n' "registered DO_IMAGE is not exactly one discovered public image slug" >&2
  exit 1
fi
DO_IMAGE_DISTRIBUTION="$(jq -er --arg do_image "$DO_IMAGE" '
  [ .[] | select(.slug == $do_image) ]
  | if length == 1 then .[0].distribution else error("image slug is not unique") end
  | select(type == "string" and length > 0)
' "$EVIDENCE_DIR/doctl-image-list-json.stdout.json")"

ssh_key_match_count="$(jq -r --arg do_ssh_key_id "$DO_SSH_KEY_ID" '[.[] | select((.id | tostring) == $do_ssh_key_id)] | length' "$EVIDENCE_DIR/doctl-ssh-key-list-json.stdout.json")"
if [ "$ssh_key_match_count" != "1" ]; then
  printf '%s\n' "registered DO_SSH_KEY_ID is not exactly one discovered SSH key" >&2
  exit 1
fi
DO_SSH_KEY_FINGERPRINT="$(jq -er --arg do_ssh_key_id "$DO_SSH_KEY_ID" '
  [ .[] | select((.id | tostring) == $do_ssh_key_id) ]
  | if length == 1 then .[0] else error("SSH key ID is not unique") end
  | (.fingerprint // .finger_print // .FingerPrint // .fingerPrint // empty)
  | select(type == "string" and length > 0)
' "$EVIDENCE_DIR/doctl-ssh-key-list-json.stdout.json")"

export DO_REGION_NAME DO_REGION_AVAILABLE DO_IMAGE_DISTRIBUTION DO_SSH_KEY_FINGERPRINT
export EXPECTED_MEMORY_MB EXPECTED_VCPUS EXPECTED_RAM_GB
export EXPECTED_VPC_UUID EXPECTED_VPC_NAME EXPECTED_VPC_REGION VPC_CIDR
```

Before any provisioning command that may terminate the strict shell, persist the
recovery context that §9 will later reload. The recovery file must be generated
inside `EVIDENCE_DIR`, written with operator-only permissions, and updated in
place if later sections learn more identity values. Print the exact generated
path before create and record it in the run manifest.

```bash
export SERVER_ID="${SERVER_ID:-}"
export GENERATOR_ID="${GENERATOR_ID:-}"
export SSH_ADMIN_USER="${SSH_ADMIN_USER:-}"
export SERVER_PUBLIC_IPV4="${SERVER_PUBLIC_IPV4:-}"
export SERVER_PRIVATE_IPV4="${SERVER_PRIVATE_IPV4:-}"
export GENERATOR_PUBLIC_IPV4="${GENERATOR_PUBLIC_IPV4:-}"
export GENERATOR_PRIVATE_IPV4="${GENERATOR_PRIVATE_IPV4:-}"
export SERVER_HOST_EVIDENCE_DIR="${SERVER_HOST_EVIDENCE_DIR:-}"
export GENERATOR_HOST_EVIDENCE_DIR="${GENERATOR_HOST_EVIDENCE_DIR:-}"
export RECOVERY_CONTEXT_PATH="$EVIDENCE_DIR/recovery-context.env"

write_recovery_context() {
  umask 077
  {
    printf 'export PROFILE_ID=%q\n' "$PROFILE_ID"
    printf 'export DOCTL_CONTEXT_NAME=%q\n' "$DOCTL_CONTEXT_NAME"
    printf 'export DOCTL_VERSION=%q\n' "$DOCTL_VERSION"
    printf 'export DO_ACCOUNT_UUID=%q\n' "$DO_ACCOUNT_UUID"
    printf 'export RUN_ID=%q\n' "$RUN_ID"
    printf 'export RUN_TAG=%q\n' "$RUN_TAG"
    printf 'export EVIDENCE_PARENT=%q\n' "$EVIDENCE_PARENT"
    printf 'export EVIDENCE_DIR=%q\n' "$EVIDENCE_DIR"
    printf 'export BUN_BIN=%q\n' "$BUN_BIN"
    printf 'export CANDIDATE_SHA=%q\n' "$CANDIDATE_SHA"
    printf 'export RUNG_LIST=%q\n' "$RUNG_LIST"
    printf 'export RECOVERY_CONTEXT_PATH=%q\n' "$RECOVERY_CONTEXT_PATH"
    printf 'export SERVER_NAME=%q\n' "$SERVER_NAME"
    printf 'export GENERATOR_NAME=%q\n' "$GENERATOR_NAME"
    printf 'export SERVER_ID=%q\n' "$SERVER_ID"
    printf 'export GENERATOR_ID=%q\n' "$GENERATOR_ID"
    printf 'export SSH_ADMIN_USER=%q\n' "$SSH_ADMIN_USER"
    printf 'export SERVER_PUBLIC_IPV4=%q\n' "$SERVER_PUBLIC_IPV4"
    printf 'export SERVER_PRIVATE_IPV4=%q\n' "$SERVER_PRIVATE_IPV4"
    printf 'export GENERATOR_PUBLIC_IPV4=%q\n' "$GENERATOR_PUBLIC_IPV4"
    printf 'export GENERATOR_PRIVATE_IPV4=%q\n' "$GENERATOR_PRIVATE_IPV4"
    printf 'export SERVER_HOST_EVIDENCE_DIR=%q\n' "$SERVER_HOST_EVIDENCE_DIR"
    printf 'export GENERATOR_HOST_EVIDENCE_DIR=%q\n' "$GENERATOR_HOST_EVIDENCE_DIR"
    printf 'export DO_REGION=%q\n' "$DO_REGION"
    printf 'export DO_REGION_NAME=%q\n' "$DO_REGION_NAME"
    printf 'export DO_REGION_AVAILABLE=%q\n' "$DO_REGION_AVAILABLE"
    printf 'export PROJECT_MODE=%q\n' "$PROJECT_MODE"
    printf 'export DO_PROJECT_ID=%q\n' "$DO_PROJECT_ID"
    printf 'export DO_PROJECT_NAME=%q\n' "$DO_PROJECT_NAME"
    printf 'export DO_PROJECT_IS_DEFAULT=%q\n' "$DO_PROJECT_IS_DEFAULT"
    printf 'export DO_SIZE=%q\n' "$DO_SIZE"
    printf 'export DO_IMAGE=%q\n' "$DO_IMAGE"
    printf 'export DO_IMAGE_DISTRIBUTION=%q\n' "$DO_IMAGE_DISTRIBUTION"
    printf 'export DO_SSH_KEY_ID=%q\n' "$DO_SSH_KEY_ID"
    printf 'export DO_SSH_KEY_FINGERPRINT=%q\n' "$DO_SSH_KEY_FINGERPRINT"
    printf 'export RAM_GB=%q\n' "$RAM_GB"
    printf 'export EXPECTED_MEMORY_MB=%q\n' "$EXPECTED_MEMORY_MB"
    printf 'export EXPECTED_VCPUS=%q\n' "$EXPECTED_VCPUS"
    printf 'export EXPECTED_VPC_UUID=%q\n' "$EXPECTED_VPC_UUID"
    printf 'export EXPECTED_VPC_NAME=%q\n' "$EXPECTED_VPC_NAME"
    printf 'export EXPECTED_VPC_REGION=%q\n' "$EXPECTED_VPC_REGION"
    printf 'export VPC_CIDR=%q\n' "$VPC_CIDR"
  } >"$RECOVERY_CONTEXT_PATH"
  chmod 600 "$RECOVERY_CONTEXT_PATH"
}

write_recovery_context
printf '%s\n' "$RECOVERY_CONTEXT_PATH" | tee "$EVIDENCE_DIR/recovery-context-path.txt"
```

This recovery context must exist before tag collision checks, create, or
identity verification. If later sections derive `SERVER_ID` and `GENERATOR_ID`,
rewrite the same file so §9 can recover by exact IDs when available, while
still remaining able to recover by `SERVER_NAME`, `GENERATOR_NAME`, and
`RUN_TAG` if identity assertions fail earlier.

## 6. Unique-run tag collision preflight

`EVIDENCE_DIR` is already unique and fail-closed from §4. Before any create,
prove that the run-scoped `RUN_TAG` does not already resolve to existing
Droplets:

```bash
capture_doctl doctl-tag-collision-list json \
  doctl compute droplet list \
    --tag-name "$RUN_TAG" \
    --format ID,Name,PublicIPv4,PrivateIPv4,Region,VPCUUID,Status,Tags \
    --output json

jq -e 'length == 0' "$EVIDENCE_DIR/doctl-tag-collision-list.stdout.json" >/dev/null
```

The expected result is an empty JSON array in
`$EVIDENCE_DIR/doctl-tag-collision-list.stdout.json`. Any returned match is a
stop condition. Resolve the collision manually before retrying. Never adopt,
recycle, or silently reuse an older Droplet because its name or tag appears to
match the current run.

## 7. Two-Droplet create template

Provision exactly two Droplets and only with explicit profile variables:
`SERVER_NAME`, `GENERATOR_NAME`, `DO_REGION`, `DO_SIZE`, `DO_IMAGE`,
`DO_SSH_KEY_ID`, and the unique `RUN_TAG`. Support exactly one project mode and
exactly one networking mode. Never imply either choice from history.

Use a shell shape that does not emit an empty project flag:

```bash
project_args=()
if [ "$PROJECT_MODE" = "bound" ]; then
  if [ -z "$DO_PROJECT_ID" ]; then
    printf '%s\n' "missing project UUID for PROJECT_MODE=bound" >&2
    exit 1
  fi
  project_args=(--project-id "$DO_PROJECT_ID")
elif [ "$PROJECT_MODE" = "unbound" ]; then
  :
else
  printf '%s\n' "invalid PROJECT_MODE: expected bound or unbound" >&2
  exit 1
fi

network_args=()
if [ "${DEFAULT_VPC:-false}" = "true" ] && [ -n "${DO_VPC_UUID:-}" ]; then
  printf '%s\n' "ambiguous VPC selection: set exactly one of DO_VPC_UUID or DEFAULT_VPC=true" >&2
  exit 1
elif [ "${DEFAULT_VPC:-false}" = "true" ]; then
  network_args=(--enable-private-networking)
elif [ -n "${DO_VPC_UUID:-}" ]; then
  network_args=(--vpc-uuid "$EXPECTED_VPC_UUID")
else
  printf '%s\n' "missing VPC selection: set DO_VPC_UUID or DEFAULT_VPC=true" >&2
  exit 1
fi

capture_doctl doctl-droplet-create json \
  doctl compute droplet create "$SERVER_NAME" "$GENERATOR_NAME" \
    --region "$DO_REGION" \
    --size "$DO_SIZE" \
    --image "$DO_IMAGE" \
    --ssh-keys "$DO_SSH_KEY_ID" \
    --tag-names "$RUN_TAG" \
    "${project_args[@]}" \
    "${network_args[@]}" \
    --wait \
    --output json
```

Do not embed historical addresses, credentials, Droplet IDs, or fixed
project/VPC values in the template. If create returns fewer than two Droplets,
returns non-success status, or leaves one role missing, stop and treat that as
partial or failed provisioning rather than repairing it by reusing old
resources.

## 8. Identity capture and verification before SSH

Before any SSH or benchmark bootstrap, capture the resulting identities and
prove the rig matches the selected profile:

```bash
capture_doctl doctl-droplets-list json \
  doctl compute droplet list \
    --tag-name "$RUN_TAG" \
    --format ID,Name,PublicIPv4,PrivateIPv4,Memory,VCPUs,Region,VPCUUID,Status,Tags \
    --output json

tagged_droplet_count="$(jq -r 'length' "$EVIDENCE_DIR/doctl-droplets-list.stdout.json")"
if [ "$tagged_droplet_count" != "2" ]; then
  printf '%s\n' "expected exactly two tagged Droplets before SSH" >&2
  exit 1
fi

server_match_count="$(jq -r --arg server_name "$SERVER_NAME" '[.[] | select(.name == $server_name)] | length' "$EVIDENCE_DIR/doctl-droplets-list.stdout.json")"
generator_match_count="$(jq -r --arg generator_name "$GENERATOR_NAME" '[.[] | select(.name == $generator_name)] | length' "$EVIDENCE_DIR/doctl-droplets-list.stdout.json")"

if [ "$server_match_count" != "1" ] || [ "$generator_match_count" != "1" ]; then
  printf '%s\n' "expected exactly one tagged Droplet per role name" >&2
  exit 1
fi

SERVER_ID="$(jq -r --arg server_name "$SERVER_NAME" '.[] | select(.name == $server_name) | .id' "$EVIDENCE_DIR/doctl-droplets-list.stdout.json")"
GENERATOR_ID="$(jq -r --arg generator_name "$GENERATOR_NAME" '.[] | select(.name == $generator_name) | .id' "$EVIDENCE_DIR/doctl-droplets-list.stdout.json")"

if [ "$SERVER_ID" = "$GENERATOR_ID" ]; then
  printf '%s\n' "server and generator IDs must be distinct" >&2
  exit 1
fi

export SERVER_ID GENERATOR_ID

write_recovery_context

if [ "$PROJECT_MODE" = "bound" ]; then
  capture_doctl doctl-project-resources-list json \
    doctl projects resources list "$DO_PROJECT_ID" \
      --format URN,AssignedAt,Status \
      --output json
fi

capture_doctl doctl-server-get json \
  doctl compute droplet get "$SERVER_ID" \
    --format ID,Name,PublicIPv4,PrivateIPv4,Memory,VCPUs,Region,VPCUUID,Status,Tags \
    --output json

capture_doctl doctl-generator-get json \
  doctl compute droplet get "$GENERATOR_ID" \
    --format ID,Name,PublicIPv4,PrivateIPv4,Memory,VCPUs,Region,VPCUUID,Status,Tags \
    --output json

server_actual_vpc_uuid="$(jq -r '.[0].vpc_uuid // .vpc_uuid // .VPCUUID // .vpcUUID' "$EVIDENCE_DIR/doctl-server-get.stdout.json")"
generator_actual_vpc_uuid="$(jq -r '.[0].vpc_uuid // .vpc_uuid // .VPCUUID // .vpcUUID' "$EVIDENCE_DIR/doctl-generator-get.stdout.json")"

if [ "$server_actual_vpc_uuid" != "$EXPECTED_VPC_UUID" ] || [ "$generator_actual_vpc_uuid" != "$EXPECTED_VPC_UUID" ]; then
  printf '%s\n' "captured Droplet identities do not match EXPECTED_VPC_UUID" >&2
  exit 1
fi

jq -e 'length == 2' "$EVIDENCE_DIR/doctl-droplets-list.stdout.json" >/dev/null
jq -e 'all(.[]; .status == "active")' "$EVIDENCE_DIR/doctl-droplets-list.stdout.json" >/dev/null
jq -e --arg server_name "$SERVER_NAME" '[.[] | select(.name == $server_name)] | length == 1' "$EVIDENCE_DIR/doctl-droplets-list.stdout.json" >/dev/null
jq -e --arg generator_name "$GENERATOR_NAME" '[.[] | select(.name == $generator_name)] | length == 1' "$EVIDENCE_DIR/doctl-droplets-list.stdout.json" >/dev/null
jq -e --arg do_region "$DO_REGION" 'all(.[]; (.region.slug // .region) == $do_region)' "$EVIDENCE_DIR/doctl-droplets-list.stdout.json" >/dev/null
jq -e --argjson expected_memory_mb "$EXPECTED_MEMORY_MB" 'all(.[]; .memory == $expected_memory_mb)' "$EVIDENCE_DIR/doctl-droplets-list.stdout.json" >/dev/null
jq -e --argjson expected_vcpus "$EXPECTED_VCPUS" 'all(.[]; .vcpus == $expected_vcpus or .VCPUs == $expected_vcpus)' "$EVIDENCE_DIR/doctl-droplets-list.stdout.json" >/dev/null
jq -e 'all(.[]; (.private_ipv4 // .PrivateIPv4 // "") != "")' "$EVIDENCE_DIR/doctl-droplets-list.stdout.json" >/dev/null
jq -e --arg expected_vpc_uuid "$EXPECTED_VPC_UUID" 'all(.[]; (.vpc_uuid // .VPCUUID // .vpcUUID) == $expected_vpc_uuid)' "$EVIDENCE_DIR/doctl-droplets-list.stdout.json" >/dev/null

if [ "$PROJECT_MODE" = "bound" ]; then
  jq -e --arg server_urn "do:droplet:${SERVER_ID}" 'any(.[]; .urn == $server_urn or .URN == $server_urn)' "$EVIDENCE_DIR/doctl-project-resources-list.stdout.json" >/dev/null
  jq -e --arg generator_urn "do:droplet:${GENERATOR_ID}" 'any(.[]; .urn == $generator_urn or .URN == $generator_urn)' "$EVIDENCE_DIR/doctl-project-resources-list.stdout.json" >/dev/null
fi
```

Required verification before SSH:

- exactly two Droplets match `RUN_TAG`;
- both Droplets are `active`;
- one Droplet is `SERVER_NAME` and one is `GENERATOR_NAME`;
- `SERVER_ID` and `GENERATOR_ID` resolve to distinct Droplets with distinct
  operator roles;
- both Droplets are in the registered region;
- both Droplets are attached to `EXPECTED_VPC_UUID`;
- both Droplets resolve to the expected size characteristics, including the
  registered RAM and vCPU values captured during §5;
- both Droplets have private VPC addresses present; and
- when `PROJECT_MODE=bound`,
  `doctl-project-resources-list.stdout.json` includes URNs for both Droplet IDs
  with matching project assignment.

Public IPv4 addresses are for SSH administration only. The measured path is
always the private VPC path. All generator target addresses and all recorded
server service addresses must use the Droplet private IPs, never the public
addresses. Missing private networking, unexpected VPC placement, or any
identity mismatch is a stop condition.

## 9. Partial-create recovery before retry

If `doctl-droplet-create.status` is nonzero, if
`doctl-droplet-create.stdout.json` shows a partial create, or if the identity
checks in §8 fail, the strict shell intentionally exits after preserving the
captured artifacts. Recovery is therefore a restart procedure, not a
continuation inside the failed shell. Before running the recovery commands in
this section, start a fresh Bash session, re-enable `set -euo pipefail`,
verify the exact generated recovery-context file path printed before create,
verify that file is the expected owned readable/writable regular file, source
only that generated context, validate the restored values, redefine
`capture_doctl`, and verify that the referenced create/tag artifacts exist. Do
not rerun §4 run-identity generation, do not mint a new `RUN_TAG`, do not
rerun create, and do not proceed if any context value or artifact is missing
or inconsistent.

Reload and verify the preserved recovery context first:

```bash
set -euo pipefail

# Copy the exact path printed before create or recorded in recovery-context-path.txt.
# Do not recompute this path from a template.
export RECOVERY_CONTEXT_PATH="/absolute/path/printed-before-create/recovery-context.env"

test -n "$RECOVERY_CONTEXT_PATH"
test -f "$RECOVERY_CONTEXT_PATH"
test ! -L "$RECOVERY_CONTEXT_PATH"
test -O "$RECOVERY_CONTEXT_PATH"
test -r "$RECOVERY_CONTEXT_PATH"
test -w "$RECOVERY_CONTEXT_PATH"

. "$RECOVERY_CONTEXT_PATH"

capture_doctl() {
  local label="$1"
  local stdout_ext="$2"
  shift 2

  local stdout_path="$EVIDENCE_DIR/${label}.stdout.${stdout_ext}"
  local stderr_path="$EVIDENCE_DIR/${label}.stderr.txt"
  local status_path="$EVIDENCE_DIR/${label}.status"
  local status

  if "$@" >"$stdout_path" 2>"$stderr_path"; then
    status=0
  else
    status=$?
  fi

  printf '%s\n' "$status" >"$status_path"

  if [ "$status" -ne 0 ]; then
    return "$status"
  fi
}

for required_var in \
  PROFILE_ID \
  DOCTL_CONTEXT_NAME \
  DOCTL_VERSION \
  DO_ACCOUNT_UUID \
  RUN_ID \
  RUN_TAG \
  EVIDENCE_PARENT \
  EVIDENCE_DIR \
  RECOVERY_CONTEXT_PATH \
  SERVER_NAME \
  GENERATOR_NAME \
  DO_REGION \
  DO_REGION_NAME \
  DO_REGION_AVAILABLE \
  PROJECT_MODE \
  EXPECTED_VPC_UUID \
  EXPECTED_VPC_NAME \
  EXPECTED_VPC_REGION \
  RAM_GB \
  DO_SIZE \
  DO_IMAGE \
  DO_IMAGE_DISTRIBUTION \
  DO_SSH_KEY_ID \
  DO_SSH_KEY_FINGERPRINT \
  EXPECTED_MEMORY_MB \
  EXPECTED_VCPUS
do
  test -n "${!required_var}"
done

if [ "$PROJECT_MODE" = "bound" ]; then
  test -n "$DO_PROJECT_ID"
elif [ "$PROJECT_MODE" = "unbound" ]; then
  :
else
  printf '%s\n' "invalid PROJECT_MODE during recovery restart" >&2
  exit 1
fi

if [ "$DOCTL_CONTEXT_NAME" != "default" ]; then
  printf '%s\n' "recovery context is not bound to the default doctl context" >&2
  exit 1
fi

capture_doctl doctl-recovery-auth-list text doctl auth list --output text
grep -Fx "default (current)" "$EVIDENCE_DIR/doctl-recovery-auth-list.stdout.text"

capture_doctl doctl-recovery-version text doctl version
recovered_doctl_version="$(sed -n '1p' "$EVIDENCE_DIR/doctl-recovery-version.stdout.text")"
if [ "$recovered_doctl_version" != "$DOCTL_VERSION" ]; then
  printf '%s\n' "recovery doctl version differs from the preflight version" >&2
  exit 1
fi

capture_doctl doctl-recovery-account-get text doctl account get --format UUID,Status,DropletLimit
capture_doctl doctl-recovery-account-get-json json doctl account get --format UUID,Status,DropletLimit --output json
recovery_account_parse_stderr="$EVIDENCE_DIR/doctl-recovery-account-parse.stderr.txt"
recovery_account_parse_status_path="$EVIDENCE_DIR/doctl-recovery-account-parse.status"
recovery_account_parse_status=0
if recovered_account_uuid="$(jq -er '
  if type != "object" then error("account output is not an object")
  elif ((.uuid // .UUID) | type) != "string" or ((.uuid // .UUID) | length) == 0 then error("account UUID is missing")
  elif (.status // .Status) != "active" then error("account status is not active")
  else (.uuid // .UUID)
  end
' "$EVIDENCE_DIR/doctl-recovery-account-get-json.stdout.json" 2>"$recovery_account_parse_stderr")"; then
  recovery_account_parse_status=0
else
  recovery_account_parse_status=$?
fi
printf '%s\n' "$recovery_account_parse_status" >"$recovery_account_parse_status_path"
if [ "$recovery_account_parse_status" -ne 0 ]; then
  printf '%s\n' "recovery account output could not be parsed or is not active" >&2
  exit "$recovery_account_parse_status"
fi
if [ "$recovered_account_uuid" != "$DO_ACCOUNT_UUID" ]; then
  printf '%s\n' "recovery account UUID differs from the preflight account UUID" >&2
  exit 1
fi

test "$RECOVERY_CONTEXT_PATH" = "$EVIDENCE_DIR/recovery-context.env"
test -d "$EVIDENCE_DIR"
test -d "$EVIDENCE_PARENT"
test -f "$EVIDENCE_DIR/doctl-droplet-create.status"
test -f "$EVIDENCE_DIR/doctl-droplet-create.stdout.json"
test -s "$EVIDENCE_DIR/doctl-droplet-create.stdout.json"
test -f "$EVIDENCE_DIR/doctl-droplet-create.stderr.txt"
test -f "$EVIDENCE_DIR/doctl-tag-collision-list.stdout.json"
```

Once that restart verification passes, re-list the preserved unique run tag and
recover only the captured run resources:

```bash
capture_doctl doctl-recovery-tag-list json \
  doctl compute droplet list \
    --tag-name "$RUN_TAG" \
    --format ID,Name,PublicIPv4,PrivateIPv4,Region,VPCUUID,Status,Tags \
    --output json

create_stdout_path="$EVIDENCE_DIR/doctl-droplet-create.stdout.json"
test -f "$create_stdout_path"
test -s "$create_stdout_path"

create_ids_path="$EVIDENCE_DIR/doctl-recovery-create-ids.txt"
create_parse_stderr_path="$EVIDENCE_DIR/doctl-recovery-create-parse.stderr.txt"
create_parse_status_path="$EVIDENCE_DIR/doctl-recovery-create-parse.status"
create_parse_status=0
if jq -r '
  if type != "array" then
    error("create stdout must be a JSON array")
  elif any(.[]; .id == null or ((.id | type) != "number" and (.id | type) != "string") or ((.id | tostring) == "")) then
    error("create stdout contains a missing or invalid Droplet ID")
  else
    [.[].id | tostring] as $ids
    | if ($ids | unique | length) != ($ids | length) then
        error("create stdout contains duplicate Droplet IDs")
      else
        $ids[]
      end
  end
' "$create_stdout_path" >"$create_ids_path" 2>"$create_parse_stderr_path"; then
  create_parse_status=0
else
  create_parse_status=$?
fi
printf '%s\n' "$create_parse_status" >"$create_parse_status_path"
if [ "$create_parse_status" -ne 0 ]; then
  printf '%s\n' "create stdout is missing, malformed, or ambiguous; recovery is stopped" >&2
  exit "$create_parse_status"
fi

tag_list_path="$EVIDENCE_DIR/doctl-recovery-tag-list.stdout.json"
tag_ids_path="$EVIDENCE_DIR/doctl-recovery-tag-ids.txt"
tag_parse_stderr_path="$EVIDENCE_DIR/doctl-recovery-tag-parse.stderr.txt"
tag_parse_status_path="$EVIDENCE_DIR/doctl-recovery-tag-parse.status"
tag_parse_status=0
if jq -r '
  if type != "array" then
    error("tag list must be a JSON array")
  elif any(.[]; .id == null or ((.id | type) != "number" and (.id | type) != "string") or ((.id | tostring) == "")) then
    error("tag list contains a missing or invalid Droplet ID")
  else
    [.[].id | tostring] as $ids
    | if ($ids | unique | length) != ($ids | length) then
        error("tag list contains duplicate Droplet IDs")
      else
        $ids[]
      end
  end
' "$tag_list_path" >"$tag_ids_path" 2>"$tag_parse_stderr_path"; then
  tag_parse_status=0
else
  tag_parse_status=$?
fi
printf '%s\n' "$tag_parse_status" >"$tag_parse_status_path"
if [ "$tag_parse_status" -ne 0 ]; then
  printf '%s\n' "relisted tagged Droplets could not be parsed; recovery is stopped" >&2
  exit "$tag_parse_status"
fi

create_ids_sorted_path="$EVIDENCE_DIR/doctl-recovery-create-ids.sorted.txt"
tag_ids_sorted_path="$EVIDENCE_DIR/doctl-recovery-tag-ids.sorted.txt"
LC_ALL=C sort -u "$create_ids_path" >"$create_ids_sorted_path"
LC_ALL=C sort -u "$tag_ids_path" >"$tag_ids_sorted_path"

id_compare_status_path="$EVIDENCE_DIR/doctl-recovery-id-compare.status"
if cmp -s "$create_ids_sorted_path" "$tag_ids_sorted_path"; then
  printf '%s\n' "0" >"$id_compare_status_path"
else
  printf '%s\n' "1" >"$id_compare_status_path"
  printf '%s\n' "create-output IDs and relisted tagged IDs differ; recovery is stopped" >&2
  exit 1
fi

seen_server_name=0
seen_generator_name=0

while IFS= read -r droplet_id; do
  capture_doctl "doctl-recovery-get-${droplet_id}" json \
    doctl compute droplet get "$droplet_id" \
      --format ID,Name,PublicIPv4,PrivateIPv4,Region,VPCUUID,Status,Tags \
      --output json

  actual_id="$(jq -r 'if type == "array" then .[0].id // .[0].ID // empty else .id // .ID // empty end' "$EVIDENCE_DIR/doctl-recovery-get-${droplet_id}.stdout.json")"
  actual_name="$(jq -r '.[0].name // .name' "$EVIDENCE_DIR/doctl-recovery-get-${droplet_id}.stdout.json")"
  actual_region="$(jq -r '.[0].region.slug // .region.slug // .region' "$EVIDENCE_DIR/doctl-recovery-get-${droplet_id}.stdout.json")"
  actual_vpc_uuid="$(jq -r '.[0].vpc_uuid // .vpc_uuid // .VPCUUID // .vpcUUID' "$EVIDENCE_DIR/doctl-recovery-get-${droplet_id}.stdout.json")"
  has_run_tag="$(jq -r --arg run_tag "$RUN_TAG" '([.[0].tags[]?, .tags[]?] | any(. == $run_tag))' "$EVIDENCE_DIR/doctl-recovery-get-${droplet_id}.stdout.json")"

  case "$actual_name" in
    "$SERVER_NAME")
      expected_role="server"
      seen_server_name=$((seen_server_name + 1))
      expected_role_id="${SERVER_ID:-}"
      ;;
    "$GENERATOR_NAME")
      expected_role="generator"
      seen_generator_name=$((seen_generator_name + 1))
      expected_role_id="${GENERATOR_ID:-}"
      ;;
    *)
      printf '%s\n' "unknown recovery candidate name ${actual_name}" >&2
      exit 1
      ;;
  esac

  if [ "$actual_id" != "$droplet_id" ]; then
    printf '%s\n' "get response ID mismatch for ${expected_role} recovery candidate ${droplet_id}" >&2
    exit 1
  fi

  if [ "$seen_server_name" -gt 1 ] || [ "$seen_generator_name" -gt 1 ]; then
    printf '%s\n' "duplicate recovery candidate role names are not allowed" >&2
    exit 1
  fi

  if [ -n "$expected_role_id" ] && [ "$droplet_id" != "$expected_role_id" ]; then
    printf '%s\n' "ID mismatch for ${expected_role} recovery candidate ${droplet_id}" >&2
    exit 1
  fi

  if [ "$actual_region" != "$DO_REGION" ]; then
    printf '%s\n' "region mismatch for ${expected_role} recovery candidate ${droplet_id}" >&2
    exit 1
  fi

  if [ "$actual_vpc_uuid" != "$EXPECTED_VPC_UUID" ]; then
    printf '%s\n' "VPC mismatch for ${expected_role} recovery candidate ${droplet_id}" >&2
    exit 1
  fi

  if [ "$has_run_tag" != "true" ]; then
    printf '%s\n' "tag mismatch for ${expected_role} recovery candidate ${droplet_id}" >&2
    exit 1
  fi

  capture_doctl "doctl-recovery-delete-${droplet_id}" text \
    doctl compute droplet delete "$droplet_id" --force
done <"$create_ids_path"

capture_doctl doctl-recovery-final-tag-list json \
  doctl compute droplet list \
    --tag-name "$RUN_TAG" \
    --format ID,Name,PublicIPv4,PrivateIPv4,Region,VPCUUID,Status,Tags \
    --output json

jq -e 'type == "array" and length == 0' "$EVIDENCE_DIR/doctl-recovery-final-tag-list.stdout.json" >/dev/null
```

Recovery rules:

- revalidate the default doctl context, CLI version, active account status, and
  exact preflight account UUID before any recovery list, get, or delete;
- require the create stdout artifact to exist and parse successfully; a
  malformed, empty, or ambiguous create result is an explicit recovery
  failure;
- require the create-output ID set to equal the relisted tagged ID set. The tag
  list is corroboration, not a fallback authorization selector; any mismatch
  is an explicit ambiguity stop.
- preserve `doctl-droplet-create.stdout.json`,
  `doctl-droplet-create.stderr.txt`, and `doctl-droplet-create.status`;
- restart in a fresh strict Bash session and reload the exact preserved run
  context before running any recovery command;
- preserve the recovery tag listing and any recovery get/delete artifacts;
- inspect and extract candidate IDs only from captured outputs for this run,
  primarily the create stdout and the tagged list stdout;
- derive or verify role mapping mechanically from actual captured names, stop
  on duplicate or unknown names, and verify each candidate individually by ID,
  `RUN_TAG`, region, and `EXPECTED_VPC_UUID` before deleting it;
- delete only individually confirmed IDs with
  `doctl compute droplet delete <id> --force`;
- never use `--all`, wildcard selectors, broad tag deletion, or remembered
  historical IDs; and
- never retry create until the final tagged list is captured and verified
  empty.

This recovery step is for failed or partial provisioning only. It does not
replace the full teardown procedure in section 10 for a completed run.

## 10. Full teardown after a completed run

Run this section only after the measurement, raw evidence, diagnostic
sidecars, and terminal campaign record have been sealed. Keep the evidence
directory after deletion. If provisioning or identity verification failed
before a completed run existed, use section 9 instead and do not enter this
section.

Use the same authenticated account and strict-shell capture helper that were
used for provisioning. If this is a fresh shell, reload the preserved run
context using the section 9 bootstrap and revalidate the account before any
teardown operation. Never delete by name, tag, wildcard, --all, public
address, or a remembered historical ID.

First require the exact role IDs and prove that they are distinct:

~~~bash
set -euo pipefail

for required_var in \
  EVIDENCE_DIR RUN_TAG DO_ACCOUNT_UUID DO_REGION EXPECTED_VPC_UUID \
  SERVER_NAME GENERATOR_NAME SERVER_ID GENERATOR_ID; do
  case "$required_var" in
    EVIDENCE_DIR) test -n "$EVIDENCE_DIR" ;;
    RUN_TAG) test -n "$RUN_TAG" ;;
    DO_ACCOUNT_UUID) test -n "$DO_ACCOUNT_UUID" ;;
    DO_REGION) test -n "$DO_REGION" ;;
    EXPECTED_VPC_UUID) test -n "$EXPECTED_VPC_UUID" ;;
    SERVER_NAME) test -n "$SERVER_NAME" ;;
    GENERATOR_NAME) test -n "$GENERATOR_NAME" ;;
    SERVER_ID) test -n "$SERVER_ID" ;;
    GENERATOR_ID) test -n "$GENERATOR_ID" ;;
  esac || {
    printf '%s\n' "missing teardown variable: $required_var" >&2
    exit 1
  }
done

test "$SERVER_ID" != "$GENERATOR_ID"

capture_doctl doctl-teardown-auth-list text \
  doctl auth list --output text
grep -Fx "default (current)" \
  "$EVIDENCE_DIR/doctl-teardown-auth-list.stdout.text"

capture_doctl doctl-teardown-account-get-json json \
  doctl account get --format UUID,Status,DropletLimit --output json
jq -e --arg expected_account_uuid "$DO_ACCOUNT_UUID" '
  (if type == "array" then .[0] else . end) as $account
  | ($account.uuid // $account.UUID) == $expected_account_uuid
  and (($account.status // $account.Status) | ascii_downcase) == "active"
' "$EVIDENCE_DIR/doctl-teardown-account-get-json.stdout.json" >/dev/null
~~~

Re-get each exact ID immediately before deletion. The captured object must
still match its role name, registered region, expected VPC, and unique run
tag; any failed get or mismatch stops teardown before either delete:

~~~bash
assert_teardown_identity() {
  local role="$1"
  local path="$2"
  local expected_id="$3"
  local expected_name="$4"

  jq -e \
    --arg expected_id "$expected_id" \
    --arg expected_name "$expected_name" \
    --arg expected_region "$DO_REGION" \
    --arg expected_vpc_uuid "$EXPECTED_VPC_UUID" \
    --arg run_tag "$RUN_TAG" '
      (if type == "array" then .[0] else . end) as $droplet
      | (($droplet.id // $droplet.ID) | tostring) == $expected_id
      and ($droplet.name // $droplet.Name) == $expected_name
      and (($droplet.region.slug // $droplet.region // $droplet.Region) == $expected_region)
      and (($droplet.vpc_uuid // $droplet.VPCUUID // $droplet.vpcUUID) == $expected_vpc_uuid)
      and ([ $droplet.tags[]?, $droplet.Tags[]? ] | any(. == $run_tag))
    ' "$path" >/dev/null || {
      printf '%s\n' "$role teardown identity mismatch; refusing deletion" >&2
      exit 1
    }
}

capture_doctl doctl-teardown-server-get json \
  doctl compute droplet get "$SERVER_ID" \
  --format ID,Name,PublicIPv4,PrivateIPv4,Region,VPCUUID,Status,Tags \
  --output json
assert_teardown_identity server \
  "$EVIDENCE_DIR/doctl-teardown-server-get.stdout.json" \
  "$SERVER_ID" "$SERVER_NAME"

capture_doctl doctl-teardown-generator-get json \
  doctl compute droplet get "$GENERATOR_ID" \
  --format ID,Name,PublicIPv4,PrivateIPv4,Region,VPCUUID,Status,Tags \
  --output json
assert_teardown_identity generator \
  "$EVIDENCE_DIR/doctl-teardown-generator-get.stdout.json" \
  "$GENERATOR_ID" "$GENERATOR_NAME"
~~~

Only after both individual gets pass, delete the two exact IDs in separate
captured commands. Separate commands preserve which deletion failed:

~~~bash
capture_doctl doctl-teardown-server-delete text \
  doctl compute droplet delete "$SERVER_ID" --force

capture_doctl doctl-teardown-generator-delete text \
  doctl compute droplet delete "$GENERATOR_ID" --force

capture_doctl doctl-teardown-final-tag-list json \
  doctl compute droplet list \
    --tag-name "$RUN_TAG" \
    --format ID,Name,PublicIPv4,PrivateIPv4,Region,VPCUUID,Status,Tags \
    --output json

jq -e 'type == "array" and length == 0' \
  "$EVIDENCE_DIR/doctl-teardown-final-tag-list.stdout.json" >/dev/null
~~~

The final tag listing must be an empty array. Preserve every teardown
stdout/stderr/status artifact and stop with the evidence directory intact if
either delete or the final empty-tag assertion fails. Do not retry a delete
through a broader selector.

## 11. Stop conditions for provisioning

Stop and preserve artifacts without guessing a fix when any of the following is
true:

- authentication fails or the default `doctl` context is not usable;
- no eligible region, size, image, SSH key, VPC, or project selection is
  visible in the authenticated account output;
- the unique-run collision preflight returns any existing tagged Droplet;
- create returns partial, failed, or ambiguous output;
- the identity capture shows anything other than exactly two active matching
  Droplets with distinct server/generator roles;
- `PROJECT_MODE=bound` is required but the project UUID cannot be resolved or
  later verified;
- `PROJECT_MODE=unbound` is not explicit in the registration when skipping
  project binding;
- `EXPECTED_VPC_UUID` cannot be resolved uniquely from the registered input and
  captured VPC discovery output;
- private networking is absent, ambiguous, or not the measured path; or
- expected RAM, vCPU, region, VPC, tag, or name identity does not match the
  selected run manifest.

No broad cleanup shortcuts are permitted here: no `--all`, no wildcard target
selectors, no broad tag delete, and no implicit reuse of old resources by
name, tag, address, or remembered Droplet ID.

## 12. Current frozen profile and planning boundaries

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

## 13. Current-candidate compatibility stop

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

## 14. Preflight checklist before provisioning

Do not provision until all of the following are true:

- `doctl auth list --output text` proved `default (current)` and the account
  preflight in §5 has been captured with separate stdout, stderr, and status
  artifacts.
- The three authority inputs in §2 are present and match the intended
  candidate.
- `RIG_PROFILE` is complete.
- `RUN_ID`, `RUN_TAG`, and `EVIDENCE_DIR` are defined and recorded.
- The run-tag collision check in §6 returned an empty list and was preserved in
  raw evidence.
- `PROJECT_MODE`, `DO_PROJECT_ID` when bound, and `EXPECTED_VPC_UUID` are
  explicit and unambiguous under §§5-8.
- `BUN_BIN` has been validated and its version recorded.
- The operator has explicitly set and verified `ENDPOINT_COUNT=128`.
- The profile still satisfies the current-candidate compatibility stop in §13,
  including effective `CONNECT_CONCURRENCY=500`.
- The operator is prepared to preserve raw artifacts and stop on missing
  authority inputs rather than guessing defaults.

## 15. SSH bootstrap, candidate checkout, and host tuning

Enter this section only after §8 has verified both Droplets. The public
addresses are an administration transport; they are never a benchmark
endpoint. The server-to-generator SSH target and every measured URL use the
private VPC addresses captured from the verified Droplet objects.

Derive and retain both address classes from the captured identity artifacts.
Do not copy addresses from an old run:

~~~bash
set -euo pipefail

SERVER_PUBLIC_IPV4="$(jq -er '.[0].public_ipv4 // .PublicIPv4 // empty' \
  "$EVIDENCE_DIR/doctl-server-get.stdout.json")"
SERVER_PRIVATE_IPV4="$(jq -er '.[0].private_ipv4 // .PrivateIPv4 // empty' \
  "$EVIDENCE_DIR/doctl-server-get.stdout.json")"
GENERATOR_PUBLIC_IPV4="$(jq -er '.[0].public_ipv4 // .PublicIPv4 // empty' \
  "$EVIDENCE_DIR/doctl-generator-get.stdout.json")"
GENERATOR_PRIVATE_IPV4="$(jq -er '.[0].private_ipv4 // .PrivateIPv4 // empty' \
  "$EVIDENCE_DIR/doctl-generator-get.stdout.json")"

test -n "$SERVER_PUBLIC_IPV4"
test -n "$SERVER_PRIVATE_IPV4"
test -n "$GENERATOR_PUBLIC_IPV4"
test -n "$GENERATOR_PRIVATE_IPV4"
test "$SERVER_PUBLIC_IPV4" != "$SERVER_PRIVATE_IPV4"
test "$GENERATOR_PUBLIC_IPV4" != "$GENERATOR_PRIVATE_IPV4"

export SERVER_PUBLIC_IPV4 SERVER_PRIVATE_IPV4
export GENERATOR_PUBLIC_IPV4 GENERATOR_PRIVATE_IPV4
~~~

Use either the image's registered administrative user over the public address
or the authenticated helper for administration. Both forms are administrative
only:

~~~bash
export SSH_ADMIN_USER=the-registered-image-user
export SERVER_HOST_EVIDENCE_DIR="/var/tmp/$RUN_ID"
export GENERATOR_HOST_EVIDENCE_DIR="/var/tmp/$RUN_ID"

write_recovery_context

ssh -o BatchMode=yes \
  "$SSH_ADMIN_USER@$SERVER_PUBLIC_IPV4" \
  'uname -a'
ssh -o BatchMode=yes \
  "$SSH_ADMIN_USER@$GENERATOR_PUBLIC_IPV4" \
  'uname -a'

doctl compute ssh "$SERVER_ID"
doctl compute ssh "$GENERATOR_ID"
~~~

Do not put a private key, access token, or password in a command, URL, or
captured environment. If the image requires a different administrative user,
stop and update the registration; do not guess one. The public path is not
allowed in G6 scan variables.

### 15.1 Host-local evidence and registered prerequisites

Run the following bootstrap shape separately on each host. The registration
must expand its prerequisite declaration into explicit role values before this
section is entered: ROLE_NEEDS_BUN, ROLE_NEEDS_RUST, ROLE_NEEDS_IPERF3,
REMOTE_BUN_BIN, RUSTUP_BIN, and RUST_TOOLCHAIN. A missing role value is a
stop, not permission to install an extra tool. Set RUN_ID from the preserved
run context; do not mint a host-local replacement:

~~~bash
set -euo pipefail

test -n "$RUN_ID"
export ROLE_NEEDS_BUN ROLE_NEEDS_RUST ROLE_NEEDS_IPERF3
export REMOTE_BUN_BIN RUSTUP_BIN RUST_TOOLCHAIN
export HOST_EVIDENCE_DIR="/var/tmp/$RUN_ID"
test ! -e "$HOST_EVIDENCE_DIR"
install -d -m 700 "$HOST_EVIDENCE_DIR"

capture_host_cmd() {
  local label="$1"
  shift
  local status

  if "$@" >"$HOST_EVIDENCE_DIR/$label.stdout.txt" \
    2>"$HOST_EVIDENCE_DIR/$label.stderr.txt"; then
    status=0
  else
    status=$?
  fi
  printf '%s\n' "$status" >"$HOST_EVIDENCE_DIR/$label.status"
  if [ "$status" -ne 0 ]; then
    return "$status"
  fi
}

capture_host_cmd host-identity bash -lc '
  set -euo pipefail
  cat /etc/os-release
  uname -a
  uname -r
'

capture_host_cmd prerequisite-install bash -lc '
  set -euo pipefail
  test -r /etc/os-release
  . /etc/os-release
  case "$ID" in
    ubuntu|debian) ;;
    *)
      printf "%s\n" "registered image is not an apt-based Ubuntu/Debian host" >&2
      exit 1
      ;;
  esac
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install --yes \
    git clang llvm bpftool "linux-headers-$(uname -r)" build-essential \
    curl ca-certificates jq rsync
  if [ "$ROLE_NEEDS_IPERF3" = "1" ]; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get install --yes iperf3
  fi
'

if [ "$ROLE_NEEDS_RUST" = "1" ]; then
  test -x "$RUSTUP_BIN"
  capture_host_cmd rust-toolchain-install \
    "$RUSTUP_BIN" toolchain install "$RUST_TOOLCHAIN" --profile minimal
  capture_host_cmd rust-toolchain-select \
    "$RUSTUP_BIN" default "$RUST_TOOLCHAIN"
fi

if [ "$ROLE_NEEDS_BUN" = "1" ]; then
  test -x "$REMOTE_BUN_BIN"
  capture_host_cmd bun-version "$REMOTE_BUN_BIN" --version
  capture_host_cmd bun-sha256 sha256sum "$REMOTE_BUN_BIN"
fi

capture_host_cmd prerequisite-versions bash -lc '
  set -euo pipefail
  git --version
  clang --version
  llvm-config --version
  bpftool version
  jq --version
  rsync --version | sed -n "1p"
  if [ "$ROLE_NEEDS_RUST" = "1" ]; then
    rustc --version
    cargo --version
  fi
  if [ "$ROLE_NEEDS_IPERF3" = "1" ]; then
    iperf3 --version
  fi
'
~~~

The matching running-kernel headers are intentional: if the exact
linux-headers package is unavailable, stop rather than substituting a nearby
kernel package. The peer-side iperf3 server must be installed on the host
named by the registration and started by the qualification procedure before
the loaded leg; this section does not authorize a public-facing iperf3
listener. Preserve the host evidence directory and transfer it into the
run's local EVIDENCE_DIR before teardown.

### 15.2 Exact candidate checkout on every candidate host

Run this block on every host that builds or executes candidate code. CLONE,
REPO_URL, and CANDIDATE_SHA must be supplied by the registration or run
context; the repository URL must not contain credentials. A detached checkout
and a completely clean tree are required even when the candidate SHA is
already present:

~~~bash
set -euo pipefail

test -n "$CLONE"
test -n "$REPO_URL"
test -n "$CANDIDATE_SHA"
export CLONE REPO_URL CANDIDATE_SHA

if [ ! -d "$CLONE/.git" ]; then
  git clone "$REPO_URL" "$CLONE"
fi

git -C "$CLONE" fetch --quiet origin "$CANDIDATE_SHA"
git -C "$CLONE" checkout --detach --quiet "$CANDIDATE_SHA"

test "$(git -C "$CLONE" rev-parse HEAD)" = "$CANDIDATE_SHA"
git -C "$CLONE" diff --quiet HEAD
test -z "$(git -C "$CLONE" status --porcelain --untracked-files=all)"

capture_host_cmd candidate-source bash -lc '
  set -euo pipefail
  git -C "$CLONE" rev-parse HEAD
  git -C "$CLONE" show -s --format=%H HEAD
  git -C "$CLONE" status --porcelain --untracked-files=all
'

capture_host_cmd candidate-file-sha256 bash -lc '
  set -euo pipefail
  sha256sum \
    "$CLONE/tools/load/g6-sharded-scan.ts" \
    "$CLONE/tools/load/g6-shard-server.ts" \
    "$CLONE/tools/load/g6-shard-bpf-setup.sh" \
    "$CLONE/tools/offbox/linux-generator-entry-g6.sh"
'
~~~

The generator clone must contain the same CANDIDATE_SHA and the tracked
tools/offbox/linux-generator-entry-g6.sh entrypoint. Record the SHA-256 of
every built native binary, the entrypoint, and the exact runtime/tool versions
in host evidence. The Linux entrypoint itself performs a detached candidate
checkout and builds mmo-client when needed; do not bypass it with a hand-built
or untracked generator invocation.

Before hashing the produced client binary, warm the generator through the
tracked Linux entrypoint so the build happens under the recorded provenance
path. Capture and inspect that `build=ok` transcript first; a missing build
record is a stop:

~~~bash
set -euo pipefail

export GENERATOR_CLONE
capture_host_cmd generator-entrypoint-build bash -lc '
  set -euo pipefail
  "$GENERATOR_CLONE/tools/offbox/linux-generator-entry-g6.sh" \
    --candidate "$CANDIDATE_SHA" \
    --deadline 30 \
    --bin mmo-client \
    -- --help
'
grep -F "macgen: head=$CANDIDATE_SHA dirty=no build=ok" \
  "$HOST_EVIDENCE_DIR/generator-entrypoint-build.stdout.txt"
~~~

Only after that tracked entrypoint build has reported `build=ok` may the
operator hash the produced client binary before dispatch. A missing binary or a
binary hash that is not retained with the candidate evidence is a stop:

~~~bash
set -euo pipefail

export GENERATOR_CLONE
test -x "$GENERATOR_CLONE/target/release/mmo-client"
capture_host_cmd generator-binary-sha256 bash -lc '
  set -euo pipefail
  test -x "$GENERATOR_CLONE/target/release/mmo-client"
  sha256sum "$GENERATOR_CLONE/target/release/mmo-client"
'
~~~

### 15.3 Profile-driven sysctl and process limits

The registration must expand UDP_BUFFER_AND_SYSCTL_PROFILE and ULIMIT_PROFILE
into the following named values before this block is run. They are separate
settings and must not be collapsed into one “socket buffer” number:

- SYSCTL_FS_FILE_MAX for fs.file-max;
- SYSCTL_NET_CORE_RMEM_MAX and SYSCTL_NET_CORE_WMEM_MAX for core socket
  ceilings;
- SYSCTL_NET_IPV4_UDP_MEM, SYSCTL_NET_IPV4_UDP_RMEM_MIN,
  SYSCTL_NET_IPV4_UDP_RMEM_MAX, SYSCTL_NET_IPV4_UDP_WMEM_MIN, and
  SYSCTL_NET_IPV4_UDP_WMEM_MAX for UDP memory;
- SYSCTL_NET_IPV4_IP_LOCAL_PORT_RANGE for the ephemeral-port range; and
- ULIMIT_NOFILE for the per-process file-descriptor limit.

Capture before values, apply only those registered values, capture after
values, and stop if any value is not retained:

~~~bash
set -euo pipefail

for required_value in \
  SYSCTL_FS_FILE_MAX SYSCTL_NET_CORE_RMEM_MAX SYSCTL_NET_CORE_WMEM_MAX \
  SYSCTL_NET_IPV4_UDP_MEM SYSCTL_NET_IPV4_UDP_RMEM_MIN \
  SYSCTL_NET_IPV4_UDP_RMEM_MAX SYSCTL_NET_IPV4_UDP_WMEM_MIN \
  SYSCTL_NET_IPV4_UDP_WMEM_MAX SYSCTL_NET_IPV4_IP_LOCAL_PORT_RANGE \
  ULIMIT_NOFILE; do
  case "$required_value" in
    SYSCTL_FS_FILE_MAX) test -n "$SYSCTL_FS_FILE_MAX" ;;
    SYSCTL_NET_CORE_RMEM_MAX) test -n "$SYSCTL_NET_CORE_RMEM_MAX" ;;
    SYSCTL_NET_CORE_WMEM_MAX) test -n "$SYSCTL_NET_CORE_WMEM_MAX" ;;
    SYSCTL_NET_IPV4_UDP_MEM) test -n "$SYSCTL_NET_IPV4_UDP_MEM" ;;
    SYSCTL_NET_IPV4_UDP_RMEM_MIN) test -n "$SYSCTL_NET_IPV4_UDP_RMEM_MIN" ;;
    SYSCTL_NET_IPV4_UDP_RMEM_MAX) test -n "$SYSCTL_NET_IPV4_UDP_RMEM_MAX" ;;
    SYSCTL_NET_IPV4_UDP_WMEM_MIN) test -n "$SYSCTL_NET_IPV4_UDP_WMEM_MIN" ;;
    SYSCTL_NET_IPV4_UDP_WMEM_MAX) test -n "$SYSCTL_NET_IPV4_UDP_WMEM_MAX" ;;
    SYSCTL_NET_IPV4_IP_LOCAL_PORT_RANGE) test -n "$SYSCTL_NET_IPV4_IP_LOCAL_PORT_RANGE" ;;
    ULIMIT_NOFILE) test -n "$ULIMIT_NOFILE" ;;
  esac || {
    printf '%s\n' "missing registered host-tuning value: $required_value" >&2
    exit 1
  }
done

capture_host_cmd sysctl-before bash -lc '
  set -euo pipefail
  sysctl fs.file-max \
    net.core.rmem_max net.core.wmem_max \
    net.ipv4.udp_mem net.ipv4.udp_rmem_min net.ipv4.udp_rmem_max \
    net.ipv4.udp_wmem_min net.ipv4.udp_wmem_max \
    net.ipv4.ip_local_port_range
'
capture_host_cmd ulimit-before bash -lc 'ulimit -n'

capture_host_cmd sysctl-apply-fs sudo sysctl -w "fs.file-max=$SYSCTL_FS_FILE_MAX"
capture_host_cmd sysctl-apply-core-rmem sudo sysctl -w "net.core.rmem_max=$SYSCTL_NET_CORE_RMEM_MAX"
capture_host_cmd sysctl-apply-core-wmem sudo sysctl -w "net.core.wmem_max=$SYSCTL_NET_CORE_WMEM_MAX"
capture_host_cmd sysctl-apply-udp-mem sudo sysctl -w "net.ipv4.udp_mem=$SYSCTL_NET_IPV4_UDP_MEM"
capture_host_cmd sysctl-apply-udp-rmem-min sudo sysctl -w "net.ipv4.udp_rmem_min=$SYSCTL_NET_IPV4_UDP_RMEM_MIN"
capture_host_cmd sysctl-apply-udp-rmem-max sudo sysctl -w "net.ipv4.udp_rmem_max=$SYSCTL_NET_IPV4_UDP_RMEM_MAX"
capture_host_cmd sysctl-apply-udp-wmem-min sudo sysctl -w "net.ipv4.udp_wmem_min=$SYSCTL_NET_IPV4_UDP_WMEM_MIN"
capture_host_cmd sysctl-apply-udp-wmem-max sudo sysctl -w "net.ipv4.udp_wmem_max=$SYSCTL_NET_IPV4_UDP_WMEM_MAX"
capture_host_cmd sysctl-apply-ports sudo sysctl -w "net.ipv4.ip_local_port_range=$SYSCTL_NET_IPV4_IP_LOCAL_PORT_RANGE"

# This must run in the same shell that will launch the server or conductor.
ulimit_apply_status=0
if ulimit -n "$ULIMIT_NOFILE" \
  2>"$HOST_EVIDENCE_DIR/ulimit-apply.stderr.txt"; then
  ulimit_apply_status=0
else
  ulimit_apply_status=$?
fi
printf '%s\n' "$ulimit_apply_status" \
  >"$HOST_EVIDENCE_DIR/ulimit-apply.status"
if [ "$ulimit_apply_status" -ne 0 ]; then
  exit "$ulimit_apply_status"
fi
printf '%s\n' "$(ulimit -n)" >"$HOST_EVIDENCE_DIR/ulimit-launching-shell-after.txt"

capture_host_cmd sysctl-after bash -lc '
  set -euo pipefail
  sysctl fs.file-max \
    net.core.rmem_max net.core.wmem_max \
    net.ipv4.udp_mem net.ipv4.udp_rmem_min net.ipv4.udp_rmem_max \
    net.ipv4.udp_wmem_min net.ipv4.udp_wmem_max \
    net.ipv4.ip_local_port_range
'

test "$(sysctl -n fs.file-max)" = "$SYSCTL_FS_FILE_MAX"
test "$(sysctl -n net.core.rmem_max)" = "$SYSCTL_NET_CORE_RMEM_MAX"
test "$(sysctl -n net.core.wmem_max)" = "$SYSCTL_NET_CORE_WMEM_MAX"
test "$(sysctl -n net.ipv4.udp_mem)" = "$SYSCTL_NET_IPV4_UDP_MEM"
test "$(sysctl -n net.ipv4.udp_rmem_min)" = "$SYSCTL_NET_IPV4_UDP_RMEM_MIN"
test "$(sysctl -n net.ipv4.udp_rmem_max)" = "$SYSCTL_NET_IPV4_UDP_RMEM_MAX"
test "$(sysctl -n net.ipv4.udp_wmem_min)" = "$SYSCTL_NET_IPV4_UDP_WMEM_MIN"
test "$(sysctl -n net.ipv4.udp_wmem_max)" = "$SYSCTL_NET_IPV4_UDP_WMEM_MAX"
test "$(sysctl -n net.ipv4.ip_local_port_range)" = "$SYSCTL_NET_IPV4_IP_LOCAL_PORT_RANGE"
test "$(ulimit -n)" = "$ULIMIT_NOFILE"
~~~

If the host silently rounds, clamps, or resets a requested value, preserve the
before/after artifacts and stop. A persistent sysctl value does not prove the
launching process inherited the requested file limit; the direct ulimit check
in the shell that launches the conductor is mandatory.

### 15.4 Fresh BPF maps and dynamic shard setup

The map setup is profile-driven but still source-bound. Require
BPF_MAX_INSTANCES to equal SHARD_COUNT and record PIN_DIR before setup. On the
current candidate, refuse before running any setup command when SHARD_COUNT is
greater than 16, SERVER_ID_MIN is not 1, or SERVER_ID_MAX is not SHARD_COUNT.
That is a compatibility stop, not a statement that larger rigs should use
only 16 shards. A future c-40/c-60 or other 32+ vCPU profile must register a
larger shard count and use a successor that expands the producer, server
wrapper, grader, and BPF path together.

~~~bash
set -euo pipefail

test -n "$PIN_DIR"
test "$SHARD_COUNT" -eq "$BPF_MAX_INSTANCES"
test "$SHARD_COUNT" -ge 1
test "$SERVER_ID_MIN" -eq 1
test "$SERVER_ID_MAX" -eq "$SHARD_COUNT"

if [ "$SHARD_COUNT" -gt 16 ]; then
  printf '%s\n' \
    "current g6-sharded-scan/g6-shard-server/g6-sharded-grade path supports only 16 shards" \
    >&2
  exit 1
fi

case "$PIN_DIR" in
  /sys/fs/bpf/*) ;;
  *)
    printf '%s\n' "PIN_DIR must be an explicit /sys/fs/bpf path" >&2
    exit 1
    ;;
esac

cd "$CLONE"
capture_host_cmd bpf-setup \
  sudo env PIN_DIR="$PIN_DIR" \
  tools/load/g6-shard-bpf-setup.sh "$SHARD_COUNT"

capture_host_cmd bpf-slot-map \
  sudo bpftool map dump pinned "$PIN_DIR/slot_by_server_id"
capture_host_cmd bpf-sock-map \
  sudo bpftool map dump pinned "$PIN_DIR/socks"
capture_host_cmd bpf-steer-stats \
  sudo bpftool map dump pinned "$PIN_DIR/steer_stats"
capture_host_cmd bpf-map-show \
  sudo bpftool map show pinned "$PIN_DIR/slot_by_server_id"
capture_host_cmd bpf-sock-map-show \
  sudo bpftool map show pinned "$PIN_DIR/socks"

{
  printf 'PIN_DIR=%q\n' "$PIN_DIR"
  printf 'SHARD_COUNT=%q\n' "$SHARD_COUNT"
  printf 'BPF_MAX_INSTANCES=%q\n' "$BPF_MAX_INSTANCES"
  printf 'SERVER_ID_MIN=%q\n' "$SERVER_ID_MIN"
  printf 'SERVER_ID_MAX=%q\n' "$SERVER_ID_MAX"
} >"$HOST_EVIDENCE_DIR/bpf-config.env"
~~~

The setup script removes and recreates PIN_DIR, so this block is the reset
boundary. Run it again after any qualification calibration and immediately
before the licensed dispatch; the later dispatch section must not insert
additional map state between the fresh pin and the first rung. The
slot_by_server_id, socks, and steer_stats dumps are retained as raw evidence.

### 15.5 Private role addressing and server-instance launch contract

The current producer is the conductor
tools/load/g6-sharded-scan.ts. It starts g6-shard-server.ts children with
server IDs 1 through SCAN_SHARDS, and the wrapper currently rejects IDs above
16. Therefore the current candidate's profile must prove exactly
SERVER_ID_MIN=1 and SERVER_ID_MAX=SHARD_COUNT before launch. Do not manually
start a second set of shard processes: the single conductor launch is the
source-bound instance count and lifecycle owner.

On the verified server host, set the launch contract from private addresses:

~~~bash
set -euo pipefail

test -n "$GENERATOR_PRIVATE_IPV4"
test -n "$SERVER_PRIVATE_IPV4"
test -n "$GENERATOR_SSH_USER"
test -n "$GENERATOR_CLONE"
test -x "$REMOTE_BUN_BIN"
test "$SERVER_ID_MIN" -eq 1
test "$SERVER_ID_MAX" -eq "$SHARD_COUNT"

export SCAN_SHARDS="$SHARD_COUNT"
export SCAN_PIN_DIR="$PIN_DIR"
export G6_SERVER_ADDRESS="$SERVER_PRIVATE_IPV4"
export G6_OFFBOX_SSH="$GENERATOR_SSH_USER@$GENERATOR_PRIVATE_IPV4"
export G6_OFFBOX_ENTRY_SCRIPT="$GENERATOR_CLONE/tools/offbox/linux-generator-entry-g6.sh"
export G6_CANDIDATE_SHA="$CANDIDATE_SHA"
export G6_PREREGISTRATION_SHA256="$PREREGISTRATION_SHA256"
export MMO_CLIENT_RSS_LIMIT_MB="$RSS_LIMIT_MB"
export SCAN_CONNECT_TIMEOUT_SECONDS="$CONNECT_TIMEOUT_SECONDS"

ssh -o BatchMode=yes "$G6_OFFBOX_SSH" \
  "test \"\$(git -C '$GENERATOR_CLONE' rev-parse HEAD)\" = '$CANDIDATE_SHA'"
ssh -o BatchMode=yes "$G6_OFFBOX_SSH" \
  "test -x '$G6_OFFBOX_ENTRY_SCRIPT'"

{
  printf 'SCAN_SHARDS=%q\n' "$SCAN_SHARDS"
  printf 'SCAN_PIN_DIR=%q\n' "$SCAN_PIN_DIR"
  printf 'G6_SERVER_ADDRESS=%q\n' "$G6_SERVER_ADDRESS"
  printf 'G6_OFFBOX_SSH=%q\n' "$G6_OFFBOX_SSH"
  printf 'G6_OFFBOX_ENTRY_SCRIPT=%q\n' "$G6_OFFBOX_ENTRY_SCRIPT"
  printf 'G6_CANDIDATE_SHA=%q\n' "$G6_CANDIDATE_SHA"
  printf 'G6_PREREGISTRATION_SHA256=%q\n' "$G6_PREREGISTRATION_SHA256"
  printf 'MMO_CLIENT_RSS_LIMIT_MB=%q\n' "$MMO_CLIENT_RSS_LIMIT_MB"
  printf 'SCAN_CONNECT_TIMEOUT_SECONDS=%q\n' "$SCAN_CONNECT_TIMEOUT_SECONDS"
} >"$HOST_EVIDENCE_DIR/private-role-addressing.env"
~~~

The later generator invocation must remain through the tracked Linux entrypoint
and preserve CANDIDATE_SHA, the source-computed --deadline, RSS_LIMIT_MB, and
CONNECT_TIMEOUT_SECONDS. On the current candidate, g6-sharded-scan.ts computes
the entrypoint's --deadline from its source-fixed 300-second connect-phase
constant; that is not a profile-controlled deadline. The profile's
CONNECT_TIMEOUT_SECONDS is forwarded separately as the entrypoint's
--connect-timeout argument through SCAN_CONNECT_TIMEOUT_SECONDS. A different
deadline or connect-phase contract requires source plumbing and a new
registration; do not silently substitute a profile value.

The dispatch-time conductor launch is the source-bound command below. It must
run only after the qualification and licensed-dispatch gates in the later
sections have passed. capture_host_cmd preserves the conductor's stdout,
stderr, and exit status, including the Linux entrypoint's macgen provenance
line that shows the candidate, computed deadline, RSS limit, connect timeout,
and final generator argv:

~~~bash
set -euo pipefail

test -n "$CLONE"
test -x "$REMOTE_BUN_BIN"
export CLONE REMOTE_BUN_BIN

capture_host_cmd g6-sharded-conductor bash -lc '
  set -euo pipefail
  cd "$CLONE"
  exec "$REMOTE_BUN_BIN" tools/load/g6-sharded-scan.ts
'
~~~

The dispatch section supplies SCAN_SHARDS, SCAN_PIN_DIR, G6_OFFBOX_SSH,
G6_OFFBOX_ENTRY_SCRIPT, G6_CANDIDATE_SHA, G6_PREREGISTRATION_SHA256,
G6_SERVER_ADDRESS, the registered RSS/connect values, and the rung-specific
output paths before this launch. Do not call the Linux entrypoint directly
from an alternate script or replace its candidate/deadline/RSS/connect
arguments. The server conductor's G6_SERVER_ADDRESS must remain
SERVER_PRIVATE_IPV4. Public addresses may appear only in the administrative
SSH transport and its captured connection evidence; never in the scan URL,
G6_SERVER_ADDRESS, or generator target. A current-candidate start is valid only
when it creates exactly SHARD_COUNT children over the registered server-ID
range; any source or profile mismatch stops before dispatch.

## 16. Same-day qualification, serialized dispatch, and rung handling

Enter this section only after host bootstrap and candidate verification have
completed on both Droplets. Qualification and licensed dispatch must use the
same calendar day, the same private VPC addresses, the same candidate SHA, the
same registration digest, and the same profile manifest. Historical preflight,
sink, calibration, or scan artifacts may be retained as context but cannot
license this run. Set RUN_DATE from UTC because the tracked artifacts record
their start time as an ISO instant:

~~~bash
set -euo pipefail

export RUN_DATE="$(date -u +%F)"
test -n "$RUN_DATE"
test -n "$CANDIDATE_SHA"
test -n "$PREREGISTRATION_SHA256"
test -n "$VPC_CIDR"
test -n "$SERVER_PRIVATE_IPV4"
test -n "$GENERATOR_PRIVATE_IPV4"
test -n "$RUNG_LIST"
test -n "$FRONTIER_RUNG"
~~~

VPC_CIDR must be the exact IPRange/ip_range value retained from the verified
VPC discovery output. It is not a guessed private range or a value copied from
a historical run. Keep the server's and generator's public addresses
restricted to administrative SSH; every qualification and scan target below
uses the private addresses.

### 16.1 One orchestrator and /tmp/bench.lock

The local operator is the sole orchestrator. The operator opens one persistent
server conductor shell and one explicitly named generator qualification shell;
these are control contexts, not independent conductors. The operator serializes
every load-producing command and keeps the persistent server conductor shell
alive from lock acquisition through the licensed ladder. Acquire the Linux lock
in that server shell before any same-day qualification load or calibration and
hold its file descriptor through the entire licensed ladder. If the lock is
held, retain an ownership probe and stop; never remove or truncate the file
speculatively, and never run a second load generator concurrently:

~~~bash
set -euo pipefail

exec 9>>/tmp/bench.lock
if ! flock -n 9; then
  set +e
  capture_host_cmd bench-lock-owner bash -lc '
    set +e
    command -v fuser >/dev/null 2>&1 && fuser -v /tmp/bench.lock || true
    command -v lsof >/dev/null 2>&1 && lsof /tmp/bench.lock || true
    ps -eo pid,ppid,stat,etime,args | sed -n "1p;/g6-sharded\|mmo-client\|iperf3/p"
  '
  lock_probe_status=$?
  set -e
  printf '%s\n' "$lock_probe_status" >"$HOST_EVIDENCE_DIR/bench-lock-owner.capture-status"
  printf '%s\n' "another orchestrator owns /tmp/bench.lock; stop without removing it" >&2
  exit 1
fi

printf '%s\n' "pid=$$ acquired=$(date -u +%FT%H:%M:%SZ)" \
  >"$HOST_EVIDENCE_DIR/bench-lock-owner.txt"
~~~

The lock is local to the server conductor. It does not replace the campaign's
registration or permit a second run on another rig; the operator must still
ensure that the registered Droplet pair is the only active pair for this run.

### 16.2 Registered same-day qualification

The qualification order is: VPC-path R-down, VPC-path R-up, the registered
bidirectional loaded leg, the generator sink precheck, and the frontier-shape
steering calibration. A failed qualification is a stop/refusal, not a rung
MISS. Preserve every raw output and status, and do not lower a threshold to
make a rig qualify.

#### VPC-path R-down and R-up

The tracked tools/offbox/preflight.ts command surface is the only preflight
producer. Its --plan output is the reviewable command list and its --out file
is the raw artifact. The receiving peer must run the registered peer-side
iperf3 -s setup from the applicable common registration; do not expose a new
public listener or invent a replacement peer command.

Run the tool once in the persistent server conductor shell, where it originates
the registered server-to-generator R-down direction, and once in the generator
qualification shell, where it originates the registered generator-to-server
R-up direction. Each shell has its own `capture_host_cmd` and host-local
`HOST_EVIDENCE_DIR`; do not reuse one host's value in the other shell. Use the
exact private peer address and VPC CIDR in each invocation:

~~~bash
# On the server Droplet: R-down, 1150 B at the registered 75,000-pps floor.
set -euo pipefail

cd "$CLONE"
capture_host_cmd r-down-plan \
  "$REMOTE_BUN_BIN" tools/offbox/preflight.ts \
  --peer "$GENERATOR_PRIVATE_IPV4" \
  --subnet "$VPC_CIDR" \
  --payload-bytes 1150 \
  --rates-mbit 750 \
  --loss-bound-pct 0.1 \
  --plan
capture_host_cmd r-down \
  "$REMOTE_BUN_BIN" tools/offbox/preflight.ts \
  --peer "$GENERATOR_PRIVATE_IPV4" \
  --subnet "$VPC_CIDR" \
  --payload-bytes 1150 \
  --rates-mbit 750 \
  --loss-bound-pct 0.1 \
  --out "$HOST_EVIDENCE_DIR/preflight-r-down.json"
~~~

In the generator qualification shell:

~~~bash
set -euo pipefail

# On the generator Droplet: R-up, 64 B at the registered 20,000-pps floor.
cd "$GENERATOR_CLONE"
capture_host_cmd r-up-plan \
  "$REMOTE_BUN_BIN" tools/offbox/preflight.ts \
  --peer "$SERVER_PRIVATE_IPV4" \
  --subnet "$VPC_CIDR" \
  --payload-bytes 64 \
  --rates-mbit 12 \
  --loss-bound-pct 0.1 \
  --plan
capture_host_cmd r-up \
  "$REMOTE_BUN_BIN" tools/offbox/preflight.ts \
  --peer "$SERVER_PRIVATE_IPV4" \
  --subnet "$VPC_CIDR" \
  --payload-bytes 64 \
  --rates-mbit 12 \
  --loss-bound-pct 0.1 \
  --out "$HOST_EVIDENCE_DIR/preflight-r-up.json"
~~~

The --rates-mbit values above deliberately clear the registered packet-rate
floors when delivered cleanly: 750 Mbit/s at 1150 B is above 75,000 pps and
12 Mbit/s at 64 B is above 20,000 pps. Check the tracked artifact fields, not
the offered rate alone. Both artifacts must be same-day, have a clean ceiling
at or above the registered floor under 0.1% loss, establish MTU at least 1280,
and report idle RTT p99 at most 5 ms. Evaluate R-down in the persistent server
conductor shell:

~~~bash
set -euo pipefail

capture_host_cmd r-down-verdict jq -e \
  --arg day "$RUN_DATE" \
  '(.startedAt[0:10] == $day)
   and .registeredProperties.payloadBytes == 1150
   and .registeredProperties.lossBoundPct == 0.1
   and (.ceiling.cleanPps // 0) >= 75000
   and (.link.mtuBytes // 0) >= 1280
   and (.rtt.p99Ms // 1e99) <= 5' \
  "$HOST_EVIDENCE_DIR/preflight-r-down.json"
~~~

Evaluate R-up in the generator qualification shell:

~~~bash
set -euo pipefail

capture_host_cmd r-up-verdict jq -e \
  --arg day "$RUN_DATE" \
  '(.startedAt[0:10] == $day)
   and .registeredProperties.payloadBytes == 64
   and .registeredProperties.lossBoundPct == 0.1
   and (.ceiling.cleanPps // 0) >= 20000
   and (.link.mtuBytes // 0) >= 1280
   and (.rtt.p99Ms // 1e99) <= 5' \
  "$HOST_EVIDENCE_DIR/preflight-r-up.json"
~~~

If the registration-common artifact supplies a peer-side RTT vantage or a
direction-specific preflight evaluator, retain and run that exact registered
check as well. A preflight artifact with a wrong VPC guard, missing UDP rung,
missing RTT, stale date, or a generator-side shortfall is a refusal.

#### Bidirectional loaded leg

Run the registered common-campaign loaded-leg procedure after the two
directional preflights and capture its raw output, stderr, exit status, and
parsed result. The fixed qualification target is simultaneous 750 Mbit/s at
1150 B in the registered down direction plus 12 Mbit/s at 64 B in the
registered up direction for 20 seconds, with loss at most 0.5% in each
direction. The external common registration owns the peer-side concurrent
iperf3 setup and its parser; this runbook does not replace it with a free-form
command. Any missing direction, wrong payload, wrong duration, offered-only
result, or loss above the ceiling stops the run.

#### Generator sink precheck

Run the tracked sink producer in the generator qualification shell. This is
deliberately a loopback check of the generator's UDP source/receive path, not a
substitute for the VPC qualification or the MMO client in the gate:

~~~bash
set -euo pipefail

cd "$GENERATOR_CLONE"
capture_host_cmd g6-sink-precheck bash -lc '
  set -euo pipefail
  exec "$REMOTE_BUN_BIN" tools/load/g6-sink-precheck.ts \
    --out "$HOST_EVIDENCE_DIR/g6-sink-precheck.json" \
    --seconds 30
'
capture_host_cmd g6-sink-precheck-verdict jq -e \
  '(.requiredPps == 116250)
   and (.precheckOriginatorSaturated == false)
   and (.precheckOfferedPps >= .requiredPps)
   and (.precheckDeliveryRatio >= 0.995)' \
  "$HOST_EVIDENCE_DIR/g6-sink-precheck.json"
~~~

The raw artifact's requiredPps, targetPps, offered rate, delivery ratio, and
saturation flag must remain visible. The convenience wouldFireVS line is not a
campaign verdict.

Return to the persistent server conductor shell before calibration and keep
the existing `/tmp/bench.lock` descriptor open. Do not reacquire the lock in a
new server session.

### 16.3 Frontier-shape steering calibration

The current candidate supports only the registered 16-shard shape, so the
calibration must prove SHARD_COUNT=16 and use the profile's FRONTIER_RUNG, not
a smaller representative load. It runs before the licensed reset and is never
itself a licensed rung. Use the same scan environment as the later ladder,
including private addressing, candidate and registration digests, endpoint
count, RSS limit, and connect-timeout input:

~~~bash
set -euo pipefail

test "$SHARD_COUNT" -eq 16
test "$BPF_MAX_INSTANCES" -eq "$SHARD_COUNT"
test "$ENDPOINT_COUNT" -eq 128
test "$CONNECT_CONCURRENCY" -eq 500
test "$CONNECT_TIMEOUT_SECONDS" -eq 300

cd "$CLONE"
grep -F 'const CONNECT_CONCURRENCY = 500;' tools/load/g6-sharded-scan.ts
grep -F 'const STEADY_SECONDS = 120;' tools/load/g6-sharded-scan.ts
grep -F '"SCAN_CONNECT_TIMEOUT_SECONDS",' tools/load/g6-sharded-scan.ts

export BUN_BIN="$REMOTE_BUN_BIN"
test -x "$BUN_BIN"
test "$BUN_BIN" != "/Users/vmeansdev/.local/share/mise/installs/node/23.9.0/bin/node"

run_g6_scan() {
  local label="$1"
  local rung="$2"
  local scan_out="$HOST_EVIDENCE_DIR/g6-sharded-scan-$label.json"
  local diagnostic_out="$HOST_EVIDENCE_DIR/g6-sharded-diagnostic-$label.json"

  capture_host_cmd "g6-sharded-scan-$label" env \
    SCAN_DIAGNOSTIC=1 \
    SCAN_SHARDS="$SHARD_COUNT" \
    SCAN_SESSIONS="$rung" \
    SCAN_OUT="$scan_out" \
    SCAN_DIAGNOSTIC_OUT="$diagnostic_out" \
    SCAN_PIN_DIR="$PIN_DIR" \
    G6_OFFBOX_SSH="$G6_OFFBOX_SSH" \
    G6_OFFBOX_ENTRY_SCRIPT="$G6_OFFBOX_ENTRY_SCRIPT" \
    G6_CANDIDATE_SHA="$CANDIDATE_SHA" \
    G6_PREREGISTRATION_SHA256="$PREREGISTRATION_SHA256" \
    G6_SERVER_ADDRESS="$SERVER_PRIVATE_IPV4" \
    G6_PORT="$PORT" \
    G6_PACED_EMITTER=0 \
    SCAN_ENDPOINTS="$ENDPOINT_COUNT" \
    MMO_CLIENT_RSS_LIMIT_MB="$RSS_LIMIT_MB" \
    SCAN_CONNECT_TIMEOUT_SECONDS="$CONNECT_TIMEOUT_SECONDS" \
    "$BUN_BIN" tools/load/g6-sharded-scan.ts
}

run_g6_scan calibration "$FRONTIER_RUNG"
capture_host_cmd calibration-steer-stats \
  sudo bpftool map dump pinned "$PIN_DIR/steer_stats" -j
~~~

Use the tracked grader as the parser for the calibration's exact bpftool JSON
shape. This is a diagnostic grade only; it does not publish or promote the
frontier rung. A nonzero grader status is a calibration refusal and must be
retained. A valid calibration must show the tracked client's steady upstream
count and a steered-packet delta at least 1.8 times that count:

~~~bash
set -euo pipefail

set +e
capture_host_cmd calibration-grade \
  "$BUN_BIN" tools/load/g6-sharded-grade.ts \
  --expect-candidate "$CANDIDATE_SHA" \
  --steer-stats "$HOST_EVIDENCE_DIR/calibration-steer-stats.stdout.txt" \
  --rung "$FRONTIER_RUNG=$HOST_EVIDENCE_DIR/g6-sharded-scan-calibration.json" \
  --out "$HOST_EVIDENCE_DIR/g6-sharded-grade-calibration.json"
calibration_grade_status=$?
set -e
printf '%s\n' "$calibration_grade_status" \
  >"$HOST_EVIDENCE_DIR/calibration-grade.exit-status"
test "$calibration_grade_status" -eq 0

capture_host_cmd calibration-steering-ratio jq -e '
  if (.steeredDeltas | length) != 1
     or (.rungs | length) != 1
     or (.rungs[0].steadySent // 0) <= 0
     or ((.steeredDeltas[0] / .rungs[0].steadySent) < 1.8)
  then error("frontier steering calibration ratio is below the registered 1.8 margin")
  else
    .steeredDeltas[0] as $steered
    | .rungs[0].steadySent as $sent
    | {frontierRung: .rungs[0].rung,
       clientSteadyUpstream: $sent,
       steeredDelta: $steered,
       steeredToClientSteadyRatio: ($steered / $sent)}
  end
' "$HOST_EVIDENCE_DIR/g6-sharded-grade-calibration.json"
~~~

Retain the calibration scan, diagnostic JSON, raw map dump, grader JSON, and
ratio output together. The scan's packet-rate evidence and the computed
steeredDeltas[0] / rungs[0].steadySent ratio are both required; a nonzero
counter without the frontier-shape rate is not sufficient. If the 1.8 ratio is
not met, block dispatch and re-derive/re-review the registered steering floor
before any licensed run. Do not adjust the floor after seeing a licensed rung.

### 16.4 Fresh maps immediately before the licensed ladder

While file descriptor 9 is still held, re-run the tracked setup after
calibration. This is the licensed dispatch reset: it removes qualification
pins and recreates the profile-sized maps, including a zeroed steer_stats.
There must be no load, calibration, server start, or alternate map mutation
between this reset and the first licensed rung. Preserve the exact JSON dump;
an unusable or non-fresh map is a refusal:

~~~bash
set -euo pipefail

cd "$CLONE"
capture_host_cmd licensed-bpf-repin \
  sudo env PIN_DIR="$PIN_DIR" \
  tools/load/g6-shard-bpf-setup.sh "$SHARD_COUNT"
capture_host_cmd licensed-steer-stats-zero \
  sudo bpftool map dump pinned "$PIN_DIR/steer_stats" -j

test "$SHARD_COUNT" -eq "$BPF_MAX_INSTANCES"
test "$SERVER_ID_MIN" -eq 1
test "$SERVER_ID_MAX" -eq "$SHARD_COUNT"
~~~

The setup script and the captured zero-state dump are the freshness boundary.
If setup fails, the map dump is not valid JSON, the profile-sized map cannot
be demonstrated, or any other process changes the map before the first rung,
retain the artifacts and follow the registration's infrastructure-refusal
rule. Do not reuse the calibration counters.

### 16.5 Profile-driven licensed scan and rung semantics

The current candidate's effective dispatch contract is source-bound:
ENDPOINT_COUNT=128, CONNECT_CONCURRENCY=500, G6_PACED_EMITTER=0, and a
120-second steady window. CONNECT_CONCURRENCY is not an environment override
on this candidate; the manifest value is a compatibility mirror that must be
checked against the source. CONNECT_TIMEOUT_SECONDS must remain 300 for the
current registration, and the scan forwards it to both the native client's
connect-timeout flag and the launcher watchdog. A future registered timeout or
concurrency value requires a new source-bound registration.

The scan function above is the same source-bound invocation used for
calibration. It records a separate raw scan and diagnostic artifact for every
registered rung, and uses the exact private server address. The registration
must provide RUNG_LIST as a shell-safe, whitespace-delimited list in ascending
order; no rung values are hard-coded here:

~~~bash
set -euo pipefail

test "$ENDPOINT_COUNT" -eq 128
test "$CONNECT_CONCURRENCY" -eq 500
test "$CONNECT_TIMEOUT_SECONDS" -eq 300
test -n "$RUNG_LIST"

printf 'RUNG_LIST=%q\n' "$RUNG_LIST" \
  >"$HOST_EVIDENCE_DIR/licensed-dispatch-profile.env"
printf 'SHARD_COUNT=%q\n' "$SHARD_COUNT" \
  >>"$HOST_EVIDENCE_DIR/licensed-dispatch-profile.env"
printf 'BPF_MAX_INSTANCES=%q\n' "$BPF_MAX_INSTANCES" \
  >>"$HOST_EVIDENCE_DIR/licensed-dispatch-profile.env"
printf 'ENDPOINT_COUNT=%q\n' "$ENDPOINT_COUNT" \
  >>"$HOST_EVIDENCE_DIR/licensed-dispatch-profile.env"
printf 'CONNECT_CONCURRENCY=%q\n' "$CONNECT_CONCURRENCY" \
  >>"$HOST_EVIDENCE_DIR/licensed-dispatch-profile.env"
printf 'CONNECT_TIMEOUT_SECONDS=%q\n' "$CONNECT_TIMEOUT_SECONDS" \
  >>"$HOST_EVIDENCE_DIR/licensed-dispatch-profile.env"

for RUNG in $RUNG_LIST; do
  case "$RUNG" in
    ''|*[!0-9]*)
      printf '%s\n' "RUNG_LIST contains a non-numeric rung: $RUNG" >&2
      exit 1
      ;;
  esac
  run_g6_scan "licensed-$RUNG" "$RUNG"

  SCAN_ARTIFACT="$HOST_EVIDENCE_DIR/g6-sharded-scan-licensed-$RUNG.json"
  DIAGNOSTIC_ARTIFACT="$HOST_EVIDENCE_DIR/g6-sharded-diagnostic-licensed-$RUNG.json"
  test -s "$SCAN_ARTIFACT"
  test -s "$DIAGNOSTIC_ARTIFACT"

  capture_host_cmd "scan-contract-$RUNG" jq -e \
    --arg candidate "$CANDIDATE_SHA" \
    --argjson shards "$SHARD_COUNT" \
    --argjson endpoints "$ENDPOINT_COUNT" \
    --argjson sessions "$RUNG" \
    '.schema == "g6-sharded-scan/1"
     and .candidateSha == $candidate
     and .config.shards == $shards
     and .config.sessions == $sessions
     and .config.endpoints == $endpoints
     and .config.paced == false
     and .config.steadySeconds == 120' \
    "$SCAN_ARTIFACT"

  # The preregistration requires one cumulative JSON dump after every rung.
  # g6-sharded-grade computes per-rung deltas from these files in this order.
  capture_host_cmd "steer-stats-$RUNG" \
    sudo bpftool map dump pinned "$PIN_DIR/steer_stats" -j
done
~~~

Each rung's result is terminal only for that rung: a valid PASS or MISS does
not stop later registered rungs, and a later rung cannot rewrite an earlier
result. A nonzero scan/conductor/client exit, missing diagnostic/raw artifact,
failed postcondition, connect-phase stall, unusable map dump, or other
infrastructure/validity failure remains a refusal. Apply the exact same-day
retry/stop rule in the registration; never turn a refusal into a MISS, skip
ahead silently, or lower the registered thresholds. The subsequent grader must
receive the rung scan files and the matching steer-stats files in the same
ascending order.

## 17. Evidence sealing, independent recomputation, and teardown gate

Do not delete either Droplet until the raw measurement, diagnostic evidence,
qualification evidence, and terminal campaign record have been copied into the
local run directory. Preserve bytes exactly: do not reformat, sort, rewrite, or
round JSON before hashing. A missing artifact is a refusal, not a reason to
reconstruct it from console output.

### 17.1 Copy and inventory raw evidence

Return to the local operator shell in the source-bound candidate checkout and
source the exact preserved recovery context. Do not run this copy or the later
grader in either host shell. The two remote evidence paths must be the paths
actually created by the host bootstrap; normally they are /var/tmp/RUN_ID, but
do not guess them. Use public addresses only for this administrative transfer:

~~~bash
set -euo pipefail

test -n "$EVIDENCE_DIR"
test -n "$SSH_ADMIN_USER"
test -n "$SERVER_PUBLIC_IPV4"
test -n "$GENERATOR_PUBLIC_IPV4"
test -n "$SERVER_HOST_EVIDENCE_DIR"
test -n "$GENERATOR_HOST_EVIDENCE_DIR"

mkdir -p "$EVIDENCE_DIR/hosts/server" "$EVIDENCE_DIR/hosts/generator"

capture_local_cmd() {
  local label="$1"
  shift
  local status

  if "$@" >"$EVIDENCE_DIR/$label.stdout.txt" \
    2>"$EVIDENCE_DIR/$label.stderr.txt"; then
    status=0
  else
    status=$?
  fi
  printf '%s\n' "$status" >"$EVIDENCE_DIR/$label.status"
  if [ "$status" -ne 0 ]; then
    return "$status"
  fi
}

capture_local_cmd copy-server-evidence rsync -a -- \
  "$SSH_ADMIN_USER@$SERVER_PUBLIC_IPV4:$SERVER_HOST_EVIDENCE_DIR/" \
  "$EVIDENCE_DIR/hosts/server/"
capture_local_cmd copy-generator-evidence rsync -a -- \
  "$SSH_ADMIN_USER@$GENERATOR_PUBLIC_IPV4:$GENERATOR_HOST_EVIDENCE_DIR/" \
  "$EVIDENCE_DIR/hosts/generator/"

test -s "$EVIDENCE_DIR/hosts/server/g6-sharded-scan-calibration.json"
test -s "$EVIDENCE_DIR/hosts/server/g6-sharded-diagnostic-calibration.json"
test -s "$EVIDENCE_DIR/hosts/server/g6-sharded-grade-calibration.json"
test -s "$EVIDENCE_DIR/hosts/server/calibration-steer-stats.stdout.txt"
test -s "$EVIDENCE_DIR/hosts/server/preflight-r-down.json"
test -s "$EVIDENCE_DIR/hosts/server/r-down-plan.stdout.txt"
test -s "$EVIDENCE_DIR/hosts/generator/preflight-r-up.json"
test -s "$EVIDENCE_DIR/hosts/generator/r-up-plan.stdout.txt"
test -s "$EVIDENCE_DIR/hosts/generator/g6-sink-precheck.json"

for RUNG in $RUNG_LIST; do
  test -s "$EVIDENCE_DIR/hosts/server/g6-sharded-scan-licensed-$RUNG.json"
  test -s "$EVIDENCE_DIR/hosts/server/g6-sharded-diagnostic-licensed-$RUNG.json"
  test -s "$EVIDENCE_DIR/hosts/server/steer-stats-$RUNG.stdout.txt"
done
~~~

The inventory must include, at minimum: the raw scan JSON for every registered
rung; every diagnostic JSON and sidecar; the raw calibration and per-rung
bpftool dumps; per-shard filtered `/proc`-derived counters embedded in each
diagnostic JSON; server, conductor, generator, and
client logs; both preflight artifacts and plan output; the bidirectional loaded
leg result; the sink artifact; the profile manifest; candidate, entrypoint,
runtime, and generated-client hashes; the create/list/get identity outputs;
and the authority copies and registration digest. Keep both stdout/stderr and
status files for commands even when the command failed. If the registered
loaded-leg or profile paths have names not covered above, add those exact
registration-supplied paths before sealing.

### 17.2 Grade the ladder and separate campaign states

From the local operator shell, run the tracked g6-sharded grader once over the
copied immutable licensed scan files and matching cumulative JSON steer_stats
dumps, in the registered rung order. The grader's exit code and JSON are both
evidence: exit 0 means every rung is valid, while a valid rung may still be PASS
or MISS; exit 2 means at least one rung has a validity refusal. Do not treat a
MISS as an infrastructure failure or a refusal as a MISS:

~~~bash
set -euo pipefail

test -x "$BUN_BIN"
test -f tools/load/g6-sharded-grade.ts
test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"

grade_args=(--expect-candidate "$CANDIDATE_SHA")
for RUNG in $RUNG_LIST; do
  grade_args+=(--steer-stats \
    "$EVIDENCE_DIR/hosts/server/steer-stats-$RUNG.stdout.txt")
  grade_args+=(--rung \
    "$RUNG=$EVIDENCE_DIR/hosts/server/g6-sharded-scan-licensed-$RUNG.json")
done

set +e
capture_local_cmd g6-sharded-grade \
  "$BUN_BIN" tools/load/g6-sharded-grade.ts \
  "${grade_args[@]}" \
  --out "$EVIDENCE_DIR/g6-sharded-grade-licensed.json"
grade_status=$?
set -e
printf '%s\n' "$grade_status" \
  >"$EVIDENCE_DIR/g6-sharded-grade.exit-status"
test -s "$EVIDENCE_DIR/g6-sharded-grade-licensed.json"
~~~

On a second machine, independently recompute the grader from the immutable raw
scan files and matching map dumps, using the same candidate and registration
inputs. The independent result must agree byte-for-byte on the rungs array.
Recompute diagnostic hypotheses separately from the diagnostic JSON;
diagnostic D1/D2/D3 hypotheses do not alter the registered PASS/MISS verdict.

Keep these states distinct:

- measured verdict: the registration-bound grader's valid PASS or MISS for a
  rung;
- refusal/abort: the validity or infrastructure record that produced no rung
  verdict;
- publication: an explicit review decision to make the evidence available; and
- promotion: a separate decision that changes an official registration,
  release, or capacity claim.

No state is implied by the others. In particular, an empty or deleted Droplet
does not prove a verdict, and a PASS/MISS does not authorize publication or
promotion.

### 17.3 Checksum seal and teardown gate

After all raw files, grader outputs, identity captures, and terminal records
are present, create one complete SHA256SUMS file. It covers every regular
evidence file except itself and the checksum command's own capture sidecars.
Those sidecars are retained separately because recording the seal and verify
commands necessarily creates new files after the manifest is computed.
Re-running the seal after any later copy is mandatory:

~~~bash
set -euo pipefail

cd "$EVIDENCE_DIR"
test -z "$(find . -type l -print -quit)"
mkdir -p checksum-sidecars
capture_local_cmd seal-sha256sums bash -lc '
  set -euo pipefail
  find . -type f ! -name SHA256SUMS ! -path "./checksum-sidecars/*" -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum >SHA256SUMS
'
mv "$EVIDENCE_DIR"/seal-sha256sums.* "$EVIDENCE_DIR/checksum-sidecars/"
capture_local_cmd verify-sha256sums bash -lc '
  set -euo pipefail
  sha256sum -c SHA256SUMS
'
mv "$EVIDENCE_DIR"/verify-sha256sums.* "$EVIDENCE_DIR/checksum-sidecars/"
~~~

Retain the checksum output and status under `checksum-sidecars/`. Transfer the
sealed directory to an
independent machine, run sha256sum -c SHA256SUMS there, and compare the
independent checksum results before any teardown. Do not add a final note,
identity file, or grading output after the seal without regenerating and
rechecking SHA256SUMS.

Only after the checksum and independent recomputation pass may the operator
enter section 10. Section 10 is the canonical teardown safeguard: it re-gets
the exact SERVER_ID and GENERATOR_ID, checks each captured object against its
role name, region, expected VPC, and RUN_TAG, deletes only those two exact IDs
in separate captured commands, and requires an empty final list for the unique
run tag. A failed final get, delete, or empty-list assertion leaves the
evidence intact and is not repaired with --all, a wildcard, a broad tag
selector, or a remembered ID.

If provisioning was partial, the evidence is incomplete, or qualification or
dispatch refused, use section 9's exact-ID recovery path and record a
refusal/abort bundle instead of entering the completed-run teardown gate.

## 18. Provisioning and dispatch rule

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
not the private VPC network. If provisioning is partial or failed, use the
exact-ID recovery restart procedure in §9 before any retry.

This runbook remains procedural only. Campaign approval, rung validity, and
terminal verdicts still come from the registration-bound campaign process, not
from the existence of this document.
