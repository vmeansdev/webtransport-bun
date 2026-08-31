#!/usr/bin/env bash
set -euo pipefail

fail() {
	printf 'g6-c32-rollback: %s\n' "$*" >&2
	exit 1
}

[[ $# -eq 1 ]] || fail "usage: $0 <evidence-directory>"
EVIDENCE_DIR=$1
[[ "$EVIDENCE_DIR" == /* ]] || fail "evidence directory must be absolute"

BUN_BIN=${G6_C32_BUN_BIN:-/opt/g6/bin/bun}
SYSCTL_BIN=${G6_C32_SYSCTL_BIN:-sysctl}
SOCKET_RESTART_BIN=${G6_C32_SOCKET_RESTART_BIN:-}
SOCKET_CHECK_BIN=${G6_C32_SOCKET_RCVBUF_CHECK_BIN:-/opt/g6/bin/g6-c32-socket-rcvbuf-check}
TARGET_BYTES=26214400
KEYS=(net.core.rmem_max net.core.rmem_default net.ipv4.udp_rmem_min)

[[ -x "$BUN_BIN" ]] || fail "Bun binary is missing or not executable: $BUN_BIN"
command -v "$SYSCTL_BIN" >/dev/null 2>&1 || fail "sysctl command is unavailable: $SYSCTL_BIN"
[[ -z "$SOCKET_RESTART_BIN" || -x "$SOCKET_RESTART_BIN" ]] || fail "socket restart command must be executable when provided"
[[ -n "$SOCKET_CHECK_BIN" && -x "$SOCKET_CHECK_BIN" ]] || fail "socket receive-buffer checker is required and must be executable"

if [[ -e "$EVIDENCE_DIR" ]]; then
	[[ -d "$EVIDENCE_DIR" ]] || fail "evidence path exists and is not a directory"
	[[ -z "$(find "$EVIDENCE_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail "evidence directory is not empty; refusing to overwrite partial evidence"
else
	mkdir -p "$EVIDENCE_DIR"
fi
OPERATIONS="$EVIDENCE_DIR/operations.jsonl"
: > "$OPERATIONS"

timestamp() {
	"$BUN_BIN" -e 'process.stdout.write(new Date().toISOString())'
}

append_operation() {
	local operation_id=$1
	local started_at=$2
	local finished_at=$3
	local exit_code=$4
	local outcome=FAILED
	if [[ "$exit_code" -eq 0 ]]; then outcome=SUCCEEDED; fi
	G6_OPERATIONS_PATH="$OPERATIONS" G6_OPERATION_ID="$operation_id" G6_STARTED_AT="$started_at" \
	G6_FINISHED_AT="$finished_at" G6_EXIT_CODE="$exit_code" G6_OUTCOME="$outcome" \
		"$BUN_BIN" -e '
			import { appendFileSync, closeSync, fsyncSync, openSync } from "node:fs";
			const record = {
				schema: "g6-c32-rollback-operation/1",
				recordedAt: process.env.G6_FINISHED_AT,
				operationId: process.env.G6_OPERATION_ID,
				startedAt: process.env.G6_STARTED_AT,
				finishedAt: process.env.G6_FINISHED_AT,
				exitCode: Number(process.env.G6_EXIT_CODE),
				outcome: process.env.G6_OUTCOME,
			};
			appendFileSync(process.env.G6_OPERATIONS_PATH, `${JSON.stringify(record)}\n`);
			const fd = openSync(process.env.G6_OPERATIONS_PATH, "r");
			try { fsyncSync(fd); } finally { closeSync(fd); }
		'
}

run_capture() {
	local operation_id=$1
	local stdout_path=$2
	local stderr_path=$3
	shift 3
	local started_at finished_at exit_code
	started_at=$(timestamp)
	set +e
	"$@" > "$stdout_path" 2> "$stderr_path"
	exit_code=$?
	set -e
	finished_at=$(timestamp)
	append_operation "$operation_id" "$started_at" "$finished_at" "$exit_code"
	return "$exit_code"
}

record_snapshot() {
	local schema=$1
	local snapshot_path=$2
	local record_path=$3
	local recorded_at
	recorded_at=$(timestamp)
	G6_SCHEMA="$schema" G6_SNAPSHOT_PATH="$snapshot_path" G6_RECORD_PATH="$record_path" G6_RECORDED_AT="$recorded_at" \
		"$BUN_BIN" -e '
			import { createHash } from "node:crypto";
			import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
			import { dirname, join } from "node:path";
			const bytes = readFileSync(process.env.G6_SNAPSHOT_PATH);
			const value = {
				schema: process.env.G6_SCHEMA,
				recordedAt: process.env.G6_RECORDED_AT,
				snapshotPath: process.env.G6_SNAPSHOT_PATH,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			};
			const target = process.env.G6_RECORD_PATH;
			const root = dirname(target);
			const staging = join(root, `.${target.split("/").at(-1)}.staged-${process.pid}`);
			const fd = openSync(staging, "wx", 0o600);
			try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
			renameSync(staging, target);
			const rootFd = openSync(root, "r");
			try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
		'
	append_operation "record-$schema" "$recorded_at" "$recorded_at" 0
}

original_values=()
captured=0
restored=0
completed=0

restore_all() {
	local failure=0
	local index key value operation_id
	for index in "${!KEYS[@]}"; do
		key=${KEYS[$index]}
		value=${original_values[$index]}
		operation_id="restore-$key"
		if ! run_capture "$operation_id" "$EVIDENCE_DIR/$operation_id.stdout" "$EVIDENCE_DIR/$operation_id.stderr" "$SYSCTL_BIN" -w "$key=$value"; then
			failure=1
		fi
	done
	if [[ -n "$SOCKET_RESTART_BIN" ]]; then
		if ! run_capture "restart-sockets-after-restore" "$EVIDENCE_DIR/restart-sockets-after-restore.stdout" "$EVIDENCE_DIR/restart-sockets-after-restore.stderr" "$SOCKET_RESTART_BIN"; then
			failure=1
		fi
	fi
	: > "$EVIDENCE_DIR/sysctl-restored.txt"
	for key in "${KEYS[@]}"; do
		operation_id="verify-restored-$key"
		if ! run_capture "$operation_id" "$EVIDENCE_DIR/$operation_id.stdout" "$EVIDENCE_DIR/$operation_id.stderr" "$SYSCTL_BIN" -n "$key"; then
			failure=1
			continue
		fi
		value=$(tr -d '[:space:]' < "$EVIDENCE_DIR/$operation_id.stdout")
		if [[ ! "$value" =~ ^[0-9]+$ ]]; then
			failure=1
			continue
		fi
		printf '%s=%s\n' "$key" "$value" >> "$EVIDENCE_DIR/sysctl-restored.txt"
	done
	record_snapshot "g6-c32-sysctl-restored/1" "$EVIDENCE_DIR/sysctl-restored.txt" "$EVIDENCE_DIR/sysctl-restored-record.json"
	local compare_started compare_finished compare_code=0
	compare_started=$(timestamp)
	cmp -s "$EVIDENCE_DIR/sysctl-before.txt" "$EVIDENCE_DIR/sysctl-restored.txt" || compare_code=$?
	compare_finished=$(timestamp)
	append_operation "byte-compare-restored-sysctls" "$compare_started" "$compare_finished" "$compare_code"
	if [[ "$compare_code" -ne 0 ]]; then failure=1; fi
	if [[ "$failure" -eq 0 ]]; then restored=1; fi
	return "$failure"
}

on_exit() {
	local original_exit=$?
	trap - EXIT
	local restore_exit=0
	if [[ "$captured" -eq 1 && "$restored" -ne 1 ]]; then
		set +e
		restore_all
		restore_exit=$?
		set -e
	fi
	if [[ "$original_exit" -eq 0 && "$restore_exit" -ne 0 ]]; then
		original_exit=$restore_exit
	fi
	if [[ "$completed" -ne 1 ]]; then
		local at
		at=$(timestamp 2>/dev/null || printf '1970-01-01T00:00:00.000Z')
		append_operation "rollback-final" "$at" "$at" "$original_exit" 2>/dev/null || true
	fi
	exit "$original_exit"
}

: > "$EVIDENCE_DIR/sysctl-before.txt"
for key in "${KEYS[@]}"; do
	operation_id="capture-$key"
	run_capture "$operation_id" "$EVIDENCE_DIR/$operation_id.stdout" "$EVIDENCE_DIR/$operation_id.stderr" "$SYSCTL_BIN" -n "$key"
	value=$(tr -d '[:space:]' < "$EVIDENCE_DIR/$operation_id.stdout")
	[[ "$value" =~ ^[0-9]+$ ]] || fail "captured nonnumeric value for $key"
	original_values+=("$value")
	printf '%s=%s\n' "$key" "$value" >> "$EVIDENCE_DIR/sysctl-before.txt"
done
record_snapshot "g6-c32-sysctl-before/1" "$EVIDENCE_DIR/sysctl-before.txt" "$EVIDENCE_DIR/sysctl-before-record.json"
captured=1
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

for key in "${KEYS[@]}"; do
	operation_id="apply-$key"
	run_capture "$operation_id" "$EVIDENCE_DIR/$operation_id.stdout" "$EVIDENCE_DIR/$operation_id.stderr" "$SYSCTL_BIN" -w "$key=$TARGET_BYTES"
done

if [[ -n "$SOCKET_RESTART_BIN" ]]; then
	run_capture "restart-sockets-after-apply" "$EVIDENCE_DIR/restart-sockets-after-apply.stdout" "$EVIDENCE_DIR/restart-sockets-after-apply.stderr" "$SOCKET_RESTART_BIN"
fi
run_capture "verify-effective-socket-rcvbuf" "$EVIDENCE_DIR/effective-socket-rcvbuf.stdout" "$EVIDENCE_DIR/effective-socket-rcvbuf.stderr" "$SOCKET_CHECK_BIN"
effective_bytes=$(tr -d '[:space:]' < "$EVIDENCE_DIR/effective-socket-rcvbuf.stdout")
[[ "$effective_bytes" =~ ^[0-9]+$ ]] || fail "effective socket receive buffer is not numeric"
(( effective_bytes >= TARGET_BYTES )) || fail "effective socket receive buffer is below $TARGET_BYTES"

if ! restore_all; then
	fail "failed to restore and byte-compare all sysctls"
fi

recorded_at=$(timestamp)
G6_EVIDENCE_DIR="$EVIDENCE_DIR" G6_RECORDED_AT="$recorded_at" G6_EFFECTIVE_BYTES="$effective_bytes" G6_TARGET_BYTES="$TARGET_BYTES" \
	"$BUN_BIN" -e '
		import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
		import { join } from "node:path";
		const receipt = {
			schema: "g6-c32-rollback/1",
			recordedAt: process.env.G6_RECORDED_AT,
			appliedBytes: Number(process.env.G6_TARGET_BYTES),
			effectiveSocketReceiveBytes: Number(process.env.G6_EFFECTIVE_BYTES),
			restored: true,
			byteIdentical: true,
		};
		const root = process.env.G6_EVIDENCE_DIR;
		const target = join(root, "rollback-receipt.json");
		const staging = join(root, `.rollback-receipt.staged-${process.pid}`);
		const fd = openSync(staging, "wx", 0o600);
		try { writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
		renameSync(staging, target);
		const rootFd = openSync(root, "r");
		try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
	'

completed=1
printf 'g6-c32-rollback: PASS evidence=%s\n' "$EVIDENCE_DIR"
