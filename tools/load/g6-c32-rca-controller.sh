#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' \
    'Usage: g6-c32-rca-controller.sh run|qualify --bound-root PATH --repository PATH --budget-policy PATH --spend-ledger PATH [--deadline RFC3339]'
}

MODE=${1:-}
case "$MODE" in
  run|qualify) shift ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 64 ;;
esac

BOUND_ROOT_ARG=
REPOSITORY_ARG=
DEADLINE=
BUDGET_POLICY_ARG=
SPEND_LEDGER_ARG=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --bound-root)
      [ "$#" -ge 2 ] || { usage >&2; exit 64; }
      [ -z "$BOUND_ROOT_ARG" ] || exit 64
      BOUND_ROOT_ARG=$2
      shift 2
      ;;
    --repository)
      [ "$#" -ge 2 ] || { usage >&2; exit 64; }
      [ -z "$REPOSITORY_ARG" ] || exit 64
      REPOSITORY_ARG=$2
      shift 2
      ;;
    --deadline)
      [ "$#" -ge 2 ] || { usage >&2; exit 64; }
      [ -z "$DEADLINE" ] || exit 64
      DEADLINE=$2
      shift 2
      ;;
    --budget-policy)
      [ "$#" -ge 2 ] || { usage >&2; exit 64; }
      [ -z "$BUDGET_POLICY_ARG" ] || exit 64
      BUDGET_POLICY_ARG=$2
      shift 2
      ;;
    --spend-ledger)
      [ "$#" -ge 2 ] || { usage >&2; exit 64; }
      [ -z "$SPEND_LEDGER_ARG" ] || exit 64
      SPEND_LEDGER_ARG=$2
      shift 2
      ;;
    *) usage >&2; exit 64 ;;
  esac
done
[ -n "$BOUND_ROOT_ARG" ] || exit 64
[ -n "$REPOSITORY_ARG" ] || exit 64
[ -n "$BUDGET_POLICY_ARG" ] || exit 64
[ -n "$SPEND_LEDGER_ARG" ] || exit 64

BOOTSTRAP_BUN=${G6_C32_BOOTSTRAP_BUN:-bun}
VERIFIED_ENV=$(mktemp "${TMPDIR:-/tmp}/g6-c32-verified.XXXXXX")
remove_verified_env() {
  rm -f "$VERIFIED_ENV"
}
trap remove_verified_env EXIT

"$BOOTSTRAP_BUN" "$REPOSITORY_ARG/tools/load/g6-c32-freeze.ts" verify \
  --root "$BOUND_ROOT_ARG" --repository "$REPOSITORY_ARG" >"$VERIFIED_ENV"

REQUIRED_VERIFIED_KEYS='G6_C32_BOUND_ROOT
G6_C32_BUDGET_POLICY_PATH
G6_C32_BUDGET_POLICY_SHA256
G6_C32_CANDIDATE_BUNDLE_PATH
G6_C32_CANDIDATE_COMMIT
G6_C32_CANDIDATE_TREE
G6_C32_CONTROLLER_PATH
G6_C32_DISPATCH_FREEZE_SHA256
G6_C32_EVIDENCE_ROOT
G6_C32_GENERATOR_BINARY_PATH
G6_C32_GENERATOR_BINARY_SHA256
G6_C32_GENERATOR_BOOT_ID
G6_C32_GENERATOR_ID
G6_C32_GENERATOR_NAME
G6_C32_GENERATOR_PRIVATE_IPV4
G6_C32_GENERATOR_PUBLIC_IPV4
G6_C32_HOST_BINDING_AUTHORITY_SHA256
G6_C32_KNOWN_HOSTS_PATH
G6_C32_OFFRUNNER_BUN
G6_C32_REGISTRATION_PATH
G6_C32_REGISTRATION_SHA256
G6_C32_REMOTE_ROOT
G6_C32_REPOSITORY_PATH
G6_C32_RUN_ID
G6_C32_SEMANTIC_FREEZE_AUTHORITY_SHA256
G6_C32_SERVER_BINARY_PATH
G6_C32_SERVER_BINARY_SHA256
G6_C32_SERVER_BOOT_ID
G6_C32_SERVER_ID
G6_C32_SERVER_NAME
G6_C32_SERVER_PRIVATE_IPV4
G6_C32_SERVER_PUBLIC_IPV4
G6_C32_SPEND_LEDGER_PATH
G6_C32_VPC_UUID'
SEEN_VERIFIED_KEYS=
while IFS='=' read -r key encoded; do
  [ -n "$key" ] || exit 65
  case "$key" in
    G6_C32_BOUND_ROOT|G6_C32_BUDGET_POLICY_PATH|G6_C32_BUDGET_POLICY_SHA256|G6_C32_CANDIDATE_BUNDLE_PATH|G6_C32_CANDIDATE_COMMIT|G6_C32_CANDIDATE_TREE|G6_C32_CONTROLLER_PATH|G6_C32_DISPATCH_FREEZE_SHA256|G6_C32_EVIDENCE_ROOT|G6_C32_GENERATOR_BINARY_PATH|G6_C32_GENERATOR_BINARY_SHA256|G6_C32_GENERATOR_BOOT_ID|G6_C32_GENERATOR_ID|G6_C32_GENERATOR_NAME|G6_C32_GENERATOR_PRIVATE_IPV4|G6_C32_GENERATOR_PUBLIC_IPV4|G6_C32_HOST_BINDING_AUTHORITY_SHA256|G6_C32_KNOWN_HOSTS_PATH|G6_C32_OFFRUNNER_BUN|G6_C32_REGISTRATION_PATH|G6_C32_REGISTRATION_SHA256|G6_C32_REMOTE_ROOT|G6_C32_REPOSITORY_PATH|G6_C32_RUN_ID|G6_C32_SEMANTIC_FREEZE_AUTHORITY_SHA256|G6_C32_SERVER_BINARY_PATH|G6_C32_SERVER_BINARY_SHA256|G6_C32_SERVER_BOOT_ID|G6_C32_SERVER_ID|G6_C32_SERVER_NAME|G6_C32_SERVER_PRIVATE_IPV4|G6_C32_SERVER_PUBLIC_IPV4|G6_C32_SPEND_LEDGER_PATH|G6_C32_VPC_UUID) ;;
    *) exit 65 ;;
  esac
  case "$encoded" in
    \'[A-Za-z0-9_./:@-]*\') ;;
    *) exit 65 ;;
  esac
  value=${encoded#\'}
  value=${value%\'}
  [ -n "$value" ] || exit 65
  if printf '%s\n' "$SEEN_VERIFIED_KEYS" | grep -Fxq "$key"; then
    exit 65
  fi
  SEEN_VERIFIED_KEYS="${SEEN_VERIFIED_KEYS}${SEEN_VERIFIED_KEYS:+
}$key"
  printf -v "$key" '%s' "$value"
  export "$key"
done <"$VERIFIED_ENV"

while IFS= read -r required_key; do
  printf '%s\n' "$SEEN_VERIFIED_KEYS" | grep -Fxq "$required_key" || exit 65
done <<EOF
$REQUIRED_VERIFIED_KEYS
EOF

[ "$G6_C32_BOUND_ROOT" = "$BOUND_ROOT_ARG" ] || exit 66
[ "$G6_C32_REPOSITORY_PATH" = "$REPOSITORY_ARG" ] || exit 66
[ "$G6_C32_BUDGET_POLICY_PATH" = "$BUDGET_POLICY_ARG" ] || exit 66
[ "$G6_C32_SPEND_LEDGER_PATH" = "$SPEND_LEDGER_ARG" ] || exit 66
SCRIPT_PATH=$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")
[ "$G6_C32_CONTROLLER_PATH" = "$SCRIPT_PATH" ] || exit 66
rm -f "$VERIFIED_ENV"
trap - EXIT

BUDGET_LIFECYCLE=$("$G6_C32_OFFRUNNER_BUN" -e '
  import { pathToFileURL } from "node:url";
  const [repository, policyPath]=process.argv.slice(1);
  const { validateBudgetPolicy }=await import(pathToFileURL(`${repository}/tools/load/g6-c32-budget.ts`).href);
  const policy=validateBudgetPolicy(await Bun.file(policyPath).json());
  console.log(policy.lifecycle);
' "$REPOSITORY_ARG" "$BUDGET_POLICY_ARG")
case "$BUDGET_LIFECYCLE" in
  rca-only|post-fix-only) ;;
  *) exit 67 ;;
esac
if [ "$MODE" = run ] && [ "$BUDGET_LIFECYCLE" = post-fix-only ]; then
  printf '%s\n' 'post-fix-only has no frozen mechanism-specific executor' >&2
  exit 67
fi

# All remote calls use ssh -n semantics, including every background command.
SSH_BIN=ssh
SCP_BIN=scp
DOCTL_BIN=doctl
SERVER_CLONE=${G6_C32_SERVER_BINARY_PATH%/crates/native/webtransport-native.linux-x64-gnu.node}
GENERATOR_CLONE=${G6_C32_GENERATOR_BINARY_PATH%/target/release/mmo-client}
[ "$SERVER_CLONE" != "$G6_C32_SERVER_BINARY_PATH" ] || exit 66
[ "$GENERATOR_CLONE" != "$G6_C32_GENERATOR_BINARY_PATH" ] || exit 66
REMOTE_BUN=/opt/g6/bin/bun
RCA_EVALUATOR=tools/load/g6-c32-rca-evaluate.ts
BUDGET_CLI=$REPOSITORY_ARG/tools/load/g6-c32-budget-cli.ts
SUCCESSOR_GRADER=tools/load/g6-c32-successor-grade.ts
LINUX_PROBE=tools/load/g6-linux-probe.ts
FIXED_SOURCE_PORT_BASE=20000
SSH_OPTIONS=(
  -o "UserKnownHostsFile=$G6_C32_KNOWN_HOSTS_PATH"
  -o StrictHostKeyChecking=yes
  -o BatchMode=yes
)

g6_ssh() {
  command "$SSH_BIN" -n "${SSH_OPTIONS[@]}" "$@"
}

g6_scp() {
  command "$SCP_BIN" "${SSH_OPTIONS[@]}" "$@"
}

rfc3339_now() {
  date -u '+%Y-%m-%dT%H:%M:%S.000Z'
}

monotonic_now() {
  perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC -e \
    'printf "%.0f\n", clock_gettime(CLOCK_MONOTONIC) * 1000000000'
}

OPERATION_SEQUENCE=0
next_operation_sequence() {
  local lock_path="$G6_C32_EVIDENCE_ROOT/.sequence-lock"
  local sequence_path="$G6_C32_EVIDENCE_ROOT/.operation-sequence"
  local attempts=0 current next temporary
  while ! mkdir "$lock_path" 2>/dev/null; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 1000 ] || return 91
    sleep 0.01
  done
  current=$(cat "$sequence_path")
  next=$((current + 1))
  temporary="$sequence_path.tmp-$$-${RANDOM:-0}"
  printf '%s\n' "$next" >"$temporary"
  mv "$temporary" "$sequence_path"
  rmdir "$lock_path"
  printf '%s\n' "$next"
}

write_operation_receipt() {
  local receipt_path=$1
  local operation_id=$2
  local phase=$3
  local started_at=$4
  local finished_at=$5
  local duration_ns=$6
  local status=$7
  local stdout_path=$8
  local stderr_path=$9
  shift 9
  local command=$1
  shift
  "$G6_C32_OFFRUNNER_BUN" -e '
    import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
    import { dirname } from "node:path";
    const [receiptPath, runId, sequenceText, operationId, phase, startedAt, finishedAt, durationMonotonicNs, statusText, stdoutPath, stderrPath, command, ...args] = process.argv.slice(1);
    const sequence = Number(sequenceText);
    const exitCode = Number(statusText);
    const receipt = {
      schema: "g6-c32-operation-receipt/1",
      envelope: { recordedAt: finishedAt, sequence, runId, phase, operationId, clockSource: "offrunner" },
      startedAt,
      finishedAt,
      durationMonotonicNs,
      attempt: 1,
      action: { command, args, cwd: process.cwd(), environmentKeys: [] },
      status: { outcome: exitCode === 0 ? "SUCCEEDED" : "FAILED", exitCode, signal: null },
      stdoutPath,
      stderrPath,
      remoteTiming: null,
    };
    const sort = (value) => Array.isArray(value) ? value.map(sort) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value;
    mkdirSync(dirname(receiptPath), { recursive: true });
    const temporary = `${receiptPath}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(sort(receipt), null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const file = openSync(temporary, "r"); fsyncSync(file); closeSync(file);
    renameSync(temporary, receiptPath);
    const directory = openSync(dirname(receiptPath), "r"); fsyncSync(directory); closeSync(directory);
  ' "$receipt_path" "$G6_C32_RUN_ID" "$OPERATION_SEQUENCE" "$operation_id" "$phase" \
    "$started_at" "$finished_at" "$duration_ns" "$status" "$stdout_path" \
    "$stderr_path" "$command" "$@"
}

capture_operation() {
  local label=$1
  local operation_id=$2
  local phase=$3
  shift 3
  local restore_errexit=0
  local status receipt_status
  local started_at finished_at started_ns finished_ns duration_ns
  case $- in *e*) restore_errexit=1 ;; esac
  mkdir -p "$(dirname "$label")"
  OPERATION_SEQUENCE=$(next_operation_sequence)
  started_at=$(rfc3339_now)
  started_ns=$(monotonic_now)
  set +e
  "$@" >"$label.stdout" 2>"$label.stderr"
  status=$?
  finished_ns=$(monotonic_now)
  finished_at=$(rfc3339_now)
  duration_ns=$((finished_ns - started_ns))
  write_operation_receipt "$label.receipt.json" "$operation_id" "$phase" \
    "$started_at" "$finished_at" "$duration_ns" "$status" \
    "${label#$G6_C32_EVIDENCE_ROOT/}.stdout" \
    "${label#$G6_C32_EVIDENCE_ROOT/}.stderr" "$@"
  receipt_status=$?
  if [ "$restore_errexit" -eq 1 ]; then set -e; fi
  [ "$receipt_status" -eq 0 ] || return "$receipt_status"
  return "$status"
}

before_new_work() {
  [ -z "$DEADLINE" ] || "$G6_C32_OFFRUNNER_BUN" -e '
    const deadline = Date.parse(process.argv[1]);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) process.exit(88);
  ' "$DEADLINE"
}

admit_budget_cell() {
  local cell=$1 stage=$2 local_dir=$3
  local request_path="$local_dir/admission-request.json"
  local receipt_path="$local_dir/admission.json"
  mkdir -p "$local_dir"
  "$G6_C32_OFFRUNNER_BUN" -e '
    import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
    import { dirname } from "node:path";
    import { pathToFileURL } from "node:url";
    const [repository, policyPath, ledgerPath, stage, deadlineText, out] = process.argv.slice(1);
    const { maximumLifecycleCost, validateBudgetPolicy, validateSpendLedger } = await import(pathToFileURL(`${repository}/tools/load/g6-c32-budget.ts`).href);
    const policy = validateBudgetPolicy(await Bun.file(policyPath).json());
    const ledger = validateSpendLedger(await Bun.file(ledgerPath).json(), { requireSeal: false });
    const observed = ledger.entries.filter((entry) => entry.event === "CREATE_OBSERVED");
    if (observed.length !== 2) throw new Error("budget admission requires exactly two observed creates");
    const startedAt = Math.min(...observed.map((entry) => Date.parse(entry.recordedAt)));
    const now = Date.now();
    const deadline = Date.parse(deadlineText);
    if (!Number.isFinite(startedAt) || !Number.isFinite(deadline)) throw new Error("budget admission timestamps are invalid");
    const elapsedSeconds = Math.max(0, Math.ceil((now - startedAt) / 1000));
    const remainingDeadlineSeconds = Math.max(0, Math.floor((deadline - now) / 1000));
    const prices = policy.maximumRoleHourlyMicrousd;
    const accruedLifecycleMicrousd = maximumLifecycleCost({ hourlyMicrousdByRole: prices, executionSeconds: elapsedSeconds, teardownReserveSeconds: 0 });
    const prospectiveCellMicrousd = maximumLifecycleCost({ hourlyMicrousdByRole: prices, executionSeconds: policy.cellMaximumSeconds[stage], teardownReserveSeconds: 0 });
    const teardownReserveMicrousd = maximumLifecycleCost({ hourlyMicrousdByRole: prices, executionSeconds: 0, teardownReserveSeconds: policy.teardownReserveSeconds });
    const value = { recordedAt: new Date(now).toISOString(), stage, accruedLifecycleMicrousd, prospectiveCellMicrousd, teardownReserveMicrousd, remainingDeadlineSeconds };
    const temporary = `${out}.tmp-${process.pid}`;
    const fd = openSync(temporary, "wx", 0o600); writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); closeSync(fd); renameSync(temporary, out);
    const directory = openSync(dirname(out), "r"); fsyncSync(directory); closeSync(directory);
  ' "$REPOSITORY_ARG" "$BUDGET_POLICY_ARG" "$SPEND_LEDGER_ARG" "$stage" "$DEADLINE" "$request_path"
  set +e
  "$G6_C32_OFFRUNNER_BUN" "$BUDGET_CLI" admit-cell \
    --policy "$BUDGET_POLICY_ARG" --request "$request_path" \
    --ledger "$SPEND_LEDGER_ARG" --out "$receipt_path"
  local status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    local decision=REFUSED_BUDGET
    [ -f "$receipt_path" ] && decision=$("$G6_C32_OFFRUNNER_BUN" -e 'const value=await Bun.file(process.argv[1]).json(); console.log(value.decision)' "$receipt_path")
    printf '%s\n' "$decision" >"$G6_C32_EVIDENCE_ROOT/RUN_STATUS.next"
    mv "$G6_C32_EVIDENCE_ROOT/RUN_STATUS.next" "$G6_C32_EVIDENCE_ROOT/RUN_STATUS"
    return "$status"
  fi
}

mkdir -m 700 "$G6_C32_EVIDENCE_ROOT"
mkdir -p "$G6_C32_EVIDENCE_ROOT"/{qualification,probe,matrix,transfer,ladder,companion,closeout,cells}
printf '0\n' >"$G6_C32_EVIDENCE_ROOT/.operation-sequence"
printf 'INCOMPLETE\n' >"$G6_C32_EVIDENCE_ROOT/RUN_STATUS"
: >"$G6_C32_EVIDENCE_ROOT/rated-cells.log"

LOCK_PROCESS_PID=
SYSCTL_SNAPSHOT=
CAMPAIGN_TERMINAL=0
CAMPAIGN_CLEANED=0
stop_qualification_listeners() {
  capture_operation "$G6_C32_EVIDENCE_ROOT/closeout/stop-generator-listeners" \
    stop-generator-listeners CLEANUP g6_ssh root@"$G6_C32_GENERATOR_PUBLIC_IPV4" \
    "for path in '$G6_C32_REMOTE_ROOT/qualification/r-down.pid' '$G6_C32_REMOTE_ROOT/qualification/loaded-down.pid'; do if [ -f \"\$path\" ]; then kill \"\$(cat \"\$path\")\" 2>/dev/null || true; rm -f \"\$path\"; fi; done; : g6-controller-cleanup"
  capture_operation "$G6_C32_EVIDENCE_ROOT/closeout/stop-server-listeners" \
    stop-server-listeners CLEANUP g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" \
    "for path in '$G6_C32_REMOTE_ROOT/qualification/r-up.pid' '$G6_C32_REMOTE_ROOT/qualification/loaded-up.pid'; do if [ -f \"\$path\" ]; then kill \"\$(cat \"\$path\")\" 2>/dev/null || true; rm -f \"\$path\"; fi; done; : g6-controller-cleanup"
}

restore_server_sysctls_raw() {
  while read -r key value; do
    case "$key" in
      net.core.rmem_max|net.core.rmem_default|net.ipv4.udp_rmem_min) ;;
      *) return 93 ;;
    esac
    case "$value" in ''|*[!0-9]*) return 93 ;; esac
    g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" "sysctl -w '$key=$value'"
  done <"$SYSCTL_SNAPSHOT"
}

restore_server_settings() {
  local label=$1 phase=$2
  [ -n "$SYSCTL_SNAPSHOT" ] && [ -f "$SYSCTL_SNAPSHOT" ] || return 0
  capture_operation "$label" restore-server-sysctls "$phase" restore_server_sysctls_raw
}

apply_campaign_nofile() {
  local root="$G6_C32_EVIDENCE_ROOT/qualification"
  capture_operation "$root/apply-nofile-server" apply-nofile-server QUALIFYING \
    g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" \
    'printf "root soft nofile 1048576\nroot hard nofile 1048576\n" > /etc/security/limits.d/99-g6-rca-nofile.conf'
  capture_operation "$root/apply-nofile-generator" apply-nofile-generator QUALIFYING \
    g6_ssh root@"$G6_C32_GENERATOR_PUBLIC_IPV4" \
    'printf "root soft nofile 1048576\nroot hard nofile 1048576\n" > /etc/security/limits.d/99-g6-rca-nofile.conf'
}

restore_campaign_nofile() {
  capture_operation "$G6_C32_EVIDENCE_ROOT/closeout/restore-nofile-server" \
    restore-nofile-server CLEANUP g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" \
    'rm -f /etc/security/limits.d/99-g6-rca-nofile.conf; test ! -e /etc/security/limits.d/99-g6-rca-nofile.conf; : g6-controller-cleanup'
  capture_operation "$G6_C32_EVIDENCE_ROOT/closeout/restore-nofile-generator" \
    restore-nofile-generator CLEANUP g6_ssh root@"$G6_C32_GENERATOR_PUBLIC_IPV4" \
    'rm -f /etc/security/limits.d/99-g6-rca-nofile.conf; test ! -e /etc/security/limits.d/99-g6-rca-nofile.conf; : g6-controller-cleanup'
}

release_continuous_lock_raw() {
  if [ -n "$LOCK_PROCESS_PID" ]; then
    kill "$LOCK_PROCESS_PID" 2>/dev/null || true
    wait "$LOCK_PROCESS_PID" 2>/dev/null || true
    LOCK_PROCESS_PID=
  fi
}

cleanup_campaign() {
  local original_status=$?
  local cleanup_status=0
  [ "$CAMPAIGN_CLEANED" -eq 0 ] || return "$original_status"
  CAMPAIGN_CLEANED=1
  set +e
  if [ "$CAMPAIGN_TERMINAL" -ne 1 ]; then
    printf 'INCOMPLETE\n' >"$G6_C32_EVIDENCE_ROOT/RUN_STATUS"
  fi
  stop_qualification_listeners || cleanup_status=$?
  restore_server_settings "$G6_C32_EVIDENCE_ROOT/closeout/restore-sysctls" CLEANUP || cleanup_status=$?
  restore_campaign_nofile || cleanup_status=$?
  capture_operation "$G6_C32_EVIDENCE_ROOT/closeout/release-lock" \
    release-bench-lock CLEANUP release_continuous_lock_raw || cleanup_status=$?
  if [ "$original_status" -ne 0 ]; then return "$original_status"; fi
  return "$cleanup_status"
}
trap cleanup_campaign EXIT INT TERM HUP

acquire_continuous_lock() {
  local lock_out="$G6_C32_EVIDENCE_ROOT/qualification/bench-lock.stdout"
  local lock_err="$G6_C32_EVIDENCE_ROOT/qualification/bench-lock.stderr"
  local count=0
  before_new_work
  g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" \
    "exec 9>>/tmp/bench.lock; flock -w 30 9 || exit 42; recorded_at=\$(date -u '+%Y-%m-%dT%H:%M:%S.000Z'); printf '{\"schema\":\"g6-c32-lock-owner/1\",\"recordedAt\":\"%s\",\"runId\":\"%s\",\"pid\":%s}\\n' \"\$recorded_at\" '$G6_C32_RUN_ID' \"\$\$\" >/tmp/bench.lock.owner; printf 'LOCKED\\n'; while :; do sleep 30; done" \
    >"$lock_out" 2>"$lock_err" </dev/null &
  LOCK_PROCESS_PID=$!
  while [ "$count" -lt 300 ]; do
    kill -0 "$LOCK_PROCESS_PID" 2>/dev/null || { wait "$LOCK_PROCESS_PID"; return $?; }
    grep -Fxq LOCKED "$lock_out" 2>/dev/null && break
    count=$((count + 1))
    sleep 0.1
  done
  [ "$count" -lt 300 ] || return 42
  local sequence
  sequence=$(next_operation_sequence)
  printf '{"schema":"g6-c32-lock-acquired/1","envelope":{"recordedAt":"%s","sequence":%s,"runId":"%s","phase":"QUALIFYING","operationId":"bench-lock","clockSource":"offrunner"}}\n' \
    "$(rfc3339_now)" "$sequence" "$G6_C32_RUN_ID" >"$G6_C32_EVIDENCE_ROOT/qualification/lock-acquired.json"
}

collect_live_identity() {
  local public_ipv4=$1 clone_path=$2 binary_path=$3
  g6_ssh root@"$public_ipv4" \
    "cd '$clone_path' && test -z \"\$(git status --porcelain --untracked-files=all)\" && recorded_at=\$('$REMOTE_BUN' -e 'process.stdout.write(new Date().toISOString())') && os_release=\$(. /etc/os-release; printf '%s' \"\$PRETTY_NAME\" | base64 -w0) && rustc=\$(/root/.cargo/bin/rustc --version | base64 -w0) && cargo=\$(/root/.cargo/bin/cargo --version | base64 -w0) && printf 'recordedAt=%s\\nbootId=%s\\nhead=%s\\ntree=%s\\nos=%s\\nosReleaseB64=%s\\nkernel=%s\\nbun=%s\\nrustcB64=%s\\ncargoB64=%s\\nbinarySha=%s\\n' \"\$recorded_at\" \"\$(cat /proc/sys/kernel/random/boot_id)\" \"\$(git rev-parse HEAD)\" \"\$(git rev-parse HEAD^{tree})\" \"\$(uname -s)\" \"\$os_release\" \"\$(uname -r)\" \"\$('$REMOTE_BUN' --version)\" \"\$rustc\" \"\$cargo\" \"\$(sha256sum '$binary_path' | awk '{print \$1}')\""
}

qualification_exact_pair() {
  local root="$G6_C32_EVIDENCE_ROOT/qualification"
  capture_operation "$root/doctl-server" doctl-server QUALIFYING \
    "$DOCTL_BIN" compute droplet get "$G6_C32_SERVER_ID" --output json
  capture_operation "$root/doctl-generator" doctl-generator QUALIFYING \
    "$DOCTL_BIN" compute droplet get "$G6_C32_GENERATOR_ID" --output json
  capture_operation "$root/server-identity" server-identity QUALIFYING \
    collect_live_identity "$G6_C32_SERVER_PUBLIC_IPV4" "$SERVER_CLONE" "$G6_C32_SERVER_BINARY_PATH"
  capture_operation "$root/generator-identity" generator-identity QUALIFYING \
    collect_live_identity "$G6_C32_GENERATOR_PUBLIC_IPV4" "$GENERATOR_CLONE" "$G6_C32_GENERATOR_BINARY_PATH"
  capture_operation "$root/exact-pair" exact-pair-validation QUALIFYING \
    "$G6_C32_OFFRUNNER_BUN" "$G6_C32_REPOSITORY_PATH/tools/load/g6-c32-freeze.ts" qualification \
    --root "$G6_C32_BOUND_ROOT" \
    --repository "$G6_C32_REPOSITORY_PATH" \
    --server-provider "$root/doctl-server.stdout" \
    --generator-provider "$root/doctl-generator.stdout" \
    --server-host "$root/server-identity.stdout" \
    --generator-host "$root/generator-identity.stdout" \
    --out "$root/exact-pair.json"
}

qualification_clock_resources() {
  local root="$G6_C32_EVIDENCE_ROOT/qualification"
  capture_operation "$root/server-resources" server-resources QUALIFYING \
    g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" \
    "date -u '+recordedAt=%Y-%m-%dT%H:%M:%S.000Z'; printf 'nofile=%s\\n' \"\$(ulimit -n)\"; df -Pk '$SERVER_CLONE'; awk '/MemAvailable/{print}' /proc/meminfo; test \"\$(ulimit -n)\" -ge 1048576; ! pgrep -fa 'g6-sharded-scan|mmo-client|iperf3'"
  capture_operation "$root/generator-resources" generator-resources QUALIFYING \
    g6_ssh root@"$G6_C32_GENERATOR_PUBLIC_IPV4" \
    "date -u '+recordedAt=%Y-%m-%dT%H:%M:%S.000Z'; printf 'nofile=%s\\n' \"\$(ulimit -n)\"; df -Pk '$GENERATOR_CLONE'; awk '/MemAvailable/{print}' /proc/meminfo; test \"\$(ulimit -n)\" -ge 1048576; ! pgrep -fa 'g6-sharded-scan|mmo-client|iperf3'"
}

qualification_private_vpc() {
  local root="$G6_C32_EVIDENCE_ROOT/qualification"
  capture_operation "$root/vpc" vpc-requery QUALIFYING \
    "$DOCTL_BIN" compute vpc get "$G6_C32_VPC_UUID" --output json
  capture_operation "$root/vpc-cidr" vpc-cidr QUALIFYING \
    "$G6_C32_OFFRUNNER_BUN" -e '
      const value=await Bun.file(process.argv[1]).json();
      const rows=Array.isArray(value)?value:[value];
      if(rows.length!==1 || rows[0]?.id!==process.argv[2] || typeof rows[0]?.ip_range!=="string") process.exit(67);
      console.log(rows[0].ip_range);
    ' "$root/vpc.stdout" "$G6_C32_VPC_UUID"
  local vpc_cidr
  vpc_cidr=$(cat "$root/vpc-cidr.stdout")
  capture_operation "$root/r-down-listener" r-down-listener QUALIFYING \
    g6_ssh root@"$G6_C32_GENERATOR_PUBLIC_IPV4" \
    "test ! -e '$G6_C32_REMOTE_ROOT/qualification/r-down.pid' && iperf3 -s -D -B '$G6_C32_GENERATOR_PRIVATE_IPV4' -p 5201 --pidfile '$G6_C32_REMOTE_ROOT/qualification/r-down.pid' --logfile '$G6_C32_REMOTE_ROOT/qualification/r-down-server.log'"
  capture_operation "$root/r-down" r-down QUALIFYING \
    g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" \
    "cd '$SERVER_CLONE' && '$REMOTE_BUN' tools/offbox/preflight.ts --peer '$G6_C32_GENERATOR_PRIVATE_IPV4' --subnet '$vpc_cidr' --payload-bytes 1150 --rates-mbit 750 --loss-bound-pct 0.1 --out '$G6_C32_REMOTE_ROOT/qualification/preflight-r-down.json'"
  capture_operation "$root/r-down-stop" r-down-stop QUALIFYING \
    g6_ssh root@"$G6_C32_GENERATOR_PUBLIC_IPV4" \
    "kill \$(cat '$G6_C32_REMOTE_ROOT/qualification/r-down.pid') && rm -f '$G6_C32_REMOTE_ROOT/qualification/r-down.pid'"
  capture_operation "$root/r-up-listener" r-up-listener QUALIFYING \
    g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" \
    "test ! -e '$G6_C32_REMOTE_ROOT/qualification/r-up.pid' && iperf3 -s -D -B '$G6_C32_SERVER_PRIVATE_IPV4' -p 5201 --pidfile '$G6_C32_REMOTE_ROOT/qualification/r-up.pid' --logfile '$G6_C32_REMOTE_ROOT/qualification/r-up-server.log'"
  capture_operation "$root/r-up" r-up QUALIFYING \
    g6_ssh root@"$G6_C32_GENERATOR_PUBLIC_IPV4" \
    "cd '$GENERATOR_CLONE' && '$REMOTE_BUN' tools/offbox/preflight.ts --peer '$G6_C32_SERVER_PRIVATE_IPV4' --subnet '$vpc_cidr' --payload-bytes 64 --rates-mbit 12 --loss-bound-pct 0.1 --out '$G6_C32_REMOTE_ROOT/qualification/preflight-r-up.json'"
  capture_operation "$root/r-up-stop" r-up-stop QUALIFYING \
    g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" \
    "kill \$(cat '$G6_C32_REMOTE_ROOT/qualification/r-up.pid') && rm -f '$G6_C32_REMOTE_ROOT/qualification/r-up.pid'"
}

qualification_isolated_sink() {
  capture_operation "$G6_C32_EVIDENCE_ROOT/qualification/isolated-sink" \
    isolated-sink QUALIFYING g6_ssh root@"$G6_C32_GENERATOR_PUBLIC_IPV4" \
    "cd '$GENERATOR_CLONE' && '$REMOTE_BUN' tools/load/g6-sink-precheck.ts --out '$G6_C32_REMOTE_ROOT/qualification/g6-sink-precheck.json' --seconds 30"
}

qualification_loaded_legs() {
  local root="$G6_C32_EVIDENCE_ROOT/qualification"
  capture_operation "$root/loaded-down-listener" loaded-down-listener QUALIFYING \
    g6_ssh root@"$G6_C32_GENERATOR_PUBLIC_IPV4" \
    "test ! -e '$G6_C32_REMOTE_ROOT/qualification/loaded-down.pid' && iperf3 -s -D -B '$G6_C32_GENERATOR_PRIVATE_IPV4' -p 5202 --pidfile '$G6_C32_REMOTE_ROOT/qualification/loaded-down.pid' --logfile '$G6_C32_REMOTE_ROOT/qualification/loaded-down-server.log'"
  capture_operation "$root/loaded-up-listener" loaded-up-listener QUALIFYING \
    g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" \
    "test ! -e '$G6_C32_REMOTE_ROOT/qualification/loaded-up.pid' && iperf3 -s -D -B '$G6_C32_SERVER_PRIVATE_IPV4' -p 5203 --pidfile '$G6_C32_REMOTE_ROOT/qualification/loaded-up.pid' --logfile '$G6_C32_REMOTE_ROOT/qualification/loaded-up-server.log'"
  set +e
  capture_operation "$root/loaded-down" loaded-down QUALIFYING \
    g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" \
    "iperf3 -c '$G6_C32_GENERATOR_PRIVATE_IPV4' -p 5202 -J -u -b 750M -l 1150 -t 20 >'$G6_C32_REMOTE_ROOT/qualification/loaded-down.json'" </dev/null &
  local down_pid=$!
  capture_operation "$root/loaded-up" loaded-up QUALIFYING \
    g6_ssh root@"$G6_C32_GENERATOR_PUBLIC_IPV4" \
    "iperf3 -c '$G6_C32_SERVER_PRIVATE_IPV4' -p 5203 -J -u -b 12M -l 64 -t 20 >'$G6_C32_REMOTE_ROOT/qualification/loaded-up.json'" </dev/null &
  local up_pid=$!
  wait "$down_pid"; local down_status=$?
  wait "$up_pid"; local up_status=$?
  set -e
  capture_operation "$root/loaded-down-stop" loaded-down-stop QUALIFYING \
    g6_ssh root@"$G6_C32_GENERATOR_PUBLIC_IPV4" \
    "kill \$(cat '$G6_C32_REMOTE_ROOT/qualification/loaded-down.pid') 2>/dev/null || true; rm -f '$G6_C32_REMOTE_ROOT/qualification/loaded-down.pid'"
  capture_operation "$root/loaded-up-stop" loaded-up-stop QUALIFYING \
    g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" \
    "kill \$(cat '$G6_C32_REMOTE_ROOT/qualification/loaded-up.pid') 2>/dev/null || true; rm -f '$G6_C32_REMOTE_ROOT/qualification/loaded-up.pid'"
  [ "$down_status" -eq 0 ]
  [ "$up_status" -eq 0 ]
}

qualification_bpf_16() {
  capture_operation "$G6_C32_EVIDENCE_ROOT/qualification/bpf-16" bpf-16 QUALIFYING \
    g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" \
    "cd '$SERVER_CLONE' && sudo env PIN_DIR=/sys/fs/bpf/quic-lb G6_BPF_READY_RECEIPT='$G6_C32_REMOTE_ROOT/qualification/g6-shard-bpf-ready.json' tools/load/g6-shard-bpf-setup.sh 16 && test -s '$G6_C32_REMOTE_ROOT/qualification/g6-shard-bpf-ready.json'"
}

qualification_rollback_25mib() {
  local root="$G6_C32_EVIDENCE_ROOT/qualification"
  SYSCTL_SNAPSHOT="$root/d-sysctls.before"
  capture_operation "$root/snapshot-before" snapshot-before QUALIFYING \
    g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" \
    "for key in net.core.rmem_max net.core.rmem_default net.ipv4.udp_rmem_min; do printf '%s ' \"\$key\"; sysctl -n \"\$key\"; done"
  capture_operation "$root/snapshot-copy" snapshot-copy QUALIFYING \
    cp "$root/snapshot-before.stdout" "$SYSCTL_SNAPSHOT"
  capture_operation "$root/rollback-proof" rollback-proof QUALIFYING \
    g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" \
    "set -euo pipefail; source_path='/tmp/g6-c32-rcvbuf-$G6_C32_RUN_ID.c'; binary_path='/tmp/g6-c32-rcvbuf-$G6_C32_RUN_ID'; trap 'rm -f \"\$source_path\" \"\$binary_path\"' EXIT; sysctl -w net.core.rmem_max=26214400 net.core.rmem_default=26214400 net.ipv4.udp_rmem_min=26214400 >/dev/null; test \"\$(sysctl -n net.core.rmem_max)\" = 26214400; test \"\$(sysctl -n net.core.rmem_default)\" = 26214400; test \"\$(sysctl -n net.ipv4.udp_rmem_min)\" = 26214400; printf '%s\\n' '#include <sys/socket.h>' '#include <netinet/in.h>' '#include <stdio.h>' 'int main(void){int fd=socket(AF_INET,SOCK_DGRAM,0),value=0;socklen_t size=sizeof(value);if(fd<0||getsockopt(fd,SOL_SOCKET,SO_RCVBUF,&value,&size)!=0)return 2;printf(\"%d\\n\",value);return value>=26214400?0:3;}' >\"\$source_path\"; clang -O2 \"\$source_path\" -o \"\$binary_path\"; \"\$binary_path\""
  local effective_bytes
  effective_bytes=$(tail -n 1 "$root/rollback-proof.stdout")
  case "$effective_bytes" in ''|*[!0-9]*) return 94 ;; esac
  [ "$effective_bytes" -ge 26214400 ]
  restore_server_settings "$root/restore-sysctls" QUALIFYING
  capture_operation "$root/snapshot-restored" snapshot-restored QUALIFYING \
    g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" \
    "for key in net.core.rmem_max net.core.rmem_default net.ipv4.udp_rmem_min; do printf '%s ' \"\$key\"; sysctl -n \"\$key\"; done"
  capture_operation "$root/snapshot-compare" snapshot-compare QUALIFYING \
    cmp "$SYSCTL_SNAPSHOT" "$root/snapshot-restored.stdout"
  capture_operation "$root/rollback-record" rollback-record QUALIFYING \
    "$G6_C32_OFFRUNNER_BUN" -e '
    import { writeFileSync } from "node:fs";
    const [path, recordedAt, effectiveText] = process.argv.slice(1);
    const value = { schema:"g6-c32-rollback/1", recordedAt, appliedBytes:26214400, effectiveSocketReceiveBytes:Number(effectiveText), restored:true, byteIdentical:true };
    writeFileSync(path, `${JSON.stringify(value,null,2)}\n`, { flag:"wx", mode:0o600 });
  ' "$root/rollback-receipt.json" "$(rfc3339_now)" "$effective_bytes"
}

copy_and_validate_qualification() {
  local root="$G6_C32_EVIDENCE_ROOT/qualification"
  mkdir -p "$root/server" "$root/generator"
  capture_operation "$root/copy-server" copy-qualification-server QUALIFYING \
    g6_scp -r root@"$G6_C32_SERVER_PUBLIC_IPV4":"$G6_C32_REMOTE_ROOT/qualification/." "$root/server/"
  capture_operation "$root/copy-generator" copy-qualification-generator QUALIFYING \
    g6_scp -r root@"$G6_C32_GENERATOR_PUBLIC_IPV4":"$G6_C32_REMOTE_ROOT/qualification/." "$root/generator/"
  capture_operation "$root/validate" validate-qualification QUALIFYING \
    "$G6_C32_OFFRUNNER_BUN" "$G6_C32_REPOSITORY_PATH/tools/load/g6-c32-freeze.ts" qualification \
    --root "$G6_C32_BOUND_ROOT" --repository "$G6_C32_REPOSITORY_PATH" \
    --qualification-root "$root" \
    --out "$root/qualification.json"
}

write_dispatch_authorization() {
  local root="$G6_C32_EVIDENCE_ROOT/qualification"
  local sequence
  sequence=$(next_operation_sequence)
  "$G6_C32_OFFRUNNER_BUN" -e '
    import { createHash } from "node:crypto";
    import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
    import { dirname, join, relative } from "node:path";
    const [root, out, runId, sequenceText, freezeSha, hostSha] = process.argv.slice(1);
    const files = [];
    const walk = (dir) => { for (const name of readdirSync(dir).sort()) { const path=join(dir,name); const stat=lstatSync(path); if (stat.isSymbolicLink()) throw new Error(`symlink evidence: ${path}`); if (stat.isDirectory()) walk(path); else if (!stat.isFile()) throw new Error(`non-file evidence: ${path}`); else if (name !== "dispatch-authorization.json" && (name.endsWith(".receipt.json") || name.endsWith(".json"))) files.push(path); } };
    walk(root);
    if (files.length === 0) throw new Error("qualification produced no structured receipts");
    const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const recordedAt = new Date().toISOString();
    const record = { schema:"g6-c32-dispatch-authorization/1", envelope:{ recordedAt, sequence:Number(sequenceText), runId, phase:"QUALIFIED", operationId:"dispatch-authorization", clockSource:"offrunner" }, status:"DISPATCHABLE", dispatchFreezeArtifactSha256:freezeSha, hostBindingAuthoritySha256:hostSha, receipts:files.sort().map((path)=>({path:relative(root,path),sha256:sha(readFileSync(path)),recordedAt})) };
    const sort=(v)=>Array.isArray(v)?v.map(sort):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map((k)=>[k,sort(v[k])])):v;
    const temporary=`${out}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(sort(record),null,2)}\n`, {flag:"wx",mode:0o600});
    const fd=openSync(temporary,"r"); fsyncSync(fd); closeSync(fd); renameSync(temporary,out);
    const directory=openSync(dirname(out),"r"); fsyncSync(directory); closeSync(directory);
  ' "$root" "$root/dispatch-authorization.json" "$G6_C32_RUN_ID" "$sequence" \
    "$G6_C32_DISPATCH_FREEZE_SHA256" "$G6_C32_HOST_BINDING_AUTHORITY_SHA256"
}

run_cell() {
  local cell=$1 sessions=$2 endpoints=$3 concurrency=$4 rate=$5 recv_bytes=$6 probe=$7 grade_mode=$8 section=$9
  local active_sessions=${10:-$sessions}
  local budget_stage=${11:-$section}
  local local_dir="$G6_C32_EVIDENCE_ROOT/$section/$cell"
  local remote_dir="$G6_C32_REMOTE_ROOT/cells/$section-$cell"
  local rated_sequence
  before_new_work
  admit_budget_cell "$cell" "$budget_stage" "$local_dir"
  rated_sequence=$(next_operation_sequence)
  printf '{"recordedAt":"%s","sequence":%s,"runId":"%s","cell":"%s"}\n' \
    "$(rfc3339_now)" "$rated_sequence" "$G6_C32_RUN_ID" "$cell" \
    >>"$G6_C32_EVIDENCE_ROOT/rated-cells.log"
  capture_operation "$local_dir/remote-mkdir" "$cell-remote-mkdir" RUNNING \
    g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" "mkdir -p '$remote_dir'"
  if [ "$recv_bytes" = 26214400 ]; then
    capture_operation "$local_dir/apply-buffer" "$cell-apply-buffer" RUNNING \
      g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" \
      'sysctl -w net.core.rmem_max=26214400 net.core.rmem_default=26214400 net.ipv4.udp_rmem_min=26214400'
  fi
  capture_operation "$local_dir/bpf-repin" "$cell-bpf-repin" RUNNING \
    g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" \
    "cd '$SERVER_CLONE' && sudo env PIN_DIR=/sys/fs/bpf/quic-lb G6_BPF_READY_RECEIPT='$remote_dir/g6-shard-bpf-ready.json' tools/load/g6-shard-bpf-setup.sh 16"
  capture_operation "$local_dir/scan" "$cell-scan" RUNNING \
    g6_ssh -A root@"$G6_C32_SERVER_PUBLIC_IPV4" env \
    "SCAN_DIAGNOSTIC=1 SCAN_SHARDS=16 SCAN_SESSIONS=$sessions SCAN_WORKLOAD_ACTIVE_SESSIONS=$active_sessions SCAN_ENDPOINTS=$endpoints SCAN_CONNECT_CONCURRENCY=$concurrency SCAN_CONNECT_RATE_PER_SEC=$rate SCAN_FIXED_SOURCE_PORT_BASE=$FIXED_SOURCE_PORT_BASE G6_BPF_READY_RECEIPT=$remote_dir/g6-shard-bpf-ready.json SCAN_LINUX_PROBE_ENABLED=$probe SCAN_LINUX_PROBE_OUT=$remote_dir/linux-probe.jsonl SCAN_POST_RUN_STEERING_OUT=$remote_dir/post-run-steering.json SCAN_OUT=$remote_dir/g6-sharded-scan.json SCAN_DIAGNOSTIC_OUT=$remote_dir/g6-sharded-diagnostic.json G6_OFFBOX_SSH=root@$G6_C32_GENERATOR_PRIVATE_IPV4 G6_OFFBOX_ENTRY_SCRIPT=$GENERATOR_CLONE/tools/offbox/linux-generator-entry-g6.sh G6_OFFBOX_CLONE=$GENERATOR_CLONE G6_CANDIDATE_SHA=$G6_C32_CANDIDATE_COMMIT G6_PREREGISTRATION_SHA256=$G6_C32_REGISTRATION_SHA256 G6_SERVER_ADDRESS=$G6_C32_SERVER_PRIVATE_IPV4 G6_EMITTER_MODE=native-mirror bash -lc \"cd '$SERVER_CLONE' && exec '$REMOTE_BUN' tools/load/g6-sharded-scan.ts\""
  capture_operation "$local_dir/copy" "$cell-copy" RUNNING \
    g6_scp -r root@"$G6_C32_SERVER_PUBLIC_IPV4":"$remote_dir/." "$local_dir/"
  capture_operation "$local_dir/evaluate" "$cell-evaluate" RUNNING \
    "$G6_C32_OFFRUNNER_BUN" "$RCA_EVALUATOR" --mode cell \
    --registration-sha256 "$G6_C32_REGISTRATION_SHA256" \
    --expect-candidate "$G6_C32_CANDIDATE_COMMIT" --cell "$cell" \
    --expected-sessions "$sessions" --expected-endpoints "$endpoints" \
    --expected-connect-concurrency "$concurrency" --expected-connect-rate "$rate" \
    --expected-fixed-source-port-base "$FIXED_SOURCE_PORT_BASE" \
    --scan "$local_dir/g6-sharded-scan.json" \
    --diagnostic "$local_dir/g6-sharded-diagnostic.json" \
    --probe "$local_dir/linux-probe.jsonl" \
    --post-run-steering "$local_dir/post-run-steering.json" \
    --grade-mode "$grade_mode" --out "$local_dir/rca.json"
  if [ "$recv_bytes" = 26214400 ]; then
    restore_server_settings "$local_dir/restore-buffer" RUNNING
  fi
  capture_operation "$local_dir/seal" "$cell-seal" RUNNING \
    bash -lc "cd '$local_dir' && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum >SHA256SUMS && sha256sum -c SHA256SUMS"
}

read_winner_field() {
  local field=$1 label=$2
  capture_operation "$label" "winner-${field//./-}" RUNNING \
    "$G6_C32_OFFRUNNER_BUN" -e '
      const value=await Bun.file(process.argv[1]).json(); let current=value;
      for (const key of process.argv[2].split(".")) current=current?.[key];
      if (current===undefined || current===null || typeof current==="object") process.exit(72);
      console.log(current);
    ' "$G6_C32_EVIDENCE_ROOT/transfer/winner.json" "$field"
  cat "$label.stdout"
}

run_winner() {
  local label=$1 root="$G6_C32_EVIDENCE_ROOT/transfer/$label"
  local endpoints concurrency rate recv_bytes grade_mode
  mkdir -p "$root"
  endpoints=$(read_winner_field profile.endpoints "$root/winner-endpoints")
  concurrency=$(read_winner_field profile.connectConcurrency "$root/winner-concurrency")
  rate=$(read_winner_field profile.connectRatePerSec "$root/winner-rate")
  recv_bytes=$(read_winner_field profile.receiveBufferBytes "$root/winner-buffer")
  grade_mode=$(read_winner_field profile.gradeMode "$root/winner-grade")
  run_cell "$label" 296 "$endpoints" "$concurrency" "$rate" "$recv_bytes" 1 "$grade_mode" transfer
}

run_probe_and_matrix() {
  # Probe sequence: P1-off P1-on P2-off P2-on.
  run_cell P1-off 296 128 500 0 0 0 historical probe
  run_cell P1-on 296 128 500 0 0 1 historical probe
  run_cell P2-off 296 128 500 0 0 0 historical probe
  run_cell P2-on 296 128 500 0 0 1 historical probe
  capture_operation "$G6_C32_EVIDENCE_ROOT/probe/decision" probe-decision RUNNING \
    "$G6_C32_OFFRUNNER_BUN" "$RCA_EVALUATOR" --mode probe-non-interference \
    --order P1-off,P1-on,P2-off,P2-on --max-connect-wall-shift-pct 5 \
    --root "$G6_C32_EVIDENCE_ROOT/probe" --out "$G6_C32_EVIDENCE_ROOT/probe/decision.json"

  # Registered matrix order: A1 B1 C1 D1 A2 B2 C2 D2 A3 B3 C3 D3 A4.
  local cell
  for cell in A1 B1 C1 D1 A2 B2 C2 D2 A3 B3 C3 D3 A4; do
    case "$cell" in
      B*) run_cell "$cell" 5000 128 50 250 0 1 historical matrix ;;
      C*) run_cell "$cell" 5000 512 500 0 0 1 rca-only matrix ;;
      D*) run_cell "$cell" 5000 128 500 0 26214400 1 historical matrix ;;
      *) run_cell "$cell" 5000 128 500 0 0 1 historical matrix ;;
    esac
  done
  capture_operation "$G6_C32_EVIDENCE_ROOT/matrix/decision" matrix-decision RUNNING \
    "$G6_C32_OFFRUNNER_BUN" "$RCA_EVALUATOR" --mode matrix \
    --registration-sha256 "$G6_C32_REGISTRATION_SHA256" \
    --root "$G6_C32_EVIDENCE_ROOT/matrix" --tie-order B,C,D \
    --out "$G6_C32_EVIDENCE_ROOT/matrix/decision.json"
  capture_operation "$G6_C32_EVIDENCE_ROOT/matrix/interaction-request" interaction-request RUNNING \
    "$G6_C32_OFFRUNNER_BUN" -e '
      const d=await Bun.file(process.argv[1]).json();
      console.log(d.runInteraction ? `${d.factorPair}` : "NONE");
    ' "$G6_C32_EVIDENCE_ROOT/matrix/decision.json"
  local pair
  pair=$(cat "$G6_C32_EVIDENCE_ROOT/matrix/interaction-request.stdout")
  if [ "$pair" != NONE ]; then
    local endpoints concurrency rate recv grade
    case "$pair" in
      B+C) endpoints=512; concurrency=50; rate=250; recv=0; grade=rca-only ;;
      B+D) endpoints=128; concurrency=50; rate=250; recv=26214400; grade=historical ;;
      C+D) endpoints=512; concurrency=500; rate=0; recv=26214400; grade=rca-only ;;
      *) return 31 ;;
    esac
    # Registered interaction order: E1 A5 E2 A6 E3 A7.
    run_cell E1 5000 "$endpoints" "$concurrency" "$rate" "$recv" 1 "$grade" matrix 5000 interaction
    run_cell A5 5000 128 500 0 0 1 historical matrix
    run_cell E2 5000 "$endpoints" "$concurrency" "$rate" "$recv" 1 "$grade" matrix 5000 interaction
    run_cell A6 5000 128 500 0 0 1 historical matrix
    run_cell E3 5000 "$endpoints" "$concurrency" "$rate" "$recv" 1 "$grade" matrix 5000 interaction
    run_cell A7 5000 128 500 0 0 1 historical matrix
    capture_operation "$G6_C32_EVIDENCE_ROOT/matrix/interaction-decision" interaction-decision RUNNING \
      "$G6_C32_OFFRUNNER_BUN" "$RCA_EVALUATOR" --mode interaction \
      --registration-sha256 "$G6_C32_REGISTRATION_SHA256" --factor-pair "$pair" \
      --root "$G6_C32_EVIDENCE_ROOT/matrix" \
      --out "$G6_C32_EVIDENCE_ROOT/matrix/interaction-decision.json"
  fi
}

TRANSFER_CONFIRMED=0
run_transfer() {
  capture_operation "$G6_C32_EVIDENCE_ROOT/transfer/select-winner" select-winner RUNNING \
    "$G6_C32_OFFRUNNER_BUN" "$RCA_EVALUATOR" --mode select-transfer \
    --registration-sha256 "$G6_C32_REGISTRATION_SHA256" \
    --root "$G6_C32_EVIDENCE_ROOT/matrix" \
    --out "$G6_C32_EVIDENCE_ROOT/transfer/winner.json"
  # Registered transfer order: A296-1 W296-1 A296-2 W296-2 A296-3 W296-3 A296-reversal.
  run_cell A296-1 296 128 500 0 0 1 historical transfer
  run_winner W296-1
  run_cell A296-2 296 128 500 0 0 1 historical transfer
  run_winner W296-2
  run_cell A296-3 296 128 500 0 0 1 historical transfer
  run_winner W296-3
  run_cell A296-reversal 296 128 500 0 0 1 historical transfer
  set +e
  capture_operation "$G6_C32_EVIDENCE_ROOT/transfer/decision" transfer-decision RUNNING \
    "$G6_C32_OFFRUNNER_BUN" "$RCA_EVALUATOR" --mode transfer \
    --registration-sha256 "$G6_C32_REGISTRATION_SHA256" \
    --root "$G6_C32_EVIDENCE_ROOT/transfer" \
    --out "$G6_C32_EVIDENCE_ROOT/transfer/decision.json"
  local transfer_status=$?
  set -e
  capture_operation "$G6_C32_EVIDENCE_ROOT/transfer/state" transfer-state RUNNING \
    "$G6_C32_OFFRUNNER_BUN" -e '
      const value=await Bun.file(process.argv[1]).json(); const status=Number(process.argv[2]);
      if(status===0 && value.terminal==="RCA_CONFIRMED" && value.transferPass===true) console.log("CONFIRMED");
      else if(status===3 && value.terminal==="RCA_UNRESOLVED" && value.transferPass===false) console.log("UNRESOLVED");
      else process.exit(85);
    ' "$G6_C32_EVIDENCE_ROOT/transfer/decision.json" "$transfer_status"
  [ "$(cat "$G6_C32_EVIDENCE_ROOT/transfer/state.stdout")" != CONFIRMED ] || TRANSFER_CONFIRMED=1
}

LADDER_CONTINUE=1
LADDER_HIGHEST_CLEAN=
LADDER_LAST_STATUS=
run_ladder_cell() {
  local label=$1 rung=$2 root="$G6_C32_EVIDENCE_ROOT/ladder/$1"
  local endpoints concurrency rate recv grade
  mkdir -p "$root"
  endpoints=$(read_winner_field profile.endpoints "$root/winner-endpoints")
  concurrency=$(read_winner_field profile.connectConcurrency "$root/winner-concurrency")
  rate=$(read_winner_field profile.connectRatePerSec "$root/winner-rate")
  recv=$(read_winner_field profile.receiveBufferBytes "$root/winner-buffer")
  grade=$(read_winner_field profile.gradeMode "$root/winner-grade")
  run_cell "$label" "$rung" "$endpoints" "$concurrency" "$rate" "$recv" 1 "$grade" ladder
  capture_operation "$root/successor-grade" "$label-successor-grade" RUNNING \
    "$G6_C32_OFFRUNNER_BUN" "$SUCCESSOR_GRADER" --rung "$rung" \
    --registration-sha256 "$G6_C32_REGISTRATION_SHA256" \
    --expect-candidate "$G6_C32_CANDIDATE_COMMIT" \
    --expected-endpoints "$endpoints" --expected-connect-concurrency "$concurrency" \
    --expected-connect-rate "$rate" --expected-fixed-source-port-base "$FIXED_SOURCE_PORT_BASE" \
    --scan "$root/g6-sharded-scan.json" --post-run-steering "$root/post-run-steering.json" \
    --out "$root/successor-grade.json"
  capture_operation "$root/successor-rung" "$label-successor-rung" RUNNING \
    "$G6_C32_OFFRUNNER_BUN" "$RCA_EVALUATOR" --mode successor-rung \
    --label "$label" --rung "$rung" --rca "$root/rca.json" \
    --grade "$root/successor-grade.json" --out "$root/decision.json"
  capture_operation "$root/status" "$label-status" RUNNING \
    "$G6_C32_OFFRUNNER_BUN" -e '
      const value=await Bun.file(process.argv[1]).json();
      if(value.schema!=="g6-c32-successor-rung/1") process.exit(73); console.log(value.status);
    ' "$root/decision.json"
  LADDER_LAST_STATUS=$(cat "$root/status.stdout")
}

run_ladder_rung() {
  local rung=$1 label="L${1}-1"
  run_ladder_cell "$label" "$rung"
  case "$LADDER_LAST_STATUS" in
    CLEAN) LADDER_HIGHEST_CLEAN=$rung ;;
    UNCLEAN) LADDER_CONTINUE=0 ;;
    *) return 75 ;;
  esac
}

run_ladder_and_companion() {
  run_ladder_rung 5000
  if [ "$LADDER_CONTINUE" = 1 ]; then run_ladder_rung 10000; fi
  if [ "$LADDER_CONTINUE" = 1 ]; then run_ladder_rung 20000; fi
  if [ "$LADDER_CONTINUE" = 1 ]; then run_ladder_rung 30000; fi
  if [ "$LADDER_CONTINUE" = 1 ]; then run_ladder_rung 40000; fi
  if [ "$LADDER_CONTINUE" = 1 ]; then run_ladder_rung 50000; fi
  [ -n "$LADDER_HIGHEST_CLEAN" ]
  local replicate="L${LADDER_HIGHEST_CLEAN}-2"
  run_ladder_cell "$replicate" "$LADDER_HIGHEST_CLEAN"
  [ "$LADDER_LAST_STATUS" = CLEAN ]
  capture_operation "$G6_C32_EVIDENCE_ROOT/ladder/evaluate" ladder-evaluate RUNNING \
    "$G6_C32_OFFRUNNER_BUN" "$RCA_EVALUATOR" --mode ladder \
    --root "$G6_C32_EVIDENCE_ROOT/ladder" --out "$G6_C32_EVIDENCE_ROOT/ladder/decision.json"
  capture_operation "$G6_C32_EVIDENCE_ROOT/ladder/companion-request" companion-request RUNNING \
    "$G6_C32_OFFRUNNER_BUN" -e '
      const value=await Bun.file(process.argv[1]).json();
      console.log(value.companionRequired===true ? `${value.firstUncleanRung} ${value.highestReplicatedCleanRung}` : "NONE");
    ' "$G6_C32_EVIDENCE_ROOT/ladder/decision.json"
  local request
  request=$(cat "$G6_C32_EVIDENCE_ROOT/ladder/companion-request.stdout")
  if [ "$request" != NONE ]; then
    local requested=${request%% *} active=${request##* } companion_label
    local endpoints concurrency rate recv grade winner_root="$G6_C32_EVIDENCE_ROOT/companion/winner"
    mkdir -p "$winner_root"
    endpoints=$(read_winner_field profile.endpoints "$winner_root/endpoints")
    concurrency=$(read_winner_field profile.connectConcurrency "$winner_root/concurrency")
    rate=$(read_winner_field profile.connectRatePerSec "$winner_root/rate")
    recv=$(read_winner_field profile.receiveBufferBytes "$winner_root/buffer")
    grade=$(read_winner_field profile.gradeMode "$winner_root/grade")
    for companion_label in C1 C2; do
      run_cell "$companion_label" "$requested" "$endpoints" "$concurrency" "$rate" "$recv" 1 "$grade" companion "$active"
      capture_operation "$G6_C32_EVIDENCE_ROOT/companion/$companion_label/summary" \
        "$companion_label-summary" RUNNING "$G6_C32_OFFRUNNER_BUN" "$RCA_EVALUATOR" \
        --mode companion-cell --label "$companion_label" \
        --expect-candidate "$G6_C32_CANDIDATE_COMMIT" \
        --expected-sessions "$requested" --expected-active-sessions "$active" \
        --scan "$G6_C32_EVIDENCE_ROOT/companion/$companion_label/g6-sharded-scan.json" \
        --diagnostic "$G6_C32_EVIDENCE_ROOT/companion/$companion_label/g6-sharded-diagnostic.json" \
        --out "$G6_C32_EVIDENCE_ROOT/companion/$companion_label/summary.json"
    done
    capture_operation "$G6_C32_EVIDENCE_ROOT/companion/decision" companion-decision RUNNING \
      "$G6_C32_OFFRUNNER_BUN" "$RCA_EVALUATOR" --mode companion \
      --root "$G6_C32_EVIDENCE_ROOT/companion" --out "$G6_C32_EVIDENCE_ROOT/companion/decision.json"
  fi
}

seal_final_evidence() {
  local seal_sequence=$1 manifest_sequence=$2
  : >"$G6_C32_EVIDENCE_ROOT/closeout/final-seal.stdout"
  : >"$G6_C32_EVIDENCE_ROOT/closeout/final-seal.stderr"
  "$G6_C32_OFFRUNNER_BUN" -e '
    import { createHash } from "node:crypto";
    import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
    import { dirname, join, relative } from "node:path";
    const [root, runId, sealSequenceText, manifestSequenceText] = process.argv.slice(1);
    const startedAt=new Date().toISOString(); const startedNs=process.hrtime.bigint();
    const sort=(value)=>Array.isArray(value)?value.map(sort):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map((key)=>[key,sort(value[key])])):value;
    const canonical=(value)=>`${JSON.stringify(sort(value),null,2)}\n`;
    const sha=(bytes)=>createHash("sha256").update(bytes).digest("hex");
    const writeDurable=(path,bytes)=>{const temporary=`${path}.tmp-${process.pid}`;const fd=openSync(temporary,"wx",0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,path);const parent=openSync(dirname(path),"r");try{fsyncSync(parent);}finally{closeSync(parent);}};
    const walk=()=>{const files=[];const visit=(dir)=>{for(const name of readdirSync(dir).sort()){const path=join(dir,name);const stat=lstatSync(path);if(stat.isSymbolicLink())throw new Error(`symlink evidence: ${path}`);if(stat.isDirectory())visit(path);else if(!stat.isFile())throw new Error(`non-file evidence: ${path}`);else files.push(relative(root,path));}};visit(root);return files.sort();};
    const finishedAt=new Date().toISOString();
    const receipt={schema:"g6-c32-operation-receipt/1",envelope:{recordedAt:finishedAt,sequence:Number(sealSequenceText),runId,phase:"FINAL",operationId:"final-seal",clockSource:"offrunner"},startedAt,finishedAt,durationMonotonicNs:String(process.hrtime.bigint()-startedNs),attempt:1,action:{command:"g6-c32-rca-controller.sh",args:["seal-final-evidence"],cwd:root,environmentKeys:[]},status:{outcome:"SUCCEEDED",exitCode:0,signal:null},stdoutPath:"closeout/final-seal.stdout",stderrPath:"closeout/final-seal.stderr",remoteTiming:null};
    writeDurable(join(root,"closeout/final-seal.receipt.json"),canonical(receipt));
    const manifestPaths=walk().filter((path)=>path!=="SHA256SUMS"&&path!=="artifact-manifest.json");
    const entries=manifestPaths.map((path)=>{const bytes=readFileSync(join(root,path));return{path,sha256:sha(bytes),bytes:bytes.byteLength,recordedAt:finishedAt};});
    const manifest={schema:"g6-c32-artifact-manifest/1",envelope:{recordedAt:finishedAt,sequence:Number(manifestSequenceText),runId,phase:"FINAL",operationId:"artifact-manifest",clockSource:"offrunner"},entries};
    writeDurable(join(root,"artifact-manifest.json"),canonical(manifest));
    const sumPaths=walk().filter((path)=>path!=="SHA256SUMS");
    writeDurable(join(root,"SHA256SUMS"),`${sumPaths.map((path)=>`${sha(readFileSync(join(root,path)))}  ${path}`).join("\n")}\n`);
    for(const line of readFileSync(join(root,"SHA256SUMS"),"utf8").trimEnd().split("\n")){const match=/^([0-9a-f]{64}) {2}(.+)$/.exec(line);if(!match||sha(readFileSync(join(root,match[2])))!==match[1])throw new Error(`manifest verification failed: ${line}`);}
    const expected=walk(); if(expected.length!==sumPaths.length+1||!expected.includes("SHA256SUMS")||sumPaths.some((path)=>!expected.includes(path)))throw new Error("fresh evidence walk differs after sealing");
  ' "$G6_C32_EVIDENCE_ROOT" "$G6_C32_RUN_ID" "$seal_sequence" "$manifest_sequence"
}

finalize_campaign() {
  capture_operation "$G6_C32_EVIDENCE_ROOT/closeout/finalize" finalize FINAL \
		"$G6_C32_OFFRUNNER_BUN" "$RCA_EVALUATOR" --mode finalize \
    --registration-sha256 "$G6_C32_REGISTRATION_SHA256" \
		--run-root "$G6_C32_EVIDENCE_ROOT" \
		--lifecycle "$BUDGET_LIFECYCLE" \
    --out "$G6_C32_EVIDENCE_ROOT/closeout/final.json" \
    --status-out "$G6_C32_EVIDENCE_ROOT/closeout/RUN_STATUS.next"
  capture_operation "$G6_C32_EVIDENCE_ROOT/closeout/dimensions" dimensions FINAL \
    "$G6_C32_OFFRUNNER_BUN" -e '
      const value=await Bun.file(process.argv[1]).json();
      if(value.lifecycle==="rca-only"&&value.transfer?.transferPass===true){
        if(value.ladder!==null||value.companion!==null)process.exit(80);
      }else if(value.transfer?.transferPass===true){
        if(value.ladder?.schema!=="g6-c32-successor-ladder/1")process.exit(80);
        if(value.ladder.companionRequired&&value.companion?.schema!=="g6-c32-session-scale/1")process.exit(83);
      }else if(value.terminal!=="RCA_UNRESOLVED"||value.ladder!==null||value.companion!==null)process.exit(80);
      if(typeof value.fullRateWorksAbove5k!=="boolean")process.exit(81);
      if(typeof value.sessionScalePass!=="boolean")process.exit(82);
    ' "$G6_C32_EVIDENCE_ROOT/closeout/final.json"
  local final_status
  final_status=$(cat "$G6_C32_EVIDENCE_ROOT/closeout/RUN_STATUS.next")
  case "$final_status" in
    RCA_CONFIRMED|RCA_INTERACTION|RCA_UNRESOLVED) ;;
    *) return 61 ;;
  esac
  trap - EXIT INT TERM HUP
  CAMPAIGN_TERMINAL=1
  printf '%s\n' "$final_status" >"$G6_C32_EVIDENCE_ROOT/RUN_STATUS"
  local cleanup_status
  cleanup_campaign
  cleanup_status=$?
  set -e
  if [ "$cleanup_status" -ne 0 ]; then
    CAMPAIGN_TERMINAL=0
    printf 'INCOMPLETE\n' >"$G6_C32_EVIDENCE_ROOT/RUN_STATUS"
    return 1
  fi
  local seal_sequence manifest_sequence
  seal_sequence=$(next_operation_sequence)
  manifest_sequence=$(next_operation_sequence)
  if ! seal_final_evidence "$seal_sequence" "$manifest_sequence"; then
    CAMPAIGN_TERMINAL=0
    printf 'INCOMPLETE\n' >"$G6_C32_EVIDENCE_ROOT/RUN_STATUS"
    return 1
  fi
}

before_new_work
acquire_continuous_lock
capture_operation "$G6_C32_EVIDENCE_ROOT/qualification/server-root" server-root QUALIFYING \
  g6_ssh root@"$G6_C32_SERVER_PUBLIC_IPV4" \
  "mkdir -p '$G6_C32_REMOTE_ROOT'/{qualification,cells} && chmod 700 '$G6_C32_REMOTE_ROOT' && printf 'INCOMPLETE\\n' >'$G6_C32_REMOTE_ROOT/RUN_STATUS'"
capture_operation "$G6_C32_EVIDENCE_ROOT/qualification/generator-root" generator-root QUALIFYING \
  g6_ssh root@"$G6_C32_GENERATOR_PUBLIC_IPV4" \
  "mkdir -p '$G6_C32_REMOTE_ROOT/qualification' && chmod 700 '$G6_C32_REMOTE_ROOT'"
apply_campaign_nofile
qualification_exact_pair
qualification_clock_resources
qualification_isolated_sink
qualification_private_vpc
qualification_loaded_legs
qualification_bpf_16
qualification_rollback_25mib
copy_and_validate_qualification

if [ "$MODE" = qualify ]; then
  printf '{"schema":"g6-c32-qualification-result/1","recordedAt":"%s","runId":"%s","status":"QUALIFIED"}\n' \
    "$(rfc3339_now)" "$G6_C32_RUN_ID" \
    >"$G6_C32_EVIDENCE_ROOT/qualification/result.json"
  exit 0
fi

write_dispatch_authorization
run_probe_and_matrix
run_transfer
finalize_campaign
