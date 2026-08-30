#!/usr/bin/env bash
set -euo pipefail

fail() {
	printf 'g6-c32-linux-smoke: %s\n' "$*" >&2
	exit 1
}

[[ $# -eq 2 ]] || fail "usage: $0 <server|generator> <evidence-directory>"
ROLE=$1
EVIDENCE_DIR=$2
[[ "$ROLE" == "server" || "$ROLE" == "generator" ]] || fail "role must be server or generator"
[[ "$EVIDENCE_DIR" == /* ]] || fail "evidence directory must be absolute"

MODE=${G6_C32_SMOKE_MODE:-production}
[[ "$MODE" == "production" || "$MODE" == "fixture" ]] || fail "mode must be production or fixture"
if [[ "$MODE" == "fixture" && "${G6_C32_SMOKE_ALLOW_FIXTURE:-}" != "1" ]]; then
	fail "fixture mode requires G6_C32_SMOKE_ALLOW_FIXTURE=1"
fi

BUN_BIN=${G6_C32_BUN_BIN:-/opt/g6/bin/bun}
UNAME_BIN=${G6_C32_UNAME_BIN:-uname}
TIMEOUT_BIN=${G6_C32_TIMEOUT_BIN:-timeout}
BOUNDED_PROBE=${G6_C32_BOUNDED_PROBE:-}
FIXED_PORT_PROBE=${G6_C32_FIXED_PORT_PROBE:-}
STEERING_PROBE=${G6_C32_STEERING_PROBE:-}
BPF_PROBE=${G6_C32_BPF_PROBE:-}

[[ -x "$BUN_BIN" ]] || fail "Bun binary is missing or not executable: $BUN_BIN"
command -v "$UNAME_BIN" >/dev/null 2>&1 || fail "uname command is unavailable: $UNAME_BIN"
command -v "$TIMEOUT_BIN" >/dev/null 2>&1 || fail "timeout command is unavailable: $TIMEOUT_BIN"
[[ -n "$BOUNDED_PROBE" && -x "$BOUNDED_PROBE" ]] || fail "bounded probe is required and must be executable"
if [[ "$ROLE" == "generator" ]]; then
	[[ -n "$FIXED_PORT_PROBE" && -x "$FIXED_PORT_PROBE" ]] || fail "fixed-source-port probe is required and must be executable"
else
	[[ -n "$STEERING_PROBE" && -x "$STEERING_PROBE" ]] || fail "post-run steering probe is required and must be executable"
	[[ -n "$BPF_PROBE" && -x "$BPF_PROBE" ]] || fail "BPF probe is required and must be executable"
fi

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
	G6_OPERATIONS_PATH="$OPERATIONS" G6_OPERATION_ID="$operation_id" \
	G6_STARTED_AT="$started_at" \
	G6_FINISHED_AT="$finished_at" \
	G6_EXIT_CODE="$exit_code" \
	G6_OUTCOME="$outcome" \
		"$BUN_BIN" -e '
			import { appendFileSync, closeSync, fsyncSync, openSync } from "node:fs";
			const record = {
				schema: "g6-c32-smoke-operation/1",
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

validate_evidence() {
	local kind=$1
	local path=$2
	G6_EVIDENCE_KIND="$kind" G6_EVIDENCE_PATH="$path" "$BUN_BIN" -e '
		import { readFileSync } from "node:fs";
		const kind = process.env.G6_EVIDENCE_KIND;
		const path = process.env.G6_EVIDENCE_PATH;
		const fail = (message) => { throw new Error(`g6-c32-linux-smoke: ${kind} evidence is malformed: ${message}`); };
		let value;
		try { value = JSON.parse(readFileSync(path, "utf8")); } catch (error) { fail(String(error)); }
		if (typeof value !== "object" || value === null || Array.isArray(value)) fail("expected object");
		const exact = (keys) => {
			const actual = Object.keys(value).sort();
			const expected = [...keys].sort();
			if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail("unexpected keys");
		};
		if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.recordedAt)) fail("recordedAt must have UTC milliseconds");
		if (kind === "fixed-source-port") {
			exact(["schema", "recordedAt", "base", "count", "distinct", "withinRange", "passed"]);
			if (value.schema !== "g6-fixed-source-port-smoke/1" || value.passed !== true || value.withinRange !== true) fail("failed result");
			if (!Number.isSafeInteger(value.base) || !Number.isSafeInteger(value.count) || !Number.isSafeInteger(value.distinct) || value.base < 1 || value.count < 1 || value.base + value.count - 1 > 65535 || value.distinct !== value.count) fail("invalid fixed-port range");
		} else if (kind === "bounded-probe") {
			exact(["schema", "recordedAt", "bounded", "exitCode", "passed"]);
			if (value.schema !== "g6-bounded-linux-probe/1" || value.bounded !== true || value.exitCode !== 0 || value.passed !== true) fail("probe was not a bounded success");
		} else if (kind === "steering") {
			exact(["schema", "recordedAt", "phase", "selected", "steered", "fallback"]);
			if (value.schema !== "g6-steering-smoke/1" || value.phase !== "post-run" || value.selected !== true || !Number.isSafeInteger(value.steered) || value.steered < 1 || value.fallback !== 0) fail("post-run selection was not proven");
		} else if (kind === "bpf") {
			exact(["schema", "recordedAt", "instances", "socksEntries", "fallback", "passed"]);
			if (value.schema !== "g6-bpf-smoke/1" || value.instances !== 16 || value.socksEntries !== 16 || value.fallback !== 0 || value.passed !== true) fail("16-instance zero-fallback proof failed");
		} else {
			fail("unknown evidence kind");
		}
	'
}

completed=0
on_exit() {
	local exit_code=$?
	if [[ "$completed" -ne 1 ]]; then
		local at
		at=$(timestamp 2>/dev/null || printf '1970-01-01T00:00:00.000Z')
		append_operation "linux-smoke-final" "$at" "$at" "$exit_code" 2>/dev/null || true
	fi
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

run_capture "linux-uname" "$EVIDENCE_DIR/uname.stdout" "$EVIDENCE_DIR/uname.stderr" "$UNAME_BIN" -s
[[ "$(tr -d '\r\n' < "$EVIDENCE_DIR/uname.stdout")" == "Linux" ]] || fail "uname -s did not report Linux"
checks=(linux)

if [[ "$ROLE" == "generator" ]]; then
	run_capture "fixed-source-port" "$EVIDENCE_DIR/fixed-source-port.json" "$EVIDENCE_DIR/fixed-source-port.stderr" "$TIMEOUT_BIN" 60s "$FIXED_PORT_PROBE"
	validate_evidence "fixed-source-port" "$EVIDENCE_DIR/fixed-source-port.json"
	checks+=(fixed-source-port)
fi

run_capture "bounded-probe" "$EVIDENCE_DIR/bounded-probe.json" "$EVIDENCE_DIR/bounded-probe.stderr" "$TIMEOUT_BIN" 60s "$BOUNDED_PROBE"
validate_evidence "bounded-probe" "$EVIDENCE_DIR/bounded-probe.json"
checks+=(bounded-probe)

if [[ "$ROLE" == "server" ]]; then
	# These probes are deliberately invoked only after the bounded workload has
	# exited, so a pre-arm map dump cannot masquerade as selected steering.
	run_capture "post-run-steering" "$EVIDENCE_DIR/post-run-steering.json" "$EVIDENCE_DIR/post-run-steering.stderr" "$STEERING_PROBE"
	validate_evidence "steering" "$EVIDENCE_DIR/post-run-steering.json"
	checks+=(post-run-steering)
	run_capture "bpf-16-zero-fallback" "$EVIDENCE_DIR/bpf.json" "$EVIDENCE_DIR/bpf.stderr" "$BPF_PROBE"
	validate_evidence "bpf" "$EVIDENCE_DIR/bpf.json"
	checks+=(bpf-16-zero-fallback)
	G6_BOUNDED_PATH="$EVIDENCE_DIR/bounded-probe.json" G6_STEERING_PATH="$EVIDENCE_DIR/post-run-steering.json" "$BUN_BIN" -e '
		import { readFileSync } from "node:fs";
		const bounded = JSON.parse(readFileSync(process.env.G6_BOUNDED_PATH, "utf8"));
		const steering = JSON.parse(readFileSync(process.env.G6_STEERING_PATH, "utf8"));
		if (Date.parse(steering.recordedAt) < Date.parse(bounded.recordedAt)) throw new Error("g6-c32-linux-smoke: steering evidence predates bounded run");
	'
fi

manifest_created_at=$(timestamp)
G6_EVIDENCE_DIR="$EVIDENCE_DIR" G6_MANIFEST_CREATED_AT="$manifest_created_at" "$BUN_BIN" -e '
	import { createHash } from "node:crypto";
	import { closeSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
	import { join } from "node:path";
	const root = process.env.G6_EVIDENCE_DIR;
	const files = readdirSync(root).filter((name) => name !== "SHA256SUMS" && name !== "linux-smoke-receipt.json" && statSync(join(root, name)).isFile()).sort();
	const lines = files.map((name) => `${createHash("sha256").update(readFileSync(join(root, name))).digest("hex")}  ${name}`);
	const staging = join(root, `.SHA256SUMS.staged-${process.pid}`);
	const fd = openSync(staging, "wx", 0o600);
	try { writeFileSync(fd, `${lines.join("\n")}\n`); fsyncSync(fd); } finally { closeSync(fd); }
	renameSync(staging, join(root, "SHA256SUMS"));
	const rootFd = openSync(root, "r");
	try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
'
manifest_verified_at=$(timestamp)
G6_EVIDENCE_DIR="$EVIDENCE_DIR" "$BUN_BIN" -e '
	import { createHash } from "node:crypto";
	import { readdirSync, readFileSync, statSync } from "node:fs";
	import { join } from "node:path";
	const root = process.env.G6_EVIDENCE_DIR;
	const manifest = readFileSync(join(root, "SHA256SUMS"), "utf8");
	const listed = new Map();
	for (const line of manifest.trimEnd().split("\n")) {
		const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/);
		if (!match || listed.has(match[2])) throw new Error("g6-c32-linux-smoke: malformed manifest");
		listed.set(match[2], match[1]);
	}
	const files = readdirSync(root).filter((name) => name !== "SHA256SUMS" && name !== "linux-smoke-receipt.json" && statSync(join(root, name)).isFile()).sort();
	if (files.length !== listed.size || files.some((name) => !listed.has(name))) throw new Error("g6-c32-linux-smoke: manifest file set mismatch");
	for (const name of files) {
		const actual = createHash("sha256").update(readFileSync(join(root, name))).digest("hex");
		if (actual !== listed.get(name)) throw new Error(`g6-c32-linux-smoke: manifest mismatch for ${name}`);
	}
'

recorded_at=$(timestamp)
manifest_sha256=$(G6_MANIFEST_PATH="$EVIDENCE_DIR/SHA256SUMS" "$BUN_BIN" -e '
	import { createHash } from "node:crypto";
	import { readFileSync } from "node:fs";
	process.stdout.write(createHash("sha256").update(readFileSync(process.env.G6_MANIFEST_PATH)).digest("hex"));
')
checks_json=$(printf '%s\n' "${checks[@]}" | G6_C32_BUN_BIN="$BUN_BIN" "$BUN_BIN" -e '
	const text = await Bun.stdin.text();
	process.stdout.write(JSON.stringify(text.trimEnd().split("\n")));
')
G6_EVIDENCE_DIR="$EVIDENCE_DIR" G6_ROLE="$ROLE" G6_MODE="$MODE" G6_RECORDED_AT="$recorded_at" \
G6_MANIFEST_CREATED_AT="$manifest_created_at" G6_MANIFEST_VERIFIED_AT="$manifest_verified_at" \
G6_MANIFEST_SHA256="$manifest_sha256" G6_CHECKS_JSON="$checks_json" \
	"$BUN_BIN" -e '
		import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
		import { join } from "node:path";
		const receipt = {
			schema: "g6-c32-linux-smoke/1",
			recordedAt: process.env.G6_RECORDED_AT,
			role: process.env.G6_ROLE,
			mode: process.env.G6_MODE,
			checks: JSON.parse(process.env.G6_CHECKS_JSON),
			manifestCreatedAt: process.env.G6_MANIFEST_CREATED_AT,
			manifestVerifiedAt: process.env.G6_MANIFEST_VERIFIED_AT,
			manifestSha256: process.env.G6_MANIFEST_SHA256,
		};
		const root = process.env.G6_EVIDENCE_DIR;
		const target = join(root, "linux-smoke-receipt.json");
		const staging = join(root, `.linux-smoke-receipt.staged-${process.pid}`);
		const fd = openSync(staging, "wx", 0o600);
		try { writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
		renameSync(staging, target);
		const rootFd = openSync(root, "r");
		try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
	'

completed=1
printf 'g6-c32-linux-smoke: PASS role=%s evidence=%s\n' "$ROLE" "$EVIDENCE_DIR"
