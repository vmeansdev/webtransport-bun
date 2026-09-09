MAC_CAMPAIGN_KEY="/var/db/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.mac.pk8"
RIG_CAMPAIGN_KEY="/var/lib/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.rig.pk8"
# Both key directories are 0700 and owned by _wtcompare. The operator account on
# the Mac and the ssh account on the rig cannot traverse them, so `test ! -e
# <key>` run as either answers "absent" whether or not the key is there -- a
# constant in the shape of a proof. (Contradiction on the rig: as hermes-admin
# the probe said absent while `sudo -u _wtcompare test -e` said present.) Every
# absence probe therefore runs as the account that owns the tree and prints its
# own verdict; a probe that prints neither verdict could not see the path, and
# unproven is never absent.
KEY_ABSENCE_PROBE='if [ -e "$1" ]; then printf PRESENT; else printf ABSENT; fi'
probe_campaign_key_absence() {
  # $1 is mac|rig. Prints PRESENT, ABSENT, or nothing at all. Only stdout is
  # the verdict; sudo's and ssh's own diagnostics stay on stderr, where an
  # UNPROVEN cleanup line can be read against them. BatchMode keeps an
  # unreachable rig from waiting on a prompt inside a trap.
  case "$1" in
    mac)
      /usr/bin/sudo -n -u _wtcompare /bin/sh -c "$KEY_ABSENCE_PROBE" \
        campaign-key-absence "$MAC_CAMPAIGN_KEY"
      ;;
    rig)
      ssh -i "$SSH_KEY" -o ConnectTimeout=10 -o BatchMode=yes "$RIG" \
        "sudo -n -u _wtcompare /bin/sh -c '$KEY_ABSENCE_PROBE' campaign-key-absence '$RIG_CAMPAIGN_KEY'"
      ;;
  esac
}
absence_rc_for_verdict() {
  # 0 proved absent, 1 proved present, 2 unproven. Unproven is never absent.
  case "$1" in
    ABSENT) return 0 ;;
    PRESENT) return 1 ;;
    *) return 2 ;;
  esac
}
cleanup_signing_keys() {
  # Destroys campaign Mac/rig keys only. Never deletes the durable Mac recovery key
  # (.../$CANDIDATE/$CAMPAIGN_ID.mac-recovery.pk8); recover-rig-key / abandon owns that lifecycle.
  # On post-staging rig unreachability, ALWAYS record recover-required + disconnect requirement
  # before returning 70 so reconnect recover-rig-key has required input.
  set +e
  /usr/bin/sudo -n -u _wtcompare "$MAC_RUNTIME/comparison-supervisor" destroy-signing-key \
    --private-key="$MAC_CAMPAIGN_KEY" \
    --expected-public-key-sha256="$MAC_PUBLIC_KEY_SHA256" --missing=ok
  mac_destroy_rc=$?
  mac_absence_verdict=$(probe_campaign_key_absence mac)
  absence_rc_for_verdict "$mac_absence_verdict"
  mac_absent_rc=$?
  ssh -i "$SSH_KEY" -o ConnectTimeout=10 "$RIG" \
    sudo -n -u _wtcompare "$RIG_STAGE/bin/comparison-supervisor" destroy-signing-key \
      --private-key="$RIG_CAMPAIGN_KEY" \
      --expected-public-key-sha256="$RIG_PUBLIC_KEY_SHA256" --missing=ok
  rig_destroy_rc=$?
  rig_absence_verdict=$(probe_campaign_key_absence rig)
  absence_rc_for_verdict "$rig_absence_verdict"
  rig_absent_rc=$?
  set -e
  if [ "$rig_destroy_rc" -ne 0 ] || [ "$rig_absent_rc" -ne 0 ]; then
    # Explicit disconnect / unproven-absence path (before returning cleanup failure).
    case "$mac_absence_verdict" in
      PRESENT) mac_cleanup_status=destroy-failed ;;
      ABSENT)
        if [ "$mac_destroy_rc" -ne 0 ]; then
          mac_cleanup_status=destroy-failed
        else
          mac_cleanup_status=destroyed-absent
        fi
        ;;
      *) mac_cleanup_status=unproven-unreachable ;;
    esac
    case "$rig_absence_verdict" in
      # A key the owner can still see is not an unreachable rig; say which.
      PRESENT) rig_cleanup_status=destroy-failed ;;
      ABSENT)
        if [ "$rig_destroy_rc" -ne 0 ]; then
          rig_cleanup_status=destroy-failed
        else
          rig_cleanup_status=destroyed-absent
        fi
        ;;
      *) rig_cleanup_status=unproven-unreachable ;;
    esac
    record_rig_disconnect_recovery_requirement "$mac_cleanup_status" "$rig_cleanup_status" || return 70
  fi
  if [ "$mac_destroy_rc" -ne 0 ] || [ "$mac_absent_rc" -ne 0 ] || [ "$rig_destroy_rc" -ne 0 ] || [ "$rig_absent_rc" -ne 0 ]; then
    echo "CLEANUP_FAILED mac_destroy=$mac_destroy_rc mac_absence=${mac_absence_verdict:-UNPROVEN} rig_destroy=$rig_destroy_rc rig_absence=${rig_absence_verdict:-UNPROVEN}" >&2
    return 70
  fi
  return 0
}
record_rig_disconnect_recovery_requirement() {
  # Args: macCleanupStatus rigCleanupStatus. Durable requirement + Mac-intended recover-required.
  # Deferred-only: NEVER remote-tee/write $leasePath.status.json here (no partial authoritative
  # bytes). Mac retains exact intended status bytes; recover-rig-key installs/transitions via
  # durable_lease_status_transition with terminal guards + remote readback.
  mac_cleanup_status="$1"
  rig_cleanup_status="$2"
  mkdir -p "$MAC_TRUST/recovery" || return 1
  export REPO CANDIDATE CAMPAIGN_ID MAC_TRUST RIG_PUBLIC_KEY_SHA256 \
    mac_cleanup_status rig_cleanup_status
  STAGE_RECEIPT="$MAC_TRUST/stage-receipt.json"
  export STAGE_RECEIPT
  "$MAC_BUN" -e "$(cat <<'BUN'
const { parseStrictJsonBytes } = await import(`${process.env.REPO}/tools/compare/secure-fs.ts`);
const { canonicalJson } = await import(`${process.env.REPO}/tools/compare/canonical.ts`);
const fs = await import("node:fs");
const path = await import("node:path");
const crypto = await import("node:crypto");
const macTrust = process.env.MAC_TRUST;
const recoveryDir = path.join(macTrust, "recovery");
const reqPath = path.join(recoveryDir, "rig-disconnect-requirement.json");
const intendedStatusPath = path.join(recoveryDir, "rig-signing-key-lease.status.intended.json");
const stickyPath = path.join(recoveryDir, "disconnect-requirement-sticky.json");
const stagePath = process.env.STAGE_RECEIPT;
// Authoritative path is documented for recover-rig-key only (deferred-only here):
// `/var/lib/webtransport-bun/comparison/leases/${CANDIDATE}/${CAMPAIGN_ID}.lease.json.status.json`


const fsyncParent = (finalPath) => {
  const dirFd = fs.openSync(path.dirname(finalPath), "r");
  fs.fsyncSync(dirFd); fs.closeSync(dirFd);
};
const writeExcl = (finalPath, bytes) => {
  const expected = Buffer.from(bytes);
  if (fs.existsSync(finalPath)) {
    const existing = fs.readFileSync(finalPath);
    if (Buffer.compare(existing, expected) !== 0) process.exit(3);
    // Reuse must still prove durable directory completion after a crash window.
    fsyncParent(finalPath);
    return;
  }
  const orphans = fs.readdirSync(path.dirname(finalPath))
    .filter((name) => name.startsWith(path.basename(finalPath) + ".tmp."))
    .map((name) => path.join(path.dirname(finalPath), name));
  for (const orphan of orphans) {
    const ob = fs.readFileSync(orphan);
    if (Buffer.compare(ob, expected) === 0) {
      // Orphan bytes are durable before link so a crash after link still has fsynced content.
      const orphanFd = fs.openSync(orphan, "r");
      fs.fsyncSync(orphanFd); fs.closeSync(orphanFd);
      try { fs.linkSync(orphan, finalPath); } catch (e) {
        if (!(e && e.code === "EEXIST")) throw e;
        const existing = fs.readFileSync(finalPath);
        if (Buffer.compare(existing, expected) !== 0) process.exit(3);
      }
      for (const o of orphans) { try { fs.unlinkSync(o); } catch {} }
      fsyncParent(finalPath);
      return;
    }
  }
  for (const orphan of orphans) { try { fs.unlinkSync(orphan); } catch {} }
  const tmp = `${finalPath}.tmp.${crypto.randomBytes(8).toString("hex")}`;
  const fd = fs.openSync(tmp, "wx");
  fs.writeFileSync(fd, expected);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  try {
    fs.linkSync(tmp, finalPath);
  } catch (e) {
    if (e && e.code === "EEXIST") {
      const existing = fs.readFileSync(finalPath);
      if (Buffer.compare(existing, expected) !== 0) process.exit(3);
    } else {
      throw e;
    }
  }
  try { fs.unlinkSync(tmp); } catch {}
  fsyncParent(finalPath);
};

let stageReceiptSha256 = null;
let leaseSnapshotSha256 = null;
let phase = "pre-stage-receipt";
if (fs.existsSync(stagePath)) {
  const bytes = new Uint8Array(fs.readFileSync(stagePath));
  const parsed = parseStrictJsonBytes(bytes);
  if (!parsed.ok) process.exit(2);
  const text = new TextDecoder().decode(bytes);
  if (canonicalJson(parsed.value) + "\n" !== text) process.exit(2);
  stageReceiptSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  phase = "post-stage-receipt";
  const snap = parsed.value.rigSigningKeyLeaseSha256;
  if (typeof snap !== "string" || !/^[0-9a-f]{64}$/.test(snap)) process.exit(2);
  leaseSnapshotSha256 = snap;
} else {
  // Pre-receipt: null unless an armed snapshot file already exists locally.
  const armed = path.join(macTrust, "staging-root", "rig-signing-key-lease.armed.json");
  if (fs.existsSync(armed)) {
    leaseSnapshotSha256 = crypto.createHash("sha256").update(fs.readFileSync(armed)).digest("hex");
  }
}

let sticky;
if (fs.existsSync(stickyPath)) {
  sticky = JSON.parse(fs.readFileSync(stickyPath, "utf8"));
  if (!Number.isSafeInteger(sticky.recordedAtMs) || sticky.recordedAtMs < 0) process.exit(2);
} else {
  const recordedAtMs = Date.now();
  if (!Number.isSafeInteger(recordedAtMs) || recordedAtMs < 0) process.exit(2);
  sticky = { recordedAtMs, lastTransitionAtMs: recordedAtMs };
  writeExcl(stickyPath, canonicalJson(sticky) + "\n");
}

const req = {
  schema: "rig-disconnect-recovery-requirement/v1",
  candidate: process.env.CANDIDATE,
  campaignId: process.env.CAMPAIGN_ID,
  phase,
  stageReceiptSha256,
  rigPublicKeySha256: process.env.RIG_PUBLIC_KEY_SHA256,
  leaseSnapshotSha256,
  macCleanupStatus: process.env.mac_cleanup_status,
  rigCleanupStatus: process.env.rig_cleanup_status,
  recordedAtMs: sticky.recordedAtMs,
  requiredAction: "recover-rig-key",
  recoveryRequirementPath: `.trust-staging/${process.env.CANDIDATE}/${process.env.CAMPAIGN_ID}/recovery/rig-disconnect-requirement.json`,
};
const status = {
  schema: "rig-signing-key-lease-status/v1",
  leaseSnapshotSha256,
  state: "recover-required",
  lastTransitionAtMs: sticky.lastTransitionAtMs,
  lastTransitionReason: "controller-cleanup",
};
const reqBytes = canonicalJson(req) + "\n";
const statusBytes = canonicalJson(status) + "\n";
// Deferred-only authoritative status: Mac intended bytes + requirement only (restart-safe).
// recover-rig-key performs durable_lease_status_transition on $leasePath.status.json.
writeExcl(intendedStatusPath, statusBytes);
writeExcl(reqPath, reqBytes);
process.stderr.write("LEASE_STATUS_AUTHORITATIVE_WRITE_DEFERRED_TO_RECOVER\n");
BUN
)" || return 1
}
TERMINAL_KIND=FAIL
CONTROLLER_PID=""
INTEGRITY_DONE=0
ORIGINAL_RC=0
write_wrapper_terminal_substitute() {
  # Exact ControllerTerminalV1 bytes via heredoc; atomic write.
  # CONTROLLER_RC must already be the final nonzero code before this runs (never embed exit 0).
  # TERMINAL_KIND must already be FAIL or INTERRUPTED; substitute kind MUST match integrity terminal kind.
  case "$TERMINAL_KIND" in FAIL|INTERRUPTED) ;; *) return 1 ;; esac
  tmp="$OUT/controller-terminal.wrapper-substitute.json.tmp"
  export REPO CANDIDATE CAMPAIGN_ID EXECUTION_PURPOSE CONTROLLER_RC ORIGINAL_RC TERMINAL_KIND
  "$MAC_BUN" -e "$(cat <<'BUN'
const { canonicalJson } = await import(`${process.env.REPO}/tools/compare/canonical.ts`);
const rc = Number(process.env.CONTROLLER_RC);
if (!Number.isSafeInteger(rc) || rc === 0) process.exit(2);
const kind = process.env.TERMINAL_KIND;
if (kind !== "FAIL" && kind !== "INTERRUPTED") process.exit(2);
const writtenAtMs = Date.now();
if (!Number.isSafeInteger(writtenAtMs) || writtenAtMs < 0) process.exit(2);
const rec = {
  schema: "controller-terminal/v1",
  candidate: process.env.CANDIDATE,
  campaignId: process.env.CAMPAIGN_ID,
  executionPurpose: process.env.EXECUTION_PURPOSE,
  terminalKind: kind,
  campaignStatus: "FAIL",
  refusalCode: null,
  failureCode: "CHILD_LIFECYCLE",
  controllerExitCode: rc,
  trafficStarted: false,
  writtenAtMs,
};
await Bun.write(process.argv[1], canonicalJson(rec) + "\n");
BUN
)" "$tmp" || return 1
  mv -f "$tmp" "$OUT/controller-terminal.wrapper-substitute.json"
}
parse_controller_terminal_record() {
  # Shared full guarded parser for signal + measured paths. Prints terminalKind on success.
  # Enforces exact key set, schema, candidate/campaign/purpose, trafficStarted, closed enums,
  # safe-integer controllerExitCode/writtenAtMs, and kind correlations.
  export REPO CANDIDATE CAMPAIGN_ID CONTROLLER_RC EXECUTION_PURPOSE
  "$MAC_BUN" -e "$(cat <<'BUN'
const { parseStrictJsonBytes } = await import(`${process.env.REPO}/tools/compare/secure-fs.ts`);
const { canonicalJson } = await import(`${process.env.REPO}/tools/compare/canonical.ts`);
const REFUSALS = ["HOST_FD_PREFLIGHT","RIG_UNREACHABLE","STALE_OR_INVALID_STAGING"];
const FAILURES = [
  "APPROVAL_IDENTITY_MISMATCH","CHILD_LIFECYCLE","COHORT_NOT_READY","COHORT_PROTOCOL",
  "CROSS_SUPERVISOR_MISMATCH","MAC_GRANT_EXPIRED","MAC_GRANT_REPLAYED","MAC_GRANT_SIGNATURE_INVALID",
  "MAC_SIGNING_KEY_MISMATCH","MEASUREMENT_WINDOW","RELAY_DELIVERY","RIG_RECEIPT_EXPIRED",
  "RIG_RECEIPT_REPLAYED","RIG_RECEIPT_SIGNATURE_INVALID","RIG_SIGNING_KEY_MISMATCH",
  "RUNTIME_RESOURCE_EXHAUSTION","TRUST_PROTOCOL","WARMUP_PROTOCOL",
];
const bytes = new Uint8Array(await Bun.file(process.argv[1]).arrayBuffer());
const parsed = parseStrictJsonBytes(bytes);
if (!parsed.ok) process.exit(3);
const text = new TextDecoder().decode(bytes);
if (canonicalJson(parsed.value) + "\n" !== text) process.exit(3);
const fs = parsed.value;
if (fs === null || typeof fs !== "object" || Array.isArray(fs)) process.exit(3);
const keys = Object.keys(fs).sort();
const need = ["campaignId","campaignStatus","candidate","controllerExitCode","executionPurpose","failureCode","refusalCode","schema","terminalKind","trafficStarted","writtenAtMs"];
if (JSON.stringify(keys) !== JSON.stringify(need)) process.exit(3);
if (fs.schema !== "controller-terminal/v1") process.exit(3);
if (typeof fs.candidate !== "string" || typeof fs.campaignId !== "string") process.exit(3);
if (fs.candidate !== process.env.CANDIDATE || fs.campaignId !== process.env.CAMPAIGN_ID) process.exit(4);
if (fs.executionPurpose !== process.env.EXECUTION_PURPOSE) process.exit(4);
if (!["PASS","FAIL","REFUSED"].includes(fs.campaignStatus)) process.exit(3);
if (typeof fs.controllerExitCode !== "number" || !Number.isSafeInteger(fs.controllerExitCode)) process.exit(3);
if (typeof fs.trafficStarted !== "boolean") process.exit(3);
if (typeof fs.writtenAtMs !== "number" || !Number.isSafeInteger(fs.writtenAtMs) || fs.writtenAtMs < 0) process.exit(3);
if (fs.refusalCode != null && !REFUSALS.includes(fs.refusalCode)) process.exit(3);
if (fs.failureCode != null && !FAILURES.includes(fs.failureCode)) process.exit(3);
const kind = fs.terminalKind;
if (!["PASS","FAIL","REFUSED","INTERRUPTED"].includes(kind)) process.exit(3);
const rc = Number(process.env.CONTROLLER_RC);
if (!Number.isSafeInteger(rc)) process.exit(3);
if (fs.controllerExitCode !== rc) process.exit(5);
if (kind === "PASS") {
  if (rc !== 0 || fs.campaignStatus !== "PASS" || fs.refusalCode != null || fs.failureCode != null || fs.trafficStarted !== true) process.exit(5);
} else if (kind === "REFUSED") {
  if (rc === 0 || fs.trafficStarted !== false || fs.refusalCode == null || fs.failureCode != null || fs.campaignStatus !== "REFUSED") process.exit(5);
} else if (kind === "FAIL") {
  if (rc === 0 || fs.failureCode == null || fs.refusalCode != null || fs.campaignStatus !== "FAIL") process.exit(5);
} else if (kind === "INTERRUPTED") {
  if (rc === 0 || fs.campaignStatus !== "FAIL" || fs.refusalCode != null || fs.failureCode !== "CHILD_LIFECYCLE" || typeof fs.trafficStarted !== "boolean") process.exit(5);
} else {
  process.exit(3);
}
process.stdout.write(kind);
BUN
)" "$1"
}
finalize_terminal_integrity() {
  if [ "$INTEGRITY_DONE" -eq 1 ]; then
    return 0
  fi
  if [ "${ORIGINAL_RC:-0}" -eq 0 ] && [ "$TERMINAL_KIND" != INTERRUPTED ]; then
    return 0
  fi
  if [ "$TERMINAL_KIND" = PASS ]; then
    TERMINAL_KIND=FAIL
  fi
  case "$TERMINAL_KIND" in FAIL|REFUSED|INTERRUPTED) ;; *) TERMINAL_KIND=FAIL ;; esac
  mkdir -p "$OUT/integrity-only" || return 1
  # This-attempt directory only. Never accept stale immutable stdout/stderr left under integrity-only/.
  ATTEMPT_ID="$$-$(date +%s)-$RANDOM"
  ATTEMPT_DIR="$OUT/integrity-only/attempt-$ATTEMPT_ID"
  mkdir -m 700 "$ATTEMPT_DIR" || return 1
  # Prove attempt dir is empty/fresh (no pre-existing evidence files).
  for f in stdout.txt stderr.txt terminal-kind.txt exit-status.txt attempt-marker.txt; do
    if [ -e "$ATTEMPT_DIR/$f" ]; then
      echo "INTEGRITY_STALE_ATTEMPT_FILE $ATTEMPT_DIR/$f" >&2
      return 1
    fi
  done
  # Drop superseded top-level redirects if present; failure to clear is fail-closed (no || true).
  for f in stdout.txt stderr.txt terminal-kind.txt exit-status.txt attempt-marker.txt current-attempt.txt; do
    if [ -e "$OUT/integrity-only/$f" ]; then
      rm -f "$OUT/integrity-only/$f" || return 1
      if [ -e "$OUT/integrity-only/$f" ]; then
        echo "INTEGRITY_STALE_IMMUTABLE $OUT/integrity-only/$f" >&2
        return 1
      fi
    fi
  done
  : >"$ATTEMPT_DIR/stdout.txt" || return 1
  : >"$ATTEMPT_DIR/stderr.txt" || return 1
  test ! -s "$ATTEMPT_DIR/stdout.txt" || return 1
  test ! -s "$ATTEMPT_DIR/stderr.txt" || return 1
  INTEGRITY_RC=0
  set +e
  # Implemented CLI (equals-form). Plan §9.5 still shows legacy space-form flags;
  # see deviations/2026-08-31-a5-verify-campaign-index-argv.md.
  # --integrity-only: this attempt proves bytes, reports zero promotable, and
  # cannot move a campaign's status or complete a canonical claim (§6/§11).
  "$MAC_BUN" "$REPO/tools/compare/bin/verify-campaign-index.ts" \
    --campaign-root="$OUT" \
    --index="$OUT/campaign-index.json" \
    --external-trust-bound-sha256="$EXTERNAL_TRUST_BOUND_SHA256" \
    --integrity-only \
    >"$ATTEMPT_DIR/stdout.txt" 2>"$ATTEMPT_DIR/stderr.txt"
  INTEGRITY_RC=$?
  redirect_ok=1
  test -f "$ATTEMPT_DIR/stdout.txt" && test -f "$ATTEMPT_DIR/stderr.txt" || redirect_ok=0
  printf '%s\n' "$TERMINAL_KIND" >"$ATTEMPT_DIR/terminal-kind.txt"
  kind_write_rc=$?
  printf '%s\n' "$INTEGRITY_RC" >"$ATTEMPT_DIR/exit-status.txt"
  status_write_rc=$?
  printf '%s\n' "integrity-attempt:${TERMINAL_KIND}:${INTEGRITY_RC}:${ATTEMPT_ID}" >"$ATTEMPT_DIR/attempt-marker.txt"
  marker_write_rc=$?
  printf '%s\n' "$ATTEMPT_ID" >"$OUT/integrity-only/current-attempt.txt"
  pointer_write_rc=$?
  set -e
  # INTEGRITY_DONE=1 only after this attempt's mkdir + truncates + every evidence write + pointer succeeded.
  if [ "$redirect_ok" -ne 1 ] || [ "$kind_write_rc" -ne 0 ] || [ "$status_write_rc" -ne 0 ] || [ "$marker_write_rc" -ne 0 ] \
    || [ "$pointer_write_rc" -ne 0 ] \
    || [ ! -f "$ATTEMPT_DIR/terminal-kind.txt" ] || [ ! -f "$ATTEMPT_DIR/exit-status.txt" ] \
    || [ ! -f "$ATTEMPT_DIR/attempt-marker.txt" ] || [ ! -f "$OUT/integrity-only/current-attempt.txt" ]; then
    echo "INTEGRITY_EVIDENCE_WRITE_FAILED" >&2
    return 1
  fi
  # Publish stable names only from this-attempt files (never reuse prior attempt content).
  cp -f "$ATTEMPT_DIR/stdout.txt" "$OUT/integrity-only/stdout.txt" || return 1
  cp -f "$ATTEMPT_DIR/stderr.txt" "$OUT/integrity-only/stderr.txt" || return 1
  cp -f "$ATTEMPT_DIR/terminal-kind.txt" "$OUT/integrity-only/terminal-kind.txt" || return 1
  cp -f "$ATTEMPT_DIR/exit-status.txt" "$OUT/integrity-only/exit-status.txt" || return 1
  cp -f "$ATTEMPT_DIR/attempt-marker.txt" "$OUT/integrity-only/attempt-marker.txt" || return 1
  INTEGRITY_DONE=1
  if [ "$INTEGRITY_RC" -ne 0 ]; then
    echo "INTEGRITY_ONLY_FAILED status=$INTEGRITY_RC terminal=$TERMINAL_KIND" >&2
  fi
  return 0
}
on_signal() {
  sig="$1"
  TERMINAL_KIND=INTERRUPTED
  ORIGINAL_RC=$sig
  CONTROLLER_RC=$sig
  if [ -n "${CONTROLLER_PID}" ] && kill -0 "$CONTROLLER_PID" 2>/dev/null; then
    kill -TERM "$CONTROLLER_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$CONTROLLER_PID" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "$CONTROLLER_PID" 2>/dev/null || true
    wait "$CONTROLLER_PID" 2>/dev/null || CONTROLLER_RC=$?
    CONTROLLER_PID=""
  fi
  # Signal path must obey nonzero-before-substitute; never leave CONTROLLER_RC at 0.
  if [ "${CONTROLLER_RC:-0}" -eq 0 ]; then CONTROLLER_RC=$sig; fi
  export REPO CANDIDATE CAMPAIGN_ID EXECUTION_PURPOSE CONTROLLER_RC ORIGINAL_RC TERMINAL_KIND
  if [ -f "$OUT/controller-terminal.json" ]; then
    set +e
    PARSED_KIND=$(parse_controller_terminal_record "$OUT/controller-terminal.json")
    TERMINAL_PARSE_RC=$?
    set -e
    if [ "$TERMINAL_PARSE_RC" -ne 0 ] || [ "$PARSED_KIND" != INTERRUPTED ]; then
      # Substitute MUST remain INTERRUPTED (integrity terminal kind); never FAIL while TERMINAL_KIND=INTERRUPTED.
      TERMINAL_KIND=INTERRUPTED
      if ! write_wrapper_terminal_substitute; then
        echo "SIGNAL_TERMINAL_SUBSTITUTE_FAILED" >&2
        exit "$sig"
      fi
    else
      TERMINAL_KIND=$PARSED_KIND
    fi
  else
    TERMINAL_KIND=INTERRUPTED
    if ! write_wrapper_terminal_substitute; then
      echo "SIGNAL_TERMINAL_SUBSTITUTE_FAILED" >&2
      exit "$sig"
    fi
  fi
  finalize_terminal_integrity
  exit "$sig"
}
on_exit() {
  rc=$?
  trap - EXIT INT TERM HUP
  set +e
  if [ "$ORIGINAL_RC" -eq 0 ] && [ "$rc" -ne 0 ]; then
    ORIGINAL_RC=$rc
  fi
  if [ "$rc" -ne 0 ] || [ "$TERMINAL_KIND" = INTERRUPTED ] || [ "$ORIGINAL_RC" -ne 0 ]; then
    finalize_terminal_integrity
  fi
  cleanup_signing_keys
  cleanup_rc=$?
  set -e
  if [ "$cleanup_rc" -ne 0 ]; then
    rc=70
  fi
  exit "$rc"
}
# Admission gates run BEFORE the traps are armed. Every check here is read-only,
# and a refusal here is administrative (leaf drift, expired stage, missing or
# mismatched approval), not the end of a campaign. Once the EXIT trap is armed,
# every exit destroys both campaign private keys; a refusal that fired it cost a
# whole stage on 2026-09-08 (run launched before exact-stage-approval.json
# existed). Refusing here leaves the staged keys intact so the operator can
# obtain the approval and launch the same frozen bytes again.
test "$(shasum -a 256 "$MAC_TRUST/staging-root/mac-supervisor-ed25519.pub" | awk '{print $1}')" = "$MAC_PUBLIC_KEY_SHA256"
test "$(shasum -a 256 "$MAC_TRUST/staging-root/rig-supervisor-ed25519.pub" | awk '{print $1}')" = "$RIG_PUBLIC_KEY_SHA256"
NOW_MS=$(( $(date +%s) * 1000 ))
REQUIRED_REMAINING_MS=$(( RUN_TIMEOUT_MS + 5400000 ))
test "$(( STAGE_NOT_AFTER_MS - NOW_MS ))" -gt "$REQUIRED_REMAINING_MS"
# Sole verify-stage-approval invocation (exact argv).
"$MAC_BUN" "$REPO/tools/compare/bin/stage-live-campaign.ts" verify-stage-approval \
  --stage-receipt="$MAC_TRUST/stage-receipt.json" \
  --upcoming-run-command="$MAC_TRUST/upcoming-run-command.sh" \
  --exact-stage-approval="$MAC_TRUST/exact-stage-approval.json"
# Install traps only after OUT and all digest/path literals exist in this file
# and the admission gates above have passed. From here on, every exit path
# destroys both campaign private keys.
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap 'on_signal 129' HUP
trap on_exit EXIT

# The topology every section registers. `ARM_KINDS` is what the controller is
# told to run and what the verifier is told to prove -- one declaration, two
# readers -- and `ARMS` is the wire pair the controller schedules for every
# cell. Neither is a second source of truth for what the run does: the verifier
# refuses an index whose entries are not exactly this shape.
ARMS=ws,wt
ARM_KINDS=primary
run_measured_campaign() {
  # Args via env set by freeze-run-command: CELLS, REPS, PURPOSE, CAMPAIGN_ID,
  # CAMPAIGN_TIMEOUT_MS, EXPECTED_PASS, EXPECTED_PROMOTABLE, EXPECTED_FLATS,
  # EXPECTED_PAIRED_PROMOTIONS, EXPECTED_SEALED,
  # EXPECT_CANONICAL_FANOUT_COMPLETE (0|1), RENDER_MODE (diagnostic|promoted), OUT
  CONTROLLER_RC=0
  "$MAC_BUN" tools/compare/bin/compare-controller.ts \
    --cells="$CELLS" \
    --reps="$REPS" \
    --execution-purpose="$PURPOSE" \
    --candidate="$CANDIDATE" \
    --campaign="$CAMPAIGN_ID" \
    --stage=full \
    --staged-dir="$MAC_TRUST" \
    --arm-kinds="$ARM_KINDS" \
    --campaign-timeout-ms="$CAMPAIGN_TIMEOUT_MS" \
    --write-terminal-record="$OUT/controller-terminal.json" &
  CONTROLLER_PID=$!
  wait "$CONTROLLER_PID" || CONTROLLER_RC=$?
  CONTROLLER_PID=""
  TERMINAL_PARSE_RC=0
  export CANDIDATE CAMPAIGN_ID CONTROLLER_RC EXECUTION_PURPOSE ORIGINAL_RC TERMINAL_KIND
  if [ -f "$OUT/controller-terminal.json" ]; then
    set +e
    PARSED_KIND=$(parse_controller_terminal_record "$OUT/controller-terminal.json")
    TERMINAL_PARSE_RC=$?
    set -e
    if [ "$TERMINAL_PARSE_RC" -eq 0 ]; then
      TERMINAL_KIND=$PARSED_KIND
    else
      TERMINAL_KIND=FAIL
      if [ "$CONTROLLER_RC" -eq 0 ]; then CONTROLLER_RC=68; fi
      export CONTROLLER_RC TERMINAL_KIND
      write_wrapper_terminal_substitute
    fi
  elif [ "$CONTROLLER_RC" -eq 0 ]; then
    # Missing record after claimed success is terminal failure.
    TERMINAL_KIND=FAIL
    CONTROLLER_RC=68
    export CONTROLLER_RC TERMINAL_KIND
    write_wrapper_terminal_substitute
  elif [ "$TERMINAL_KIND" != INTERRUPTED ]; then
    TERMINAL_KIND=FAIL
    if [ "$CONTROLLER_RC" -eq 0 ]; then CONTROLLER_RC=68; fi
    export CONTROLLER_RC TERMINAL_KIND
    write_wrapper_terminal_substitute
  fi
  SUCCESS_RC=0
  RENDER_RC=0
  COUNT_RC=0
  # Only the canonical section claims the complete observed fanout topology; the
  # section fragment says which, so the flag is never a wrapper-level constant.
  CANONICAL_FANOUT_FLAG=
  if [ "$EXPECT_CANONICAL_FANOUT_COMPLETE" = 1 ]; then
    CANONICAL_FANOUT_FLAG=--expect-canonical-fanout-complete
  fi
  if [ "$CONTROLLER_RC" -eq 0 ]; then
    # Implemented CLI (equals-form). Plan §9.5 still shows legacy space-form flags;
    # see deviations/2026-08-31-a5-verify-campaign-index-argv.md.
    # The two staged public leaves are what opens the R6 signature graph: without
    # both, the verifier parses the attestation records and verifies no signature
    # over them, which is a count check wearing a trust check's name. They are the
    # same leaves the pre-run gate above digest-checks against the stage receipt.
    # The stage receipt is what makes the external trust bound checkable: the
    # verifier recomputes the bound from the index's anchors, these two leaves and
    # the receipt's remaining digests, and a promotable seal is accepted only when
    # the recomputation equals the digest frozen above.
    "$MAC_BUN" "$REPO/tools/compare/bin/verify-campaign-index.ts" \
      --campaign-root="$OUT" \
      --index="$OUT/campaign-index.json" \
      --external-trust-bound-sha256="$EXTERNAL_TRUST_BOUND_SHA256" \
      --mac-public-key="$MAC_TRUST/staging-root/mac-supervisor-ed25519.pub" \
      --rig-public-key="$MAC_TRUST/staging-root/rig-supervisor-ed25519.pub" \
      --stage-receipt="$MAC_TRUST/stage-receipt.json" \
      --expected-pass-count="$EXPECTED_PASS" \
      --expected-fail-count=0 \
      --expected-refused-count=0 \
      --expected-promotable-count="$EXPECTED_PROMOTABLE" \
      --expected-flat-count="$EXPECTED_FLATS" \
      --expected-pair-count="$EXPECTED_PAIRED_PROMOTIONS" \
      --expected-sealed-count="$EXPECTED_SEALED" \
      --expect-cells="$CELLS" \
      --expect-arms="$ARMS" \
      --expect-arm-kinds="$ARM_KINDS" \
      --expect-measured-repetitions="$REPS" \
      ${CANONICAL_FANOUT_FLAG:+"$CANONICAL_FANOUT_FLAG"} \
      || SUCCESS_RC=$?
    if [ "$SUCCESS_RC" -eq 0 ]; then
      if [ "$RENDER_MODE" = promoted ]; then
        # The promoted render exits 3 (RENDER_REFUSED_EXIT_CODE) when a cohort
        # cell could not be verified for want of its signing leaves, and 4
        # (RENDER_INCOMPATIBLE_EXIT_CODE) when every flat verified and a pair
        # still did not compare. Both land in RENDER_RC; the report is written
        # either way so the refusal or rejection row is readable.
        "$MAC_BUN" tools/compare/bin/render-campaign-report.ts \
          --candidate="$CANDIDATE" --campaign-id="$CAMPAIGN_ID" \
          --campaign-root="$OUT" --output="$OUT/campaign-report.md" \
          || RENDER_RC=$?
        test "$(find "$OUT" -type f -name '*.sealed.json' | wc -l | tr -d ' ')" = "$EXPECTED_PASS" || COUNT_RC=$?
        # Exclusions must be the verifier's flat filter exactly (RUN_CONTROL_FILENAMES
        # plus sealed artifacts), or the two flat counters disagree and a clean run
        # fails on the wrapper.
        test "$(find "$OUT" -maxdepth 1 -type f -name '*.json' ! -name '*.sealed.json' ! -name 'campaign-index.json' ! -name 'manifest.json' ! -name 'controller-terminal.json' | wc -l | tr -d ' ')" = "$EXPECTED_FLATS" || COUNT_RC=$?
        # The report's own rows, counted against the section's cell list rather
        # than a literal: every promoted cell heads two attested-arm sections
        # and files one **COMPATIBLE** row. The second count is the stop gate's
        # "every cell comparable" clause in the wrapper's own terms; an
        # INCOMPATIBLE or REFUSED row is a cell short.
        CELL_COUNT=$(printf '%s\n' "$CELLS" | tr ',' '\n' | grep -c .)
        test "$(rg -c '^### (WS|WT) attested arm' "$OUT/campaign-report.md")" = "$((CELL_COUNT * 2))" || COUNT_RC=$?
        test "$(rg -c '^\| `[^`]*` \| \*\*COMPATIBLE\*\* ' "$OUT/campaign-report.md")" = "$CELL_COUNT" || COUNT_RC=$?
      else
        # Focused/pilot: zero flats; render from sealed index (not promoted flats).
        "$MAC_BUN" tools/compare/bin/render-campaign-report.ts \
          --source=sealed-index --allow-non-promotable \
          --candidate="$CANDIDATE" --campaign-id="$CAMPAIGN_ID" \
          --campaign-root="$OUT" --output="$OUT/diagnostic-report.md" \
          || RENDER_RC=$?
      fi
    fi
  fi
  ORIGINAL_RC=0
  if [ "$CONTROLLER_RC" -ne 0 ]; then ORIGINAL_RC=$CONTROLLER_RC
  elif [ "$SUCCESS_RC" -ne 0 ]; then ORIGINAL_RC=$SUCCESS_RC; TERMINAL_KIND=FAIL
  elif [ "$RENDER_RC" -ne 0 ]; then ORIGINAL_RC=$RENDER_RC; TERMINAL_KIND=FAIL
  elif [ "$COUNT_RC" -ne 0 ]; then ORIGINAL_RC=$COUNT_RC; TERMINAL_KIND=FAIL
  else ORIGINAL_RC=0; TERMINAL_KIND=PASS
  fi
  if [ "$ORIGINAL_RC" -ne 0 ]; then
    if [ "$TERMINAL_KIND" = PASS ]; then TERMINAL_KIND=FAIL; fi
    finalize_terminal_integrity
  fi
  return "$ORIGINAL_RC"
}
