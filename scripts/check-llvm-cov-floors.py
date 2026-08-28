#!/usr/bin/env python3
"""
LLVM-cov / Bun LCOV floor checker for webtransport-bun.

Extracted from `.github/workflows/coverage.yml:84-240` so the
per-phase gate can run it without the YAML wrapper. The body is
the same `python3 <<'PY' ... PY` heredoc; the YAML wrapper is
dropped.

Inputs (must be on the filesystem before this script runs):
  - `coverage/native-coverage.json` from
    `cargo llvm-cov --workspace --branch --json --output-path coverage/native-coverage.json`
  - `coverage/wasm-coverage.json` from
    `cargo llvm-cov --manifest-path crates/wasm/Cargo.toml --branch --json --output-path coverage/wasm-coverage.json`
  - `coverage/bun/lcov.info` from
    `bun test --coverage --coverage-reporter=lcov --coverage-dir=coverage/bun packages/`

Exit code:
  - 0: every floored file passes its 90/90/80 (native, wasm) or
    90/90/none (bun) floor.
  - 1: one or more floors fail; details printed to stdout.

This script is runnable as part of the per-phase gate:
  `python3 scripts/check-llvm-cov-floors.py`
"""
import json
import sys
from pathlib import Path

native_floors = {
    "crates/native/src/limits.rs": (90.0, 90.0, 80.0),
    # Logic modules only — TLS rotation + close-drain in server.rs;
    # session capacity/datagram/stream helpers in session.rs.
    # Bind/retry spawn lives in server_spawn.rs (unit-tested, not floored).
    # NAPI/bindings live in *_napi.rs (not floored).
    "crates/native/src/server.rs": (90.0, 90.0, 80.0),
    "crates/native/src/session.rs": (90.0, 90.0, 80.0),
    "crates/native/src/spawn_tracked.rs": (90.0, 90.0, 80.0),
}
wasm_floors = {
    "crates/wasm/src/governor.rs": (90.0, 90.0, 80.0),
    "crates/wasm/src/h3.rs": (90.0, 90.0, 80.0),
    "crates/wasm/src/endpoint.rs": (90.0, 90.0, 80.0),
    "crates/wasm/src/cert.rs": (90.0, 90.0, 80.0),
    "crates/wasm/src/verify.rs": (90.0, 90.0, 80.0),
}
bun_floors = {
    "packages/webtransport/src/backend.ts": (90.0, 90.0, None),
    "packages/webtransport/src/backend-wasm.ts": (90.0, 90.0, None),
    "packages/webtransport/src/wasm-webtransport.ts": (90.0, 90.0, None),
}

failures = []
# Branch data only exists because RUSTC_BOOTSTRAP unlocks
# -Z coverage-options=branch on the pinned stable toolchain. If a
# toolchain bump silently drops branch instrumentation, every file
# reports zero branch sites and the count==0 vacuous-truth rule below
# would wave the whole branch gate through having measured nothing.
# Guard: the floored files must collectively expose at least one
# branch site.
total_branch_sites = 0


def check_json_report(report_path, floors):
    global total_branch_sites
    report = json.loads(Path(report_path).read_text())
    files = {}
    for datum in report.get("data", []):
        for item in datum.get("files", []):
            files[item["filename"]] = item.get("summary", {})
    for suffix, (line_floor, function_floor, branch_floor) in floors.items():
        candidate = next((name for name in files if name.endswith(suffix)), None)
        if candidate is None:
            failures.append(f"{report_path}: missing coverage entry for {suffix}")
            continue
        summary = files[candidate]
        lines = summary.get("lines", {})
        functions = summary.get("functions", {})
        branches = summary.get("branches", {})
        line_pct = float(lines.get("percent", 0.0))
        function_pct = float(functions.get("percent", 0.0))
        # llvm-cov reports 0% when a file has zero branch sites; treat
        # that as full coverage for floor evaluation (vacuous truth).
        branch_count = int(branches.get("count", 0) or 0)
        total_branch_sites += branch_count
        branch_pct = (
            100.0
            if branch_count == 0
            else float(branches.get("percent", 0.0))
        )
        if line_pct < line_floor:
            failures.append(
                f"{candidate}: line coverage {line_pct:.2f}% < required {line_floor:.2f}%"
            )
        if function_pct < function_floor:
            failures.append(
                f"{candidate}: function coverage {function_pct:.2f}% < required {function_floor:.2f}%"
            )
        if branch_pct < branch_floor:
            failures.append(
                f"{candidate}: branch coverage {branch_pct:.2f}% < required {branch_floor:.2f}%"
            )


def parse_lcov(path):
    results = {}
    current = None
    for raw_line in Path(path).read_text().splitlines():
        line = raw_line.strip()
        if line.startswith("SF:"):
            current = {
                "path": line[3:],
                "lines_total": 0,
                "lines_hit": 0,
                "functions_total": None,
                "functions_hit": None,
            }
        elif current and line.startswith("DA:"):
            _, hits = line[3:].split(",", 1)
            current["lines_total"] += 1
            if int(hits) > 0:
                current["lines_hit"] += 1
        elif current and line.startswith("FNF:"):
            current["functions_total"] = int(line[4:])
        elif current and line.startswith("FNH:"):
            current["functions_hit"] = int(line[4:])
        elif current and line == "end_of_record":
            line_pct = (
                100.0 * current["lines_hit"] / current["lines_total"]
                if current["lines_total"]
                else 0.0
            )
            function_pct = (
                100.0 * current["functions_hit"] / current["functions_total"]
                if current["functions_total"] not in (None, 0)
                else None
            )
            results[current["path"]] = {
                "line_pct": line_pct,
                "function_pct": function_pct,
            }
            current = None
    return results


def check_lcov_report(report_path, floors):
    files = parse_lcov(report_path)
    for suffix, (line_floor, function_floor, branch_floor) in floors.items():
        candidate = next((name for name in files if name.endswith(suffix)), None)
        if candidate is None:
            failures.append(f"{report_path}: missing coverage entry for {suffix}")
            continue
        line_pct = float(files[candidate]["line_pct"])
        function_pct = files[candidate]["function_pct"]
        if line_pct < line_floor:
            failures.append(
                f"{candidate}: line coverage {line_pct:.2f}% < required {line_floor:.2f}%"
            )
        if function_floor is not None and function_pct is None:
            failures.append(
                f"{candidate}: function coverage is unavailable in Bun LCOV output"
            )
        elif function_floor is not None and float(function_pct) < function_floor:
            failures.append(
                f"{candidate}: function coverage {float(function_pct):.2f}% < required {function_floor:.2f}%"
            )


def main():
    check_json_report("coverage/native-coverage.json", native_floors)
    check_json_report("coverage/wasm-coverage.json", wasm_floors)
    check_lcov_report("coverage/bun/lcov.info", bun_floors)

    if total_branch_sites == 0:
        failures.append(
            "no branch sites reported across any floored Rust file: "
            "branch instrumentation is missing, so the branch floors "
            "verified nothing"
        )

    if failures:
        for failure in failures:
            print(failure)
        sys.exit(1)


if __name__ == "__main__":
    main()
