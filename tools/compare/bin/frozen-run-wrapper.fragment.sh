cleanup_signing_keys() {
  # Destroys campaign Mac/rig keys only. Never deletes the durable Mac recovery key
  # (.../$CANDIDATE/$CAMPAIGN_ID.mac-recovery.pk8); recover-rig-key / abandon owns that lifecycle.
  # On post-staging rig unreachability, ALWAYS record recover-required + disconnect requirement
  # before returning 70 so reconnect recover-rig-key has required input.
  set +e
  /usr/bin/sudo -n -u _wtcompare "$MAC_RUNTIME/comparison-supervisor" destroy-signing-key \
    --private-key="/var/db/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.mac.pk8" \
    --expected-public-key-sha256="$MAC_PUBLIC_KEY_SHA256" --missing=ok
  mac_destroy_rc=$?
  test ! -e "/var/db/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.mac.pk8"
  mac_absent_rc=$?
  ssh -i "$SSH_KEY" -o ConnectTimeout=10 "$RIG" \
    sudo -n -u _wtcompare "$RIG_STAGE/bin/comparison-supervisor" destroy-signing-key \
      --private-key="/var/lib/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.rig.pk8" \
      --expected-public-key-sha256="$RIG_PUBLIC_KEY_SHA256" --missing=ok
  rig_destroy_rc=$?
  ssh -i "$SSH_KEY" -o ConnectTimeout=10 "$RIG" \
    test ! -e "/var/lib/webtransport-bun/comparison/keys/$CANDIDATE/$CAMPAIGN_ID.rig.pk8"
  rig_absent_rc=$?
  set -e
  if [ "$rig_destroy_rc" -ne 0 ] || [ "$rig_absent_rc" -ne 0 ]; then
    # Explicit disconnect / unproven-absence path (before returning cleanup failure).
    if [ "$mac_destroy_rc" -ne 0 ]; then
      mac_cleanup_status=destroy-failed
    elif [ "$mac_absent_rc" -ne 0 ]; then
      mac_cleanup_status=destroy-failed
    else
      mac_cleanup_status=destroyed-absent
    fi
    if [ "$rig_destroy_rc" -ne 0 ] && [ "$rig_absent_rc" -ne 0 ]; then
      # SSH/unreachable typically fails both destroy and absence probes.
      rig_cleanup_status=unproven-unreachable
    elif [ "$rig_destroy_rc" -ne 0 ]; then
      rig_cleanup_status=destroy-failed
    else
      rig_cleanup_status=unproven-unreachable
    fi
    record_rig_disconnect_recovery_requirement "$mac_cleanup_status" "$rig_cleanup_status" || return 70
  fi
  if [ "$mac_destroy_rc" -ne 0 ] || [ "$mac_absent_rc" -ne 0 ] || [ "$rig_destroy_rc" -ne 0 ] || [ "$rig_absent_rc" -ne 0 ]; then
    echo "CLEANUP_FAILED mac_destroy=$mac_destroy_rc mac_absent=$mac_absent_rc rig_destroy=$rig_destroy_rc rig_absent=$rig_absent_rc" >&2
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
  "$MAC_BUN" tools/compare/bin/verify-campaign-index.ts \
    --integrity-only --allow-partial --expected-terminal="$TERMINAL_KIND" \
    --candidate "$CANDIDATE" \
    --campaign-id "$CAMPAIGN_ID" \
    --staged-capability "$MAC_TRUST/staging-root/staged-capability.json" \
    --capability-digest "$CAPABILITY_SHA256" \
    --lock-digest "$LOCK_SHA256" \
    --archive-digest "$ARCHIVE_SHA256" \
    --external-trust-bound "$EXTERNAL_TRUST_BOUND_SHA256" \
    "$OUT" \
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
# Install traps only after OUT and all digest/path literals exist in this file.
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap 'on_signal 129' HUP
trap on_exit EXIT
# Post-trap confirmation only: re-hash staged public leaves and compare to frozen literals.
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

run_measured_campaign() {
  # Args via env set by freeze-run-command: CELLS, REPS, PURPOSE, CAMPAIGN_ID,
  # CAMPAIGN_TIMEOUT_MS, EXPECTED_PASS, EXPECTED_PROMOTABLE, EXPECTED_FLATS,
  # EXPECTED_PAIRED_PROMOTIONS, RENDER_MODE (diagnostic|promoted), OUT
  CONTROLLER_RC=0
  "$MAC_BUN" tools/compare/bin/compare-controller.ts \
    --cells="$CELLS" \
    --reps="$REPS" \
    --execution-purpose="$PURPOSE" \
    --candidate="$CANDIDATE" \
    --campaign="$CAMPAIGN_ID" \
    --stage=full \
    --staged-dir="$MAC_TRUST" \
    --arm-kinds=primary \
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
  if [ "$CONTROLLER_RC" -eq 0 ]; then
    "$MAC_BUN" tools/compare/bin/verify-campaign-index.ts \
      --candidate "$CANDIDATE" \
      --campaign-id "$CAMPAIGN_ID" \
      --staged-capability "$MAC_TRUST/staging-root/staged-capability.json" \
      --capability-digest "$CAPABILITY_SHA256" \
      --lock-digest "$LOCK_SHA256" \
      --archive-digest "$ARCHIVE_SHA256" \
      --external-trust-bound "$EXTERNAL_TRUST_BOUND_SHA256" \
      --expected-pass "$EXPECTED_PASS" --expected-fail 0 --expected-refused 0 \
      --expected-promotable "$EXPECTED_PROMOTABLE" --expected-flats "$EXPECTED_FLATS" \
      --expected-paired-promotions "$EXPECTED_PAIRED_PROMOTIONS" \
      "$OUT" || SUCCESS_RC=$?
    if [ "$SUCCESS_RC" -eq 0 ]; then
      if [ "$RENDER_MODE" = promoted ]; then
        "$MAC_BUN" tools/compare/bin/render-campaign-report.ts \
          --source=sealed-index --require-promoted-pairs="$EXPECTED_PAIRED_PROMOTIONS" \
          --candidate "$CANDIDATE" --campaign-id "$CAMPAIGN_ID" \
          --staged-capability "$MAC_TRUST/staging-root/staged-capability.json" \
          --capability-digest "$CAPABILITY_SHA256" --lock-digest "$LOCK_SHA256" \
          --archive-digest "$ARCHIVE_SHA256" --external-trust-bound "$EXTERNAL_TRUST_BOUND_SHA256" \
          --output "$OUT/campaign-report.md" "$OUT" || RENDER_RC=$?
        test "$(find "$OUT" -type f -name '*.sealed.json' | wc -l | tr -d ' ')" = "$EXPECTED_PASS" || COUNT_RC=$?
        test "$(find "$OUT" -maxdepth 1 -type f -name '*.json' ! -name 'campaign-index.json' ! -name 'manifest.json' | wc -l | tr -d ' ')" = "$EXPECTED_FLATS" || COUNT_RC=$?
        test "$(rg -c '^### (WS|WT) attested arm' "$OUT/campaign-report.md")" = 12 || COUNT_RC=$?
      else
        "$MAC_BUN" tools/compare/bin/render-campaign-report.ts \
          --source=sealed-index --allow-non-promotable \
          --candidate "$CANDIDATE" --campaign-id "$CAMPAIGN_ID" \
          --staged-capability "$MAC_TRUST/staging-root/staged-capability.json" \
          --capability-digest "$CAPABILITY_SHA256" --lock-digest "$LOCK_SHA256" \
          --archive-digest "$ARCHIVE_SHA256" --external-trust-bound "$EXTERNAL_TRUST_BOUND_SHA256" \
          --output "$OUT/diagnostic-report.md" "$OUT" || RENDER_RC=$?
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
