# Native Datagram Reflector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reflect stamped datagrams inside the native crate under a per-server byte rule so the G6 ack never crosses into JavaScript, with the reflection counted so every registered campaign quantity still reconciles.

**Architecture:** A `datagram_reflector` module compiles and stores one validated rule per server; the per-connection forward task in `lib.rs` applies it inline after the size check and before queued-byte reservation, sends the reply on the same connection, counts the outcome, and skips the JS queue. The rule is exposed as `setDatagramReflector(rule | null)` on the native root server, validated in TypeScript and again in native; the G6 harness installs its v3-stamp rule when `SCAN_ACK_REFLECTOR=native` and reconciles the native counters into its boundary snapshots.

**Tech Stack:** Rust (napi-rs, tokio, wtransport), TypeScript on Bun (`bun test`), bash (campaign controller), GitHub Actions on the self-hosted heavy Linux runner.

**Spec:** `docs/superpowers/specs/2026-09-02-native-datagram-reflector-design.md`

## Global Constraints

- Rule bounds (spec §1): `1 ≤ replyLength ≤ minLength ≤ 1200`; every match range inside `[0, minLength)`; every op range inside `[0, replyLength)`; `nowNs`/`holdNs` need 8 bytes; `copy.length ≥ 1`; `1 ≤ match.length ≤ 8`; `0 ≤ rewrite.length ≤ 16`; `set.value` in `0..=255`; byte order little-endian, not configurable.
- Validation runs in TypeScript AND in native; a raw-addon caller cannot bypass it (spec §3).
- The forward task never awaits, retries, or parks on a reflected send; a send error is counted and dropped (spec §2).
- A matched datagram is never queued to JS; `datagrams_in` is counted before the hook and stays unchanged (spec §2).
- `SCAN_ACK_REFLECTOR` defaults to `js`; every existing profile is byte-identical in behavior (spec §4).
- Boundary reconciliation: `rxTotal += Δ hits`, `ackDue += Δ hits`, `ackIssued += Δ sent`, `sendErrors += Δ sendErrors` (spec §4).
- No paid campaign run. The kill gate runs on the self-hosted Linux runner by riding the existing `bench-bandwidth.yml` workflow name (new dispatch-only workflows are unregisterable from a non-default branch).
- Producer-identity table in `.scratch/bare-metal-campaign/registrations/g6-c32-rca-closure-01.md` must be refreshed in the same change as any listed producer, or the next freeze refuses.
- Repo conventions: tabs in TypeScript, biome formatting (`bunx biome format --write <files>` before commit), `bun run typecheck` clean, commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never commit `AGENTS.md` (pre-existing unrelated dirt).
- Native rebuild before JS integration tests: `bun run build:native`. Rust tests: `cargo test -p native --lib`.

---

## File structure

| File | Responsibility |
|---|---|
| `crates/native/src/datagram_reflector.rs` (new) | Rule input/compiled types, validation, `apply`, per-server store, reason mapping. Pure; no napi types except the `#[napi(object)]` input structs. |
| `crates/native/src/server_metrics.rs` (modify) | Four reflector counters, per-reason counters, hold histogram, snapshot export. |
| `crates/native/src/metrics.rs` (modify) | `ServerMetricsSnapshot` fields for the reflector. |
| `crates/native/src/lib.rs` (modify) | `pub mod datagram_reflector;` and the hook in the forward task. |
| `crates/native/src/server_napi.rs` (modify) | `setDatagramReflector` method; clear the rule on `close()`. |
| `packages/webtransport/src/datagram-reflector.ts` (new) | Rule types, `datagramReflectorRuleChecked`, `applyDatagramReflectorRule` reference implementation. |
| `packages/webtransport/src/index.ts` (modify) | Interface member, wrapper wiring, metrics type fields. |
| `packages/webtransport/test/native-datagram-reflector.test.ts` (new) | Integration test against the native addon. |
| `packages/webtransport/test/datagram-reflector.test.ts` (new) | Validator and reference-apply unit tests. |
| `packages/webtransport/test/public-surface-contract.test.ts` (modify) | Portable exclusion. |
| `docs/PARITY_MATRIX.md` (modify) | Native-only row. |
| `tools/load/g6-ack-reflector-rule.ts` (new) | `G6_V3_ACK_REFLECTOR_RULE` constant. |
| `tools/load/g6-shard-server.ts`, `tools/load/g6-server-core.ts`, `tools/load/g6-sharded-scan.ts` (modify) | `--ack-reflector` plumbing, rule install, boundary reconciliation, rated config field. |
| `tools/load/g6-c32-rca-evaluate.ts`, `tools/load/g6-c32-successor-grade.ts`, `tools/load/g6-c32-rca-controller.sh`, `tools/load/g6-c32-ladder-profile.json` (modify) | Registered-profile enforcement of `ackReflector`. |
| `tools/load/g6-ack-reflector-gate.ts` (new), `.github/workflows/bench-bandwidth.yml` (modify) | Kill gate. |

---

### Task 1: Reflector rule module (Rust)

**Files:**
- Create: `crates/native/src/datagram_reflector.rs`
- Modify: `crates/native/src/lib.rs:88` (add `pub mod datagram_reflector;` after `pub mod datagram_mirror;`)

**Interfaces:**
- Produces:
  - `pub struct DatagramReflectorRuleInput { pub min_length: u32, pub reply_length: u32, pub matches: Vec<ReflectorMatchInput>, pub rewrite: Vec<ReflectorOpInput> }` (`#[napi(object)]`)
  - `pub struct ReflectorMatchInput { pub offset: u32, pub bytes: Vec<u8> }` (`#[napi(object)]`)
  - `pub struct ReflectorOpInput { pub op: String, pub at: Option<u32>, pub from: Option<u32>, pub to: Option<u32>, pub length: Option<u32>, pub value: Option<u32> }` (`#[napi(object)]`)
  - `pub struct CompiledRule` with `pub fn matches(&self, datagram: &[u8]) -> bool` and `pub fn apply(&self, datagram: &[u8], now_ns: u64, hold_ns: u64) -> Vec<u8>`
  - `pub fn compile(input: &DatagramReflectorRuleInput) -> Result<CompiledRule, RuleError>` where `pub enum RuleError { Shape(String), Range(String) }`
  - `pub fn set_rule(owner_server_id: u64, rule: Option<Arc<CompiledRule>>)`, `pub fn rule_for(owner_server_id: u64) -> Option<Arc<CompiledRule>>`, `pub fn clear_owner(owner_server_id: u64)`
  - `pub const MAX_REPLY_LENGTH: u32 = 1200; pub const MAX_MATCHES: usize = 8; pub const MAX_OPS: usize = 16;`

- [ ] **Step 1: Write the failing tests**

Create `crates/native/src/datagram_reflector.rs` with only the test module first:

```rust
//! Per-server datagram reflector: match a datagram by byte ranges and answer
//! it in native with a rewritten copy of its first bytes. Protocol-agnostic;
//! the caller expresses its stamp layout as a rule.

#[cfg(test)]
mod tests {
    use super::*;

    fn g6_rule() -> DatagramReflectorRuleInput {
        DatagramReflectorRuleInput {
            min_length: 48,
            reply_length: 48,
            matches: vec![
                ReflectorMatchInput { offset: 0, bytes: vec![0x54, 0x4c] },
                ReflectorMatchInput { offset: 2, bytes: vec![3, 0] },
                ReflectorMatchInput { offset: 44, bytes: vec![1] },
            ],
            rewrite: vec![
                op("copy", None, Some(12), Some(28), Some(8), None),
                op("zero", Some(4), None, None, Some(8), None),
                op("nowNs", Some(12), None, None, None, None),
                op("holdNs", Some(36), None, None, None, None),
                op("set", Some(44), None, None, None, Some(2)),
            ],
        }
    }

    fn op(
        name: &str,
        at: Option<u32>,
        from: Option<u32>,
        to: Option<u32>,
        length: Option<u32>,
        value: Option<u32>,
    ) -> ReflectorOpInput {
        ReflectorOpInput { op: name.to_string(), at, from, to, length, value }
    }

    /// A version-3 action stamp exactly as tools/load/latency-stamp.ts writes it.
    fn action_stamp(intended: u64, actual: u64, sequence: u64) -> Vec<u8> {
        let mut bytes = vec![0u8; 64];
        bytes[0..2].copy_from_slice(&0x4c54u16.to_le_bytes());
        bytes[2..4].copy_from_slice(&3u16.to_le_bytes());
        bytes[4..12].copy_from_slice(&intended.to_le_bytes());
        bytes[12..20].copy_from_slice(&actual.to_le_bytes());
        bytes[20..28].copy_from_slice(&sequence.to_le_bytes());
        bytes[44] = 1;
        bytes
    }

    /// The reflected ack exactly as crates/reference/src/g6_protocol.rs
    /// `encode_reflected_ack(echo_actual_ns, server_send_ns, hold_ns, sequence)`
    /// lays it out: version 3, intended 0, actual = server send, sequence kept,
    /// echoActual at 28, hold at 36, class 2 at 44.
    fn expected_ack(echo_actual: u64, server_send: u64, hold: u64, sequence: u64) -> Vec<u8> {
        let mut bytes = vec![0u8; 48];
        bytes[0..2].copy_from_slice(&0x4c54u16.to_le_bytes());
        bytes[2..4].copy_from_slice(&3u16.to_le_bytes());
        bytes[12..20].copy_from_slice(&server_send.to_le_bytes());
        bytes[20..28].copy_from_slice(&sequence.to_le_bytes());
        bytes[28..36].copy_from_slice(&echo_actual.to_le_bytes());
        bytes[36..44].copy_from_slice(&hold.to_le_bytes());
        bytes[44] = 2;
        bytes
    }

    #[test]
    fn g6_rule_reproduces_the_reference_reflected_ack_byte_for_byte() {
        let rule = compile(&g6_rule()).expect("valid rule");
        let datagram = action_stamp(10, 20, 30);
        assert!(rule.matches(&datagram));
        let reply = rule.apply(&datagram, 125, 35);
        assert_eq!(reply, expected_ack(20, 125, 35, 30));
    }

    #[test]
    fn non_matching_datagrams_are_not_reflected() {
        let rule = compile(&g6_rule()).expect("valid rule");
        let mut snapshot_class = action_stamp(1, 2, 3);
        snapshot_class[44] = 3;
        assert!(!rule.matches(&snapshot_class));
        let mut wrong_magic = action_stamp(1, 2, 3);
        wrong_magic[0] = 0;
        assert!(!rule.matches(&wrong_magic));
        assert!(!rule.matches(&action_stamp(1, 2, 3)[..47]));
        assert!(!rule.matches(&[]));
    }

    #[test]
    fn reply_is_exactly_reply_length_bytes() {
        let rule = compile(&g6_rule()).expect("valid rule");
        let reply = rule.apply(&action_stamp(1, 2, 3), 0, 0);
        assert_eq!(reply.len(), 48);
    }

    #[test]
    fn validation_refuses_every_out_of_bound_shape() {
        let mut bad_reply_len = g6_rule();
        bad_reply_len.reply_length = 49;
        assert!(matches!(compile(&bad_reply_len), Err(RuleError::Range(_))));

        let mut zero_reply = g6_rule();
        zero_reply.reply_length = 0;
        assert!(matches!(compile(&zero_reply), Err(RuleError::Range(_))));

        let mut too_long = g6_rule();
        too_long.min_length = MAX_REPLY_LENGTH + 1;
        too_long.reply_length = MAX_REPLY_LENGTH + 1;
        assert!(matches!(compile(&too_long), Err(RuleError::Range(_))));

        let mut match_past_min = g6_rule();
        match_past_min.matches.push(ReflectorMatchInput { offset: 47, bytes: vec![1, 2] });
        assert!(matches!(compile(&match_past_min), Err(RuleError::Range(_))));

        let mut empty_match = g6_rule();
        empty_match.matches.clear();
        assert!(matches!(compile(&empty_match), Err(RuleError::Shape(_))));

        let mut too_many_matches = g6_rule();
        for _ in 0..MAX_MATCHES {
            too_many_matches.matches.push(ReflectorMatchInput { offset: 0, bytes: vec![0x54] });
        }
        assert!(matches!(compile(&too_many_matches), Err(RuleError::Shape(_))));

        let mut op_past_reply = g6_rule();
        op_past_reply.rewrite.push(op("nowNs", Some(41), None, None, None, None));
        assert!(matches!(compile(&op_past_reply), Err(RuleError::Range(_))));

        let mut copy_past_reply = g6_rule();
        copy_past_reply.rewrite.push(op("copy", None, Some(44), Some(0), Some(8), None));
        assert!(matches!(compile(&copy_past_reply), Err(RuleError::Range(_))));

        let mut zero_length_copy = g6_rule();
        zero_length_copy.rewrite.push(op("copy", None, Some(0), Some(8), Some(0), None));
        assert!(matches!(compile(&zero_length_copy), Err(RuleError::Range(_))));

        let mut bad_value = g6_rule();
        bad_value.rewrite.push(op("set", Some(0), None, None, None, Some(256)));
        assert!(matches!(compile(&bad_value), Err(RuleError::Range(_))));

        let mut unknown_op = g6_rule();
        unknown_op.rewrite.push(op("xor", Some(0), None, None, None, Some(1)));
        assert!(matches!(compile(&unknown_op), Err(RuleError::Shape(_))));

        let mut missing_field = g6_rule();
        missing_field.rewrite.push(op("set", Some(0), None, None, None, None));
        assert!(matches!(compile(&missing_field), Err(RuleError::Shape(_))));

        let mut too_many_ops = g6_rule();
        for _ in 0..MAX_OPS {
            too_many_ops.rewrite.push(op("set", Some(0), None, None, None, Some(0)));
        }
        assert!(matches!(compile(&too_many_ops), Err(RuleError::Shape(_))));
    }

    #[test]
    fn overlapping_copy_behaves_like_memmove() {
        let input = DatagramReflectorRuleInput {
            min_length: 8,
            reply_length: 8,
            matches: vec![ReflectorMatchInput { offset: 0, bytes: vec![1] }],
            rewrite: vec![op("copy", None, Some(0), Some(2), Some(4), None)],
        };
        let rule = compile(&input).expect("valid rule");
        let reply = rule.apply(&[1, 2, 3, 4, 5, 6, 7, 8], 0, 0);
        assert_eq!(reply, vec![1, 2, 1, 2, 3, 4, 7, 8]);
    }

    #[test]
    fn store_is_per_owner_and_clearable() {
        let rule = Arc::new(compile(&g6_rule()).expect("valid rule"));
        set_rule(7001, Some(Arc::clone(&rule)));
        assert!(rule_for(7001).is_some());
        assert!(rule_for(7002).is_none());
        set_rule(7001, None);
        assert!(rule_for(7001).is_none());
        set_rule(7003, Some(rule));
        clear_owner(7003);
        assert!(rule_for(7003).is_none());
    }
}
```

- [ ] **Step 2: Add the module declaration and run the tests to verify they fail**

In `crates/native/src/lib.rs`, after `pub mod datagram_mirror;` add `pub mod datagram_reflector;`.

Run: `cargo test -p native --lib datagram_reflector`
Expected: compile error, `compile`, `CompiledRule`, `DatagramReflectorRuleInput` not found.

- [ ] **Step 3: Write the implementation above the test module**

```rust
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};

pub const MAX_REPLY_LENGTH: u32 = 1200;
pub const MAX_MATCHES: usize = 8;
pub const MAX_OPS: usize = 16;

/// One equality check: the datagram bytes at `offset` must equal `bytes`.
#[napi(object)]
pub struct ReflectorMatchInput {
    pub offset: u32,
    pub bytes: Vec<u8>,
}

/// One rewrite. `op` selects which of the optional fields are read:
/// `copy` uses `from`, `to`, `length`; `nowNs` and `holdNs` use `at`;
/// `zero` uses `at`, `length`; `set` uses `at`, `value`.
#[napi(object)]
pub struct ReflectorOpInput {
    pub op: String,
    pub at: Option<u32>,
    pub from: Option<u32>,
    pub to: Option<u32>,
    pub length: Option<u32>,
    pub value: Option<u32>,
}

#[napi(object)]
pub struct DatagramReflectorRuleInput {
    pub min_length: u32,
    pub reply_length: u32,
    pub matches: Vec<ReflectorMatchInput>,
    pub rewrite: Vec<ReflectorOpInput>,
}

#[derive(Debug)]
pub enum RuleError {
    /// Wrong shape: unknown op, missing field, empty or oversized lists.
    Shape(String),
    /// Right shape, out-of-bound offsets, lengths, or values.
    Range(String),
}

impl RuleError {
    pub fn message(&self) -> &str {
        match self {
            RuleError::Shape(m) | RuleError::Range(m) => m,
        }
    }
}

#[derive(Debug, Clone)]
enum Op {
    Copy { from: usize, to: usize, length: usize },
    NowNs { at: usize },
    HoldNs { at: usize },
    Zero { at: usize, length: usize },
    Set { at: usize, value: u8 },
}

#[derive(Debug, Clone)]
struct Match {
    offset: usize,
    bytes: Vec<u8>,
}

/// A rule whose every offset has been checked against `reply_length` and
/// `min_length`, so `matches` and `apply` index without bounds checks.
#[derive(Debug, Clone)]
pub struct CompiledRule {
    min_length: usize,
    reply_length: usize,
    matches: Vec<Match>,
    ops: Vec<Op>,
}

fn range_in(label: &str, start: u32, length: u32, bound: usize) -> Result<(usize, usize), RuleError> {
    let start = start as usize;
    let length = length as usize;
    if length == 0 {
        return Err(RuleError::Range(format!("{label} length must be at least 1")));
    }
    match start.checked_add(length) {
        Some(end) if end <= bound => Ok((start, length)),
        _ => Err(RuleError::Range(format!(
            "{label} range {start}..{} exceeds {bound}",
            start.saturating_add(length)
        ))),
    }
}

fn required(field: Option<u32>, op: &str, name: &str) -> Result<u32, RuleError> {
    field.ok_or_else(|| RuleError::Shape(format!("op {op} requires {name}")))
}

pub fn compile(input: &DatagramReflectorRuleInput) -> Result<CompiledRule, RuleError> {
    if input.reply_length == 0 {
        return Err(RuleError::Range("replyLength must be at least 1".to_string()));
    }
    if input.reply_length > input.min_length {
        return Err(RuleError::Range("replyLength must not exceed minLength".to_string()));
    }
    if input.min_length > MAX_REPLY_LENGTH {
        return Err(RuleError::Range(format!("minLength must not exceed {MAX_REPLY_LENGTH}")));
    }
    if input.matches.is_empty() || input.matches.len() > MAX_MATCHES {
        return Err(RuleError::Shape(format!("match needs 1..={MAX_MATCHES} entries")));
    }
    if input.rewrite.len() > MAX_OPS {
        return Err(RuleError::Shape(format!("rewrite allows at most {MAX_OPS} ops")));
    }
    let min_length = input.min_length as usize;
    let reply_length = input.reply_length as usize;
    let mut matches = Vec::with_capacity(input.matches.len());
    for m in &input.matches {
        let (offset, _) = range_in("match", m.offset, m.bytes.len() as u32, min_length)?;
        matches.push(Match { offset, bytes: m.bytes.clone() });
    }
    let mut ops = Vec::with_capacity(input.rewrite.len());
    for op in &input.rewrite {
        let compiled = match op.op.as_str() {
            "copy" => {
                let length = required(op.length, "copy", "length")?;
                let (from, _) = range_in("copy.from", required(op.from, "copy", "from")?, length, reply_length)?;
                let (to, length) = range_in("copy.to", required(op.to, "copy", "to")?, length, reply_length)?;
                Op::Copy { from, to, length }
            }
            "nowNs" => {
                let (at, _) = range_in("nowNs", required(op.at, "nowNs", "at")?, 8, reply_length)?;
                Op::NowNs { at }
            }
            "holdNs" => {
                let (at, _) = range_in("holdNs", required(op.at, "holdNs", "at")?, 8, reply_length)?;
                Op::HoldNs { at }
            }
            "zero" => {
                let (at, length) = range_in(
                    "zero",
                    required(op.at, "zero", "at")?,
                    required(op.length, "zero", "length")?,
                    reply_length,
                )?;
                Op::Zero { at, length }
            }
            "set" => {
                let value = required(op.value, "set", "value")?;
                if value > 255 {
                    return Err(RuleError::Range("set.value must be 0..=255".to_string()));
                }
                let (at, _) = range_in("set", required(op.at, "set", "at")?, 1, reply_length)?;
                Op::Set { at, value: value as u8 }
            }
            other => return Err(RuleError::Shape(format!("unknown op {other}"))),
        };
        ops.push(compiled);
    }
    Ok(CompiledRule { min_length, reply_length, matches, ops })
}

impl CompiledRule {
    pub fn reply_length(&self) -> usize {
        self.reply_length
    }

    pub fn matches(&self, datagram: &[u8]) -> bool {
        if datagram.len() < self.min_length {
            return false;
        }
        self.matches
            .iter()
            .all(|m| &datagram[m.offset..m.offset + m.bytes.len()] == m.bytes.as_slice())
    }

    /// Build the reply: the datagram's first `reply_length` bytes with the ops
    /// applied in order. The caller guarantees `matches` returned true.
    pub fn apply(&self, datagram: &[u8], now_ns: u64, hold_ns: u64) -> Vec<u8> {
        let mut reply = datagram[..self.reply_length].to_vec();
        for op in &self.ops {
            match *op {
                Op::Copy { from, to, length } => reply.copy_within(from..from + length, to),
                Op::NowNs { at } => reply[at..at + 8].copy_from_slice(&now_ns.to_le_bytes()),
                Op::HoldNs { at } => reply[at..at + 8].copy_from_slice(&hold_ns.to_le_bytes()),
                Op::Zero { at, length } => reply[at..at + length].fill(0),
                Op::Set { at, value } => reply[at] = value,
            }
        }
        reply
    }
}

fn store() -> &'static RwLock<HashMap<u64, Arc<CompiledRule>>> {
    static STORE: OnceLock<RwLock<HashMap<u64, Arc<CompiledRule>>>> = OnceLock::new();
    STORE.get_or_init(|| RwLock::new(HashMap::new()))
}

pub fn set_rule(owner_server_id: u64, rule: Option<Arc<CompiledRule>>) {
    let mut map = store().write().unwrap_or_else(|poisoned| poisoned.into_inner());
    match rule {
        Some(rule) => {
            map.insert(owner_server_id, rule);
        }
        None => {
            map.remove(&owner_server_id);
        }
    }
}

pub fn rule_for(owner_server_id: u64) -> Option<Arc<CompiledRule>> {
    let map = store().read().unwrap_or_else(|poisoned| poisoned.into_inner());
    map.get(&owner_server_id).cloned()
}

pub fn clear_owner(owner_server_id: u64) {
    set_rule(owner_server_id, None);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p native --lib datagram_reflector`
Expected: 6 tests pass.

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt --all
cargo clippy -p native --all-targets -- -D warnings
git add crates/native/src/datagram_reflector.rs crates/native/src/lib.rs
git commit -m "Add the compiled per-server datagram reflector rule

A rule is match ranges plus ordered byte rewrites, validated once so the
hot path indexes without bounds checks; the G6 v3 stamp expressed as a
rule reproduces the reference reflected ack byte for byte.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Reflector metrics

**Files:**
- Modify: `crates/native/src/server_metrics.rs` (struct `ServerMetrics` around line 39-104; `snapshot` around line 261)
- Modify: `crates/native/src/metrics.rs` (`ServerMetricsSnapshot` around line 16-88)
- Modify: `packages/webtransport/src/index.ts` (`MetricsSnapshot` type near line 1096-1103)

**Interfaces:**
- Produces on `ServerMetrics`: `datagram_reflect_hits`, `datagram_reflect_sent`, `datagram_reflect_send_errors`, `datagram_reflect_send_not_connected`, `datagram_reflect_send_unsupported`, `datagram_reflect_send_too_large` (all `AtomicU64`), `datagram_reflect_hold: LatencyHistogram`, and `pub fn record_reflect_send_error(&self, reason: ReflectSendErrorReason)` with `pub enum ReflectSendErrorReason { NotConnected, UnsupportedByPeer, TooLarge }`.
- Produces on `ServerMetricsSnapshot`: `datagram_reflect_hits: Option<f64>`, `datagram_reflect_sent: Option<f64>`, `datagram_reflect_send_errors: Option<f64>`, `datagram_reflect_send_errors_by_reason: Option<ReflectSendErrorsSnapshot>` (`#[napi(object)] pub struct ReflectSendErrorsSnapshot { pub not_connected: f64, pub unsupported_by_peer: f64, pub too_large: f64 }`), `datagram_reflect_hold: Option<HistogramSnapshot>`.
- Produces on TS `MetricsSnapshot`: `datagramReflectHits?: number; datagramReflectSent?: number; datagramReflectSendErrors?: number; datagramReflectSendErrorsByReason?: { notConnected: number; unsupportedByPeer: number; tooLarge: number }; datagramReflectHold?: HistogramSnapshot | null;`

- [ ] **Step 1: Write the failing test** in the existing `#[cfg(test)] mod tests` of `crates/native/src/server_metrics.rs`:

```rust
    #[test]
    fn reflector_counters_export_zero_and_no_histogram_until_observed() {
        let metrics = ServerMetrics::default();
        let snapshot = metrics.snapshot(None);
        assert_eq!(snapshot.datagram_reflect_hits, Some(0.0));
        assert_eq!(snapshot.datagram_reflect_sent, Some(0.0));
        assert_eq!(snapshot.datagram_reflect_send_errors, Some(0.0));
        let by_reason = snapshot.datagram_reflect_send_errors_by_reason.expect("by-reason block");
        assert_eq!((by_reason.not_connected, by_reason.unsupported_by_peer, by_reason.too_large), (0.0, 0.0, 0.0));
        assert!(snapshot.datagram_reflect_hold.is_none());

        metrics.datagram_reflect_hits.fetch_add(3, Ordering::Relaxed);
        metrics.datagram_reflect_sent.fetch_add(2, Ordering::Relaxed);
        metrics.record_reflect_send_error(ReflectSendErrorReason::TooLarge);
        metrics.datagram_reflect_hold.observe(std::time::Duration::from_micros(40));
        let snapshot = metrics.snapshot(None);
        assert_eq!(snapshot.datagram_reflect_hits, Some(3.0));
        assert_eq!(snapshot.datagram_reflect_sent, Some(2.0));
        assert_eq!(snapshot.datagram_reflect_send_errors, Some(1.0));
        assert_eq!(snapshot.datagram_reflect_send_errors_by_reason.expect("by-reason").too_large, 1.0);
        let hold = snapshot.datagram_reflect_hold.expect("histogram after one observation");
        assert_eq!(hold.count, 1.0);
    }
```

Check how the existing tests in that module call `snapshot` (the TLS argument is `Option<...>`); pass `None` exactly as the neighbouring tests do.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p native --lib server_metrics`
Expected: compile error, unknown fields.

- [ ] **Step 3: Implement**

In `ServerMetrics` (after `datagram_mirror_paced_targets`):

```rust
    /// Datagrams the per-server reflector matched, whatever the send did.
    pub datagram_reflect_hits: AtomicU64,
    /// Reflected replies quinn accepted. Delivery stays per-session `datagrams_out`.
    pub datagram_reflect_sent: AtomicU64,
    /// Reflected replies quinn refused, total and by reason. Never retried:
    /// the receive task must not park on a send.
    pub datagram_reflect_send_errors: AtomicU64,
    pub datagram_reflect_send_not_connected: AtomicU64,
    pub datagram_reflect_send_unsupported: AtomicU64,
    pub datagram_reflect_send_too_large: AtomicU64,
    /// Receive-to-reflection duration for every match.
    pub datagram_reflect_hold: LatencyHistogram,
```

Add near `DatagramDropReason`:

```rust
/// Why one reflected reply was refused by the transport.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReflectSendErrorReason {
    NotConnected,
    UnsupportedByPeer,
    TooLarge,
}
```

In `impl ServerMetrics`:

```rust
    pub fn record_reflect_send_error(&self, reason: ReflectSendErrorReason) {
        self.datagram_reflect_send_errors.fetch_add(1, Ordering::Relaxed);
        let counter = match reason {
            ReflectSendErrorReason::NotConnected => &self.datagram_reflect_send_not_connected,
            ReflectSendErrorReason::UnsupportedByPeer => &self.datagram_reflect_send_unsupported,
            ReflectSendErrorReason::TooLarge => &self.datagram_reflect_send_too_large,
        };
        counter.fetch_add(1, Ordering::Relaxed);
    }
```

In `snapshot`, next to the mirror fields:

```rust
            datagram_reflect_hits: Some(self.datagram_reflect_hits.load(Ordering::Relaxed) as f64),
            datagram_reflect_sent: Some(self.datagram_reflect_sent.load(Ordering::Relaxed) as f64),
            datagram_reflect_send_errors: Some(
                self.datagram_reflect_send_errors.load(Ordering::Relaxed) as f64,
            ),
            datagram_reflect_send_errors_by_reason: Some(super::metrics::ReflectSendErrorsSnapshot {
                not_connected: self.datagram_reflect_send_not_connected.load(Ordering::Relaxed) as f64,
                unsupported_by_peer: self.datagram_reflect_send_unsupported.load(Ordering::Relaxed) as f64,
                too_large: self.datagram_reflect_send_too_large.load(Ordering::Relaxed) as f64,
            }),
            datagram_reflect_hold: if self.datagram_reflect_hold.count() > 0 {
                Some(histogram_to_snapshot(&self.datagram_reflect_hold))
            } else {
                None
            },
```

In `crates/native/src/metrics.rs`, add after `HistogramSnapshot`:

```rust
#[napi(object)]
pub struct ReflectSendErrorsSnapshot {
    pub not_connected: f64,
    pub unsupported_by_peer: f64,
    pub too_large: f64,
}
```

and on `ServerMetricsSnapshot` after `mirror_reports_dropped`:

```rust
    /// Native only. Datagrams the per-server reflector matched.
    pub datagram_reflect_hits: Option<f64>,
    /// Native only. Reflected replies the transport accepted.
    pub datagram_reflect_sent: Option<f64>,
    /// Native only. Reflected replies the transport refused (dropped, never retried).
    pub datagram_reflect_send_errors: Option<f64>,
    pub datagram_reflect_send_errors_by_reason: Option<ReflectSendErrorsSnapshot>,
    /// Native only. Receive-to-reflection duration. Present when any observation.
    pub datagram_reflect_hold: Option<HistogramSnapshot>,
```

In `packages/webtransport/src/index.ts`, after `mirrorReportsDropped?: number;`:

```ts
	/** Native only. Datagrams the per-server reflector matched. */
	datagramReflectHits?: number;
	/** Native only. Reflected replies the transport accepted. */
	datagramReflectSent?: number;
	/** Native only. Reflected replies the transport refused; dropped, never retried. */
	datagramReflectSendErrors?: number;
	datagramReflectSendErrorsByReason?: {
		notConnected: number;
		unsupportedByPeer: number;
		tooLarge: number;
	};
	/** Native only. Receive-to-reflection duration. Present when any observation. */
	datagramReflectHold?: HistogramSnapshot | null;
```

napi-rs camel-cases struct fields on the JS side automatically, so no mapping code changes; confirm by grepping how `datagramMirrorCalls` reaches JS (`index.ts:1339` reads either casing) and mirror that if a manual mapping exists for the `Option<HistogramSnapshot>` fields.

- [ ] **Step 4: Run tests, typecheck**

Run: `cargo test -p native --lib server_metrics && bun run typecheck`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
cargo fmt --all && bunx biome format --write packages/webtransport/src/index.ts
git add crates/native/src/server_metrics.rs crates/native/src/metrics.rs packages/webtransport/src/index.ts
git commit -m "Count reflector hits, sends, send errors and hold in the server metrics

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The hook, the N-API method, and the end-to-end test

**Files:**
- Modify: `crates/native/src/lib.rs` (forward task, the `res = conn_dgram.receive_datagram()` arm around lines 1550-1616)
- Modify: `crates/native/src/server_napi.rs` (new method next to `send_datagram_mirror` ~line 418; `close()` ~line 363-380)
- Modify: `packages/webtransport/src/index.ts` (interface member after `readMirrorReports` ~line 773; wiring after `sendDatagramMirror:` ~line 2597)
- Create: `packages/webtransport/test/native-datagram-reflector.test.ts`

**Interfaces:**
- Consumes: Task 1 `datagram_reflector::{compile, set_rule, rule_for, clear_owner, DatagramReflectorRuleInput, RuleError}`; Task 2 counters and `record_reflect_send_error`.
- Produces: native `ServerHandle::set_datagram_reflector(&self, rule: Option<DatagramReflectorRuleInput>) -> napi::Result<()>` exported as `setDatagramReflector`; TS `WebTransportServer.setDatagramReflector(rule: DatagramReflectorRule | null): void` (temporary passthrough in this task; Task 4 adds the checked validator in front of it).

- [ ] **Step 1: Write the failing integration test**

`packages/webtransport/test/native-datagram-reflector.test.ts`:

```ts
/**
 * The per-server datagram reflector: a matched datagram is answered in
 * native and never reaches JavaScript; everything else takes the ordinary
 * path untouched. Pinned from the outside: the reply bytes, the metrics,
 * the non-delivery, and the clear.
 */

import { describe, expect, it } from "bun:test";
import { createServer } from "../src/index.js";
import type {
	ClientSession,
	ServerSession,
	WebTransportServer,
} from "../src/index.js";
import { nextWithTimeout } from "./helpers/harness.js";
import { connectWithRetry, nextPort } from "./helpers/network.js";

const BASE_PORT = 25_900;
const PORT_SPREAD = 200;

const G6_RULE = {
	minLength: 48,
	replyLength: 48,
	match: [
		{ offset: 0, bytes: new Uint8Array([0x54, 0x4c]) },
		{ offset: 2, bytes: new Uint8Array([3, 0]) },
		{ offset: 44, bytes: new Uint8Array([1]) },
	],
	rewrite: [
		{ op: "copy", from: 12, to: 28, length: 8 },
		{ op: "zero", at: 4, length: 8 },
		{ op: "nowNs", at: 12 },
		{ op: "holdNs", at: 36 },
		{ op: "set", at: 44, value: 2 },
	],
} as const;

function readU64(bytes: Uint8Array, offset: number): bigint {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
}

function actionStamp(actual: bigint, sequence: bigint): Uint8Array {
	const bytes = new Uint8Array(64);
	const view = new DataView(bytes.buffer);
	view.setUint16(0, 0x4c54, true);
	view.setUint16(2, 3, true);
	view.setBigUint64(4, 7n, true);
	view.setBigUint64(12, actual, true);
	view.setBigUint64(20, sequence, true);
	bytes[44] = 1;
	return bytes;
}

type Fixture = {
	server: WebTransportServer;
	session: ServerSession;
	client: ClientSession;
	fromClient: AsyncIterator<Uint8Array>;
	toClient: AsyncIterator<Uint8Array>;
};

async function withSession(body: (f: Fixture) => Promise<void>): Promise<void> {
	const port = nextPort(BASE_PORT, PORT_SPREAD);
	const accepted = Promise.withResolvers<ServerSession>();
	const server = createServer({
		port,
		tls: { certPem: "", keyPem: "" },
		onSession: (s) => accepted.resolve(s),
	});
	try {
		const client = await connectWithRetry(port);
		const session = await accepted.promise;
		await body({
			server,
			session,
			client,
			fromClient: session.incomingDatagrams()[Symbol.asyncIterator](),
			toClient: client.incomingDatagrams()[Symbol.asyncIterator](),
		});
	} finally {
		await server.close();
	}
}

describe("native datagram reflector", () => {
	it("answers a matched datagram in native and never delivers it to JS", async () => {
		await withSession(async ({ server, client, fromClient, toClient }) => {
			server.setDatagramReflector(G6_RULE);
			await client.sendDatagram(actionStamp(123_456n, 9n));
			const reply = await nextWithTimeout(toClient, 2_000);
			expect(reply.byteLength).toBe(48);
			expect(new DataView(reply.buffer, reply.byteOffset).getUint16(0, true)).toBe(0x4c54);
			expect(new DataView(reply.buffer, reply.byteOffset).getUint16(2, true)).toBe(3);
			expect(readU64(reply, 4)).toBe(0n);           // intended zeroed
			expect(readU64(reply, 12)).toBeGreaterThan(0n); // server send instant
			expect(readU64(reply, 20)).toBe(9n);          // sequence kept
			expect(readU64(reply, 28)).toBe(123_456n);    // client actual echoed
			expect(readU64(reply, 36)).toBeGreaterThanOrEqual(0n); // hold
			expect(reply[44]).toBe(2);                    // CLASS_ACK

			// A non-matching datagram still reaches JS.
			await client.sendDatagram(new Uint8Array([9, 9, 9]));
			const delivered = await nextWithTimeout(fromClient, 2_000);
			expect(Array.from(delivered)).toEqual([9, 9, 9]);

			const m = server.metricsSnapshot();
			expect(m.datagramReflectHits).toBe(1);
			expect(m.datagramReflectSent).toBe(1);
			expect(m.datagramReflectSendErrors).toBe(0);
			expect(m.datagramReflectHold?.count).toBe(1);
			expect(m.datagramsIn).toBe(2);
		});
	});

	it("delivers the same datagram to JS once the rule is cleared", async () => {
		await withSession(async ({ server, client, fromClient }) => {
			server.setDatagramReflector(G6_RULE);
			server.setDatagramReflector(null);
			await client.sendDatagram(actionStamp(1n, 2n));
			const delivered = await nextWithTimeout(fromClient, 2_000);
			expect(delivered.byteLength).toBe(64);
			expect(delivered[44]).toBe(1);
			expect(server.metricsSnapshot().datagramReflectHits).toBe(0);
		});
	});

	it("re-validates the rule in native: an out-of-range op is a RangeError before any state changes", async () => {
		await withSession(async ({ server }) => {
			const bad = { ...G6_RULE, rewrite: [{ op: "nowNs", at: 41 }] };
			// Bypass the TypeScript validator on purpose to reach the native one.
			const raw = server as unknown as { setDatagramReflector: (r: unknown) => void };
			expect(() => raw.setDatagramReflector(bad)).toThrow(RangeError);
		});
	});
});
```

- [ ] **Step 2: Rebuild the addon and run the test to verify it fails**

Run: `bun run build:native && bun test packages/webtransport/test/native-datagram-reflector.test.ts`
Expected: FAIL, `server.setDatagramReflector is not a function`.

- [ ] **Step 3: Add the N-API method and the close-time clear** in `crates/native/src/server_napi.rs`, next to `send_datagram_mirror`:

```rust
    /// Install, replace, or clear (`null`) this server's datagram reflector.
    ///
    /// The rule is validated here again even though the TypeScript wrapper
    /// already checked it: a raw-addon caller must not be able to hand the
    /// hot path an unchecked offset. Shape errors are `TypeError`, bound
    /// errors `RangeError`, both raised before any state changes. Takes
    /// effect on the next datagram of every session this server owns.
    #[napi(js_name = "setDatagramReflector")]
    pub fn set_datagram_reflector(
        &self,
        rule: Option<crate::datagram_reflector::DatagramReflectorRuleInput>,
    ) -> Result<()> {
        let compiled = match rule {
            None => None,
            Some(input) => match crate::datagram_reflector::compile(&input) {
                Ok(rule) => Some(std::sync::Arc::new(rule)),
                Err(crate::datagram_reflector::RuleError::Shape(message)) => {
                    return Err(napi::Error::new(napi::Status::InvalidArg, format!("TypeError: {message}")));
                }
                Err(crate::datagram_reflector::RuleError::Range(message)) => {
                    return Err(napi::Error::new(napi::Status::InvalidArg, format!("RangeError: {message}")));
                }
            },
        };
        crate::datagram_reflector::set_rule(self.server_id, compiled);
        Ok(())
    }
```

napi-rs surfaces `Err` as a generic `Error`; the TypeScript wrapper (Task 4) maps the `TypeError:` / `RangeError:` prefixes onto the real constructors. For this task's third test, make the wrapper passthrough already do that mapping (see Step 5).

In `close()`, after `crate::rate_limit::cleanup_server_entries(self.server_id);` add:

```rust
            crate::datagram_reflector::clear_owner(self.server_id);
```

- [ ] **Step 4: Add the hook** in `crates/native/src/lib.rs`. Immediately after the size check (`if dgram.len() > lim_dgram.max_datagram_size { ... continue; }`) and before `let sz = dgram.len() as u64;`, insert:

```rust
                                                            if let Some(rule) = crate::datagram_reflector::rule_for(owner_server_id) {
                                                                if rule.matches(&dgram) {
                                                                    let received_at = std::time::Instant::now();
                                                                    m_dgram.datagram_reflect_hits.fetch_add(1, Ordering::Relaxed);
                                                                    let now_ns = crate::datagram_reflector::monotonic_ns();
                                                                    let reply = rule.apply(&dgram, now_ns, 0);
                                                                    let hold = received_at.elapsed();
                                                                    let reply = crate::datagram_reflector::write_hold(&rule, reply, hold.as_nanos().min(u64::MAX as u128) as u64);
                                                                    match conn_dgram.send_datagram(&reply) {
                                                                        Ok(()) => {
                                                                            m_dgram.datagrams_out.fetch_add(1, Ordering::Relaxed);
                                                                            sm_dgram.datagrams_out.fetch_add(1, Ordering::Relaxed);
                                                                            m_dgram.datagram_reflect_sent.fetch_add(1, Ordering::Relaxed);
                                                                        }
                                                                        Err(error) => m_dgram.record_reflect_send_error(
                                                                            crate::datagram_reflector::reason_for(&error),
                                                                        ),
                                                                    }
                                                                    m_dgram.datagram_reflect_hold.observe(hold);
                                                                    continue;
                                                                }
                                                            }
```

`received_at` must be taken at the top of the arm, right after `let dgram = match res { Ok(d) => d, ... }`, not inside the `if`; move the `let received_at = std::time::Instant::now();` line there so the hold covers the rate-limit and size checks too. Then in `crates/native/src/datagram_reflector.rs` add:

```rust
/// Monotonic nanoseconds since the first call in this process. The client
/// never compares this clock with its own; it is written for the peer's
/// one-way estimates and must only be monotonic.
pub fn monotonic_ns() -> u64 {
    static ORIGIN: OnceLock<std::time::Instant> = OnceLock::new();
    let origin = ORIGIN.get_or_init(std::time::Instant::now);
    origin.elapsed().as_nanos().min(u64::MAX as u128) as u64
}

/// Re-run only the `holdNs` ops with the final hold, so the value written is
/// the duration up to the send rather than up to the buffer build.
pub fn write_hold(rule: &CompiledRule, mut reply: Vec<u8>, hold_ns: u64) -> Vec<u8> {
    for op in &rule.ops {
        if let Op::HoldNs { at } = *op {
            reply[at..at + 8].copy_from_slice(&hold_ns.to_le_bytes());
        }
    }
    reply
}

pub fn reason_for(error: &wtransport::error::SendDatagramError) -> crate::server_metrics::ReflectSendErrorReason {
    use crate::server_metrics::ReflectSendErrorReason as R;
    match error {
        wtransport::error::SendDatagramError::NotConnected => R::NotConnected,
        wtransport::error::SendDatagramError::UnsupportedByPeer => R::UnsupportedByPeer,
        wtransport::error::SendDatagramError::TooLarge => R::TooLarge,
    }
}
```

Add a unit test for `write_hold` in the Task 1 test module:

```rust
    #[test]
    fn write_hold_rewrites_only_the_hold_field() {
        let rule = compile(&g6_rule()).expect("valid rule");
        let reply = rule.apply(&action_stamp(1, 2, 3), 5, 0);
        let reply = write_hold(&rule, reply, 77);
        assert_eq!(reply, expected_ack(2, 5, 77, 3));
    }
```

- [ ] **Step 5: Temporary TypeScript passthrough** in `packages/webtransport/src/index.ts`. Interface (after `readMirrorReports`):

```ts
	/**
	 * Install, replace, or clear (`null`) this server's datagram reflector: a
	 * matched datagram is answered in native with a rewritten copy of its
	 * first bytes and never reaches `incomingDatagrams()`. Native-only.
	 */
	setDatagramReflector(rule: DatagramReflectorRule | null): void;
```

Wiring (after the `sendDatagramMirror:` entry):

```ts
		setDatagramReflector: (rule) => {
			try {
				handle.setDatagramReflector(rule === null ? null : toNativeReflectorRule(rule));
			} catch (error) {
				throw mapReflectorError(error);
			}
		},
```

with, near the other helpers in `index.ts` (Task 4 moves these into `datagram-reflector.ts`):

```ts
export type DatagramReflectorRule = {
	minLength: number;
	replyLength: number;
	match: readonly { offset: number; bytes: Uint8Array }[];
	rewrite: readonly ReflectorOp[];
};
export type ReflectorOp =
	| { op: "copy"; from: number; to: number; length: number }
	| { op: "nowNs"; at: number }
	| { op: "holdNs"; at: number }
	| { op: "zero"; at: number; length: number }
	| { op: "set"; at: number; value: number };

function toNativeReflectorRule(rule: DatagramReflectorRule): unknown {
	return {
		minLength: rule.minLength,
		replyLength: rule.replyLength,
		matches: rule.match.map((m) => ({ offset: m.offset, bytes: Array.from(m.bytes) })),
		rewrite: rule.rewrite.map((op) => ({
			op: op.op,
			at: "at" in op ? op.at : undefined,
			from: "from" in op ? op.from : undefined,
			to: "to" in op ? op.to : undefined,
			length: "length" in op ? op.length : undefined,
			value: "value" in op ? op.value : undefined,
		})),
	};
}

function mapReflectorError(error: unknown): unknown {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes("RangeError: ")) return new RangeError(message.slice(message.indexOf("RangeError: ") + 12));
	if (message.includes("TypeError: ")) return new TypeError(message.slice(message.indexOf("TypeError: ") + 11));
	return error;
}
```

- [ ] **Step 6: Rebuild, run the integration test and the Rust tests**

Run: `cargo test -p native --lib datagram_reflector && bun run build:native && bun test packages/webtransport/test/native-datagram-reflector.test.ts`
Expected: 7 Rust tests pass; 3 JS tests pass.

- [ ] **Step 7: Run the neighbouring suites to prove the ordinary path is untouched**

Run: `bun test packages/webtransport/test/native-datagram-mirror.test.ts packages/webtransport/test/native-datagram-mirror-paced.test.ts`
Expected: all pass with the same counts as before this task.

- [ ] **Step 8: Commit**

```bash
cargo fmt --all && bunx biome format --write packages/webtransport/src/index.ts packages/webtransport/test/native-datagram-reflector.test.ts
git add crates/native/src/lib.rs crates/native/src/server_napi.rs crates/native/src/datagram_reflector.rs packages/webtransport/src/index.ts packages/webtransport/test/native-datagram-reflector.test.ts
git commit -m "Reflect matched datagrams on the connection's forward task

Inline after the size check and before queued-byte reservation: a match
is answered on the same connection with the non-blocking send, counted,
and never queued to JS. Send errors are counted and dropped; the receive
task never parks. Exposed as setDatagramReflector on the native server.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: TypeScript validation, reference implementation, portable exclusion, parity row

**Files:**
- Create: `packages/webtransport/src/datagram-reflector.ts`
- Create: `packages/webtransport/test/datagram-reflector.test.ts`
- Modify: `packages/webtransport/src/index.ts` (move the Task 3 helpers into the new module; wire `datagramReflectorRuleChecked`; export types)
- Modify: `packages/webtransport/test/public-surface-contract.test.ts` (type assertions ~line 150-176; runtime bag ~line 296-302)
- Modify: `docs/PARITY_MATRIX.md` (section 3, after the paced-mirror row ~line 171)

**Interfaces:**
- Produces: `datagramReflectorRuleChecked(install: (native: unknown) => void, rule: DatagramReflectorRule | null): void`, `applyDatagramReflectorRule(datagram: Uint8Array, rule: DatagramReflectorRule, nowNs: bigint, holdNs: bigint): Uint8Array | null` (returns `null` when the rule does not match), `REFLECTOR_MAX_REPLY_LENGTH = 1200`, `REFLECTOR_MAX_MATCHES = 8`, `REFLECTOR_MAX_OPS = 16`, plus `toNativeReflectorRule` and `mapReflectorError` moved from Task 3.

- [ ] **Step 1: Write the failing unit tests** in `packages/webtransport/test/datagram-reflector.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
	applyDatagramReflectorRule,
	datagramReflectorRuleChecked,
	REFLECTOR_MAX_OPS,
} from "../src/datagram-reflector.js";
import type { DatagramReflectorRule } from "../src/datagram-reflector.js";

const G6_RULE: DatagramReflectorRule = {
	minLength: 48,
	replyLength: 48,
	match: [
		{ offset: 0, bytes: new Uint8Array([0x54, 0x4c]) },
		{ offset: 2, bytes: new Uint8Array([3, 0]) },
		{ offset: 44, bytes: new Uint8Array([1]) },
	],
	rewrite: [
		{ op: "copy", from: 12, to: 28, length: 8 },
		{ op: "zero", at: 4, length: 8 },
		{ op: "nowNs", at: 12 },
		{ op: "holdNs", at: 36 },
		{ op: "set", at: 44, value: 2 },
	],
};

function stamp(actual: bigint, sequence: bigint): Uint8Array {
	const bytes = new Uint8Array(64);
	const view = new DataView(bytes.buffer);
	view.setUint16(0, 0x4c54, true);
	view.setUint16(2, 3, true);
	view.setBigUint64(4, 7n, true);
	view.setBigUint64(12, actual, true);
	view.setBigUint64(20, sequence, true);
	bytes[44] = 1;
	return bytes;
}

describe("datagram reflector rule validation", () => {
	it("accepts the G6 rule and forwards a native-shaped object", () => {
		const seen: unknown[] = [];
		datagramReflectorRuleChecked((native) => seen.push(native), G6_RULE);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ minLength: 48, replyLength: 48 });
		datagramReflectorRuleChecked((native) => seen.push(native), null);
		expect(seen[1]).toBeNull();
	});

	it("throws TypeError for shape errors before calling native", () => {
		const install = () => {
			throw new Error("must not be called");
		};
		expect(() => datagramReflectorRuleChecked(install, {} as never)).toThrow(TypeError);
		expect(() =>
			datagramReflectorRuleChecked(install, { ...G6_RULE, match: [] }),
		).toThrow(TypeError);
		expect(() =>
			datagramReflectorRuleChecked(install, {
				...G6_RULE,
				rewrite: [{ op: "xor", at: 0 } as never],
			}),
		).toThrow(TypeError);
		expect(() =>
			datagramReflectorRuleChecked(install, {
				...G6_RULE,
				rewrite: Array.from({ length: REFLECTOR_MAX_OPS + 1 }, () => ({ op: "set", at: 0, value: 0 }) as const),
			}),
		).toThrow(TypeError);
	});

	it("throws RangeError for bound errors before calling native", () => {
		const install = () => {
			throw new Error("must not be called");
		};
		expect(() =>
			datagramReflectorRuleChecked(install, { ...G6_RULE, replyLength: 49 }),
		).toThrow(RangeError);
		expect(() =>
			datagramReflectorRuleChecked(install, { ...G6_RULE, rewrite: [{ op: "nowNs", at: 41 }] }),
		).toThrow(RangeError);
		expect(() =>
			datagramReflectorRuleChecked(install, {
				...G6_RULE,
				match: [{ offset: 47, bytes: new Uint8Array([1, 2]) }],
			}),
		).toThrow(RangeError);
		expect(() =>
			datagramReflectorRuleChecked(install, { ...G6_RULE, rewrite: [{ op: "set", at: 0, value: 256 }] }),
		).toThrow(RangeError);
		expect(() =>
			datagramReflectorRuleChecked(install, { ...G6_RULE, minLength: 1201, replyLength: 1201 }),
		).toThrow(RangeError);
	});
});

describe("reference reflector semantics", () => {
	it("reproduces writeReflection for the G6 rule", () => {
		const reply = applyDatagramReflectorRule(stamp(123n, 9n), G6_RULE, 500n, 40n);
		expect(reply).not.toBeNull();
		const view = new DataView(reply!.buffer, reply!.byteOffset);
		expect(reply!.byteLength).toBe(48);
		expect(view.getUint16(0, true)).toBe(0x4c54);
		expect(view.getBigUint64(4, true)).toBe(0n);
		expect(view.getBigUint64(12, true)).toBe(500n);
		expect(view.getBigUint64(20, true)).toBe(9n);
		expect(view.getBigUint64(28, true)).toBe(123n);
		expect(view.getBigUint64(36, true)).toBe(40n);
		expect(reply![44]).toBe(2);
	});

	it("returns null for a non-matching datagram", () => {
		const other = stamp(1n, 2n);
		other[44] = 3;
		expect(applyDatagramReflectorRule(other, G6_RULE, 0n, 0n)).toBeNull();
		expect(applyDatagramReflectorRule(new Uint8Array(10), G6_RULE, 0n, 0n)).toBeNull();
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/webtransport/test/datagram-reflector.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `packages/webtransport/src/datagram-reflector.ts`**

```ts
/**
 * The per-server datagram reflector's rule: what a datagram must look like
 * to be answered in native, and how the answer is built from its bytes.
 *
 * Everything here is the TypeScript half of a double validation. Native
 * re-checks the same bounds, so a raw-addon caller cannot hand the hot path an
 * unchecked offset; this half exists so a programming error throws with a
 * useful message before anything crosses N-API.
 */

export const REFLECTOR_MAX_REPLY_LENGTH = 1200;
export const REFLECTOR_MAX_MATCHES = 8;
export const REFLECTOR_MAX_OPS = 16;

export type ReflectorMatch = { offset: number; bytes: Uint8Array };

export type ReflectorOp =
	| { op: "copy"; from: number; to: number; length: number }
	| { op: "nowNs"; at: number }
	| { op: "holdNs"; at: number }
	| { op: "zero"; at: number; length: number }
	| { op: "set"; at: number; value: number };

export type DatagramReflectorRule = {
	/** Datagrams shorter than this never match. */
	minLength: number;
	/** The reply is the datagram's first `replyLength` bytes, then the ops. */
	replyLength: number;
	/** Every range must equal for the datagram to match. */
	match: readonly ReflectorMatch[];
	/** Applied in order to the reply buffer. All integers little-endian. */
	rewrite: readonly ReflectorOp[];
};

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requireRange(label: string, start: number, length: number, bound: number): void {
	if (!isNonNegativeInteger(start) || !isNonNegativeInteger(length)) {
		throw new TypeError(`setDatagramReflector: ${label} offsets must be non-negative integers`);
	}
	if (length < 1) throw new RangeError(`setDatagramReflector: ${label} length must be at least 1`);
	if (start + length > bound) {
		throw new RangeError(`setDatagramReflector: ${label} range ${start}..${start + length} exceeds ${bound}`);
	}
}

/** Validate a rule; throws TypeError (shape) or RangeError (bounds). */
export function validateDatagramReflectorRule(rule: DatagramReflectorRule): void {
	if (typeof rule !== "object" || rule === null) {
		throw new TypeError("setDatagramReflector expects a rule object or null");
	}
	if (!isNonNegativeInteger(rule.minLength) || !isNonNegativeInteger(rule.replyLength)) {
		throw new TypeError("setDatagramReflector: minLength and replyLength must be non-negative integers");
	}
	if (rule.replyLength < 1) throw new RangeError("setDatagramReflector: replyLength must be at least 1");
	if (rule.replyLength > rule.minLength) {
		throw new RangeError("setDatagramReflector: replyLength must not exceed minLength");
	}
	if (rule.minLength > REFLECTOR_MAX_REPLY_LENGTH) {
		throw new RangeError(`setDatagramReflector: minLength must not exceed ${REFLECTOR_MAX_REPLY_LENGTH}`);
	}
	if (!Array.isArray(rule.match) || rule.match.length < 1 || rule.match.length > REFLECTOR_MAX_MATCHES) {
		throw new TypeError(`setDatagramReflector: match needs 1..${REFLECTOR_MAX_MATCHES} entries`);
	}
	for (const m of rule.match) {
		if (!ArrayBuffer.isView(m?.bytes)) throw new TypeError("setDatagramReflector: match.bytes must be a Uint8Array");
		requireRange("match", m.offset, m.bytes.byteLength, rule.minLength);
	}
	if (!Array.isArray(rule.rewrite) || rule.rewrite.length > REFLECTOR_MAX_OPS) {
		throw new TypeError(`setDatagramReflector: rewrite allows at most ${REFLECTOR_MAX_OPS} ops`);
	}
	for (const op of rule.rewrite) {
		switch (op?.op) {
			case "copy":
				requireRange("copy.from", op.from, op.length, rule.replyLength);
				requireRange("copy.to", op.to, op.length, rule.replyLength);
				break;
			case "nowNs":
			case "holdNs":
				requireRange(op.op, op.at, 8, rule.replyLength);
				break;
			case "zero":
				requireRange("zero", op.at, op.length, rule.replyLength);
				break;
			case "set":
				if (!isNonNegativeInteger(op.value)) throw new TypeError("setDatagramReflector: set.value must be an integer");
				if (op.value > 255) throw new RangeError("setDatagramReflector: set.value must be 0..255");
				requireRange("set", op.at, 1, rule.replyLength);
				break;
			default:
				throw new TypeError(`setDatagramReflector: unknown op ${String((op as { op?: unknown })?.op)}`);
		}
	}
}

/** The object shape the native `setDatagramReflector` binding takes. */
export function toNativeReflectorRule(rule: DatagramReflectorRule): unknown {
	return {
		minLength: rule.minLength,
		replyLength: rule.replyLength,
		matches: rule.match.map((m) => ({ offset: m.offset, bytes: Array.from(m.bytes) })),
		rewrite: rule.rewrite.map((op) => ({
			op: op.op,
			at: "at" in op ? op.at : undefined,
			from: "from" in op ? op.from : undefined,
			to: "to" in op ? op.to : undefined,
			length: "length" in op ? op.length : undefined,
			value: "value" in op ? op.value : undefined,
		})),
	};
}

/** Native raises its re-validation as a message-prefixed error; restore the constructor. */
export function mapReflectorError(error: unknown): unknown {
	const message = error instanceof Error ? error.message : String(error);
	const range = message.indexOf("RangeError: ");
	if (range !== -1) return new RangeError(message.slice(range + 12));
	const type = message.indexOf("TypeError: ");
	if (type !== -1) return new TypeError(message.slice(type + 11));
	return error;
}

/** Validate, convert, and install. `null` clears. Never throws for a transport condition. */
export function datagramReflectorRuleChecked(
	install: (native: unknown) => void,
	rule: DatagramReflectorRule | null,
): void {
	if (rule === null) {
		install(null);
		return;
	}
	validateDatagramReflectorRule(rule);
	try {
		install(toNativeReflectorRule(rule));
	} catch (error) {
		throw mapReflectorError(error);
	}
}

/**
 * Reference semantics of the native hot path, in TypeScript. Used by tests
 * and by harnesses that want to know what a rule would produce; it is not on
 * any send or receive path.
 */
export function applyDatagramReflectorRule(
	datagram: Uint8Array,
	rule: DatagramReflectorRule,
	nowNs: bigint,
	holdNs: bigint,
): Uint8Array | null {
	if (datagram.byteLength < rule.minLength) return null;
	for (const m of rule.match) {
		for (let i = 0; i < m.bytes.byteLength; i += 1) {
			if (datagram[m.offset + i] !== m.bytes[i]) return null;
		}
	}
	const reply = datagram.slice(0, rule.replyLength);
	const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
	for (const op of rule.rewrite) {
		switch (op.op) {
			case "copy":
				reply.copyWithin(op.to, op.from, op.from + op.length);
				break;
			case "nowNs":
				view.setBigUint64(op.at, nowNs, true);
				break;
			case "holdNs":
				view.setBigUint64(op.at, holdNs, true);
				break;
			case "zero":
				reply.fill(0, op.at, op.at + op.length);
				break;
			case "set":
				reply[op.at] = op.value;
				break;
		}
	}
	return reply;
}
```

- [ ] **Step 4: Wire it in `index.ts`**: delete the Task 3 inline helpers and types, `import { datagramReflectorRuleChecked, type DatagramReflectorRule } from "./datagram-reflector.js"`, re-export the types (`export type { DatagramReflectorRule, ReflectorOp, ReflectorMatch } from "./datagram-reflector.js";`), and replace the wiring with:

```ts
		setDatagramReflector: (rule) =>
			datagramReflectorRuleChecked(
				(native) => handle.setDatagramReflector(native as never),
				rule,
			),
```

- [ ] **Step 5: Portable exclusion** in `packages/webtransport/test/public-surface-contract.test.ts`. Next to the paced-mirror assertions add:

```ts
type _AssertNoReflectorOnPortable = Assert<
	Not<Extends<PortableServer, { setDatagramReflector(rule: unknown): unknown }>>
>;
type _AssertReflectorOnNative = Assert<
	Extends<rootSurface.WebTransportServer, { setDatagramReflector(rule: unknown): void }>
>;
```

and in `assertServerContract` add `expect(bag.setDatagramReflector).toBeUndefined();`. Confirm `PortableServer` in `packages/webtransport/src/portable.ts` does not list the method (it must not).

- [ ] **Step 6: Parity row** in `docs/PARITY_MATRIX.md` after the paced-mirror row:

```markdown
| `WebTransportServer.setDatagramReflector(rule \| null)` — answer matching datagrams in native under a per-server byte rule, never delivering them to JS | Native root surface | **Deliberate non-goal on wasm.** The API's entire content is removing the Node-API crossing for a request/reply pair, which wasm does not have, and the reflection runs on the native per-connection receive task, which the wasm backend has no counterpart for. Consumed-not-delivered is the contract: a portable version would be a JS handler wearing a server method's name | `packages/webtransport/test/native-datagram-reflector.test.ts` (reply bytes, non-delivery, non-match passthrough, clear, metrics, native re-validation); `packages/webtransport/test/datagram-reflector.test.ts` (validator, reference semantics); `packages/webtransport/test/public-surface-contract.test.ts` (absent from `PortableServer` at compile time and at runtime) |
```

- [ ] **Step 7: Run tests, typecheck, biome**

Run: `bun run build:native && bun test packages/webtransport/test/datagram-reflector.test.ts packages/webtransport/test/native-datagram-reflector.test.ts packages/webtransport/test/public-surface-contract.test.ts && bun run typecheck && bunx biome check packages/webtransport/src/datagram-reflector.ts packages/webtransport/src/index.ts packages/webtransport/test/datagram-reflector.test.ts packages/webtransport/test/native-datagram-reflector.test.ts packages/webtransport/test/public-surface-contract.test.ts`
Expected: all pass; tsc clean; biome clean.

- [ ] **Step 8: Commit**

```bash
git add packages/webtransport/src/datagram-reflector.ts packages/webtransport/src/index.ts packages/webtransport/test/datagram-reflector.test.ts packages/webtransport/test/public-surface-contract.test.ts docs/PARITY_MATRIX.md
git commit -m "Validate reflector rules in TypeScript and keep the reflector off the portable surface

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: G6 wiring and boundary reconciliation

**Files:**
- Create: `tools/load/g6-ack-reflector-rule.ts`
- Modify: `tools/load/g6-server-core.ts` (add `reconcileReflectorCounters` and the `ReflectorCounters` type; export both)
- Modify: `tools/load/g6-shard-server.ts` (`--ack-reflector` arg ~line 67; rule install after `createServer` ~line 124; `boundary()` ~line 146-176; ready message ~line 203-208)
- Modify: `tools/load/g6-sharded-scan.ts` (`SCAN_ACK_REFLECTOR` constant near line 106; spawn args ~line 739; ready check ~line 817; rated `config` ~line 1349; diagnostic `dispatch` ~line 1318)
- Test: `tools/load/g6-server-core.test.ts` (exists? if not, create), `tools/load/g6-sharded-scan-source.test.ts`, `tools/load/g6-shard-server-source.test.ts`

**Interfaces:**
- Produces: `export const G6_V3_ACK_REFLECTOR_RULE: DatagramReflectorRule`; `export type AckReflectorMode = "js" | "native"`; `export function resolveAckReflectorMode(value: string | undefined): AckReflectorMode` (throws on anything but `js`/`native`/undefined); `export type ReflectorCounters = { hits: number; sent: number; sendErrors: number }`; `export function reconcileReflectorCounters(state: ServerState, previous: ReflectorCounters, current: ReflectorCounters): ReflectorCounters` (applies the deltas to `state`, returns `current`).
- Rated output gains `config.ackReflector: "js" | "native"`; the shard ready message gains `ackReflector`.

- [ ] **Step 1: Write the failing tests**

`tools/load/g6-ack-reflector-rule.test.ts` (create):

```ts
import { describe, expect, test } from "bun:test";
import { applyDatagramReflectorRule } from "../../packages/webtransport/src/datagram-reflector.ts";
import {
	G6_V3_ACK_REFLECTOR_RULE,
	resolveAckReflectorMode,
} from "./g6-ack-reflector-rule.ts";
import {
	CLASS_ACK,
	CLASS_ACTION,
	decodeStamp,
	encodeStamp,
	STAMP_BYTES_V3,
	writeReflection,
} from "./latency-stamp.ts";

describe("G6 v3 ack reflector rule", () => {
	test("reproduces writeReflection byte for byte", () => {
		const datagram = new Uint8Array(64);
		encodeStamp(datagram, {
			version: 3,
			intendedNs: 111,
			actualNs: 222_333,
			sequence: 44,
			klass: CLASS_ACTION,
		});
		const expected = new Uint8Array(STAMP_BYTES_V3);
		expected.set(datagram.subarray(0, STAMP_BYTES_V3));
		expect(
			writeReflection(expected, {
				echoActualNs: 222_333,
				serverSendNs: 999_000,
				holdNs: 5_000,
				klass: CLASS_ACK,
				sequence: 44,
			}),
		).toBe(true);
		const reply = applyDatagramReflectorRule(datagram, G6_V3_ACK_REFLECTOR_RULE, 999_000n, 5_000n);
		expect(reply).not.toBeNull();
		expect(Array.from(reply as Uint8Array)).toEqual(Array.from(expected));
		const stamp = decodeStamp(reply as Uint8Array);
		expect(stamp?.klass).toBe(CLASS_ACK);
		expect(stamp?.echoActualNs).toBe(222_333);
		expect(stamp?.holdNs).toBe(5_000);
	});

	test("does not match snapshots, acks, or version-2 stamps", () => {
		for (const [version, klass] of [
			[3, 3],
			[3, 2],
			[2, CLASS_ACTION],
		] as const) {
			const datagram = new Uint8Array(64);
			encodeStamp(datagram, { version, intendedNs: 1, actualNs: 2, sequence: 3, klass });
			expect(applyDatagramReflectorRule(datagram, G6_V3_ACK_REFLECTOR_RULE, 0n, 0n)).toBeNull();
		}
	});

	test("resolves the mode strictly", () => {
		expect(resolveAckReflectorMode(undefined)).toBe("js");
		expect(resolveAckReflectorMode("js")).toBe("js");
		expect(resolveAckReflectorMode("native")).toBe("native");
		expect(() => resolveAckReflectorMode("yes")).toThrow(/SCAN_ACK_REFLECTOR/);
	});
});
```

Add to `tools/load/g6-server-core.test.ts` (create the file if it does not exist, importing `freshG6ServerState` and `reconcileReflectorCounters` from `./g6-server-core.ts`):

```ts
	test("reconciles native reflector deltas into rxTotal and the emitter counters", () => {
		const state = freshG6ServerState();
		state.rxTotal = 10;
		const first = reconcileReflectorCounters(state, { hits: 0, sent: 0, sendErrors: 0 }, { hits: 5, sent: 4, sendErrors: 1 });
		expect(state.rxTotal).toBe(15);
		expect(state.emitter.ackDue).toBe(5);
		expect(state.emitter.ackIssued).toBe(4);
		expect(state.emitter.sendErrors).toBe(1);
		reconcileReflectorCounters(state, first, { hits: 7, sent: 6, sendErrors: 1 });
		expect(state.rxTotal).toBe(17);
		expect(state.emitter.ackDue).toBe(7);
		expect(state.emitter.ackIssued).toBe(6);
		expect(state.emitter.sendErrors).toBe(1);
	});
```

Add to `tools/load/g6-sharded-scan-source.test.ts`:

```ts
	test("plumbs the ack reflector mode from SCAN_ACK_REFLECTOR into the shard spawn, the ready check, and the rated config", () => {
		expect(source).toContain('resolveAckReflectorMode(process.env.SCAN_ACK_REFLECTOR)');
		expect(source).toContain('"--ack-reflector",\n\t\t\t\tACK_REFLECTOR,');
		expect(source).toContain("msg.ackReflector !== ACK_REFLECTOR");
		const resultStart = source.indexOf("const result = {");
		const ratedOutput = source.slice(resultStart, source.indexOf("writeFileSync(OUT", resultStart));
		expect(ratedOutput).toContain("ackReflector: ACK_REFLECTOR,");
	});
```

Add to `tools/load/g6-shard-server-source.test.ts` (read it first to match its `source` helper):

```ts
	test("installs the G6 reflector rule only in native mode and reconciles its counters at every boundary", () => {
		expect(source).toContain('const ackReflector = resolveAckReflectorMode(requireArg("ack-reflector"));');
		expect(source).toContain('if (ackReflector === "native") server.setDatagramReflector(G6_V3_ACK_REFLECTOR_RULE);');
		expect(source).toContain("reflectorCounters = reconcileReflectorCounters(");
		expect(source).toContain("ackReflector,\n");
	});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tools/load/g6-ack-reflector-rule.test.ts tools/load/g6-server-core.test.ts tools/load/g6-sharded-scan-source.test.ts tools/load/g6-shard-server-source.test.ts`
Expected: FAIL (module not found; missing exports; source contracts unmet).

- [ ] **Step 3: Implement**

`tools/load/g6-ack-reflector-rule.ts`:

```ts
import type { DatagramReflectorRule } from "../../packages/webtransport/src/datagram-reflector.ts";
import {
	CLASS_ACK,
	CLASS_ACTION,
	OFFSET_ACTUAL,
	OFFSET_CLASS,
	OFFSET_ECHO_ACTUAL,
	OFFSET_HOLD,
	OFFSET_INTENDED,
	OFFSET_MAGIC,
	OFFSET_VERSION,
	STAMP_BYTES_V3,
	STAMP_MAGIC,
} from "./latency-stamp.ts";

export type AckReflectorMode = "js" | "native";

/** `SCAN_ACK_REFLECTOR`: `js` (default, every existing profile) or `native`. */
export function resolveAckReflectorMode(value: string | undefined): AckReflectorMode {
	if (value === undefined || value === "js") return "js";
	if (value === "native") return "native";
	throw new Error(`SCAN_ACK_REFLECTOR must be js or native, got ${JSON.stringify(value)}`);
}

/**
 * The version-3 action stamp reflected into an ack, exactly as
 * `writeReflection` in latency-stamp.ts does it: client actual moves into
 * echoActual, intended is zeroed, actual becomes the server send instant,
 * hold is the receive-to-reflection duration, class becomes ACK, sequence
 * stays. The copy is listed before the write that overwrites its source.
 */
export const G6_V3_ACK_REFLECTOR_RULE: DatagramReflectorRule = {
	minLength: STAMP_BYTES_V3,
	replyLength: STAMP_BYTES_V3,
	match: [
		{ offset: OFFSET_MAGIC, bytes: new Uint8Array([STAMP_MAGIC & 0xff, STAMP_MAGIC >> 8]) },
		{ offset: OFFSET_VERSION, bytes: new Uint8Array([3, 0]) },
		{ offset: OFFSET_CLASS, bytes: new Uint8Array([CLASS_ACTION]) },
	],
	rewrite: [
		{ op: "copy", from: OFFSET_ACTUAL, to: OFFSET_ECHO_ACTUAL, length: 8 },
		{ op: "zero", at: OFFSET_INTENDED, length: 8 },
		{ op: "nowNs", at: OFFSET_ACTUAL },
		{ op: "holdNs", at: OFFSET_HOLD },
		{ op: "set", at: OFFSET_CLASS, value: CLASS_ACK },
	],
};
```

`tools/load/g6-server-core.ts` (append, exported):

```ts
export type ReflectorCounters = { hits: number; sent: number; sendErrors: number };

/**
 * Fold the native reflector's cumulative counters into the JS-side state at a
 * boundary, so rxTotal, ackDue, ackIssued and sendErrors keep their meaning
 * when actions never reach this loop. Returns `current` for the next call.
 */
export function reconcileReflectorCounters(
	state: ServerState,
	previous: ReflectorCounters,
	current: ReflectorCounters,
): ReflectorCounters {
	const hits = current.hits - previous.hits;
	const sent = current.sent - previous.sent;
	const sendErrors = current.sendErrors - previous.sendErrors;
	state.rxTotal += hits;
	state.emitter.ackDue += hits;
	state.emitter.ackIssued += sent;
	state.emitter.sendErrors += sendErrors;
	return current;
}
```

`tools/load/g6-shard-server.ts`:

```ts
// with the other arg parsing (after emitterMode):
	const ackReflector = resolveAckReflectorMode(requireArg("ack-reflector"));
// right after createServer(...) returns `server`:
	if (ackReflector === "native") server.setDatagramReflector(G6_V3_ACK_REFLECTOR_RULE);
	let reflectorCounters: ReflectorCounters = { hits: 0, sent: 0, sendErrors: 0 };
// inside boundary(), before building the object:
	const metrics = server.metricsSnapshot();
	reflectorCounters = reconcileReflectorCounters(state, reflectorCounters, {
		hits: metrics.datagramReflectHits ?? 0,
		sent: metrics.datagramReflectSent ?? 0,
		sendErrors: metrics.datagramReflectSendErrors ?? 0,
	});
// and use `metrics` for the `metrics: { ...metrics, g6SessionKinds: ... }` spread instead of calling metricsSnapshot() twice.
// ready message: add `ackReflector,` after `emitterMode,`.
```

Imports: `import { G6_V3_ACK_REFLECTOR_RULE, resolveAckReflectorMode } from "./g6-ack-reflector-rule.ts";` and `reconcileReflectorCounters, type ReflectorCounters` from `./g6-server-core.ts`.

`tools/load/g6-sharded-scan.ts`: `const ACK_REFLECTOR = resolveAckReflectorMode(process.env.SCAN_ACK_REFLECTOR);` next to `G6_EMITTER_MODE`; spawn args after `"--emitter-mode", G6_EMITTER_MODE,` add `"--ack-reflector", ACK_REFLECTOR,`; in the ready handler after the emitterMode check add the same shape: `if (msg.ackReflector !== ACK_REFLECTOR) { failShard(new Error(\`shard ${i} ackReflector ${msg.ackReflector ?? "missing"} != ${ACK_REFLECTOR}\`)); child.kill("SIGTERM"); return; }`; rated `config` gains `ackReflector: ACK_REFLECTOR,` after `emitterMode`; diagnostic `dispatch` gains the same.

- [ ] **Step 4: Run the tests**

Run: `bun test tools/load/g6-ack-reflector-rule.test.ts tools/load/g6-server-core.test.ts tools/load/g6-sharded-scan-source.test.ts tools/load/g6-shard-server-source.test.ts && bun run typecheck`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
bunx biome format --write tools/load/g6-ack-reflector-rule.ts tools/load/g6-ack-reflector-rule.test.ts tools/load/g6-server-core.ts tools/load/g6-server-core.test.ts tools/load/g6-shard-server.ts tools/load/g6-sharded-scan.ts tools/load/g6-sharded-scan-source.test.ts tools/load/g6-shard-server-source.test.ts
git add <the same files>
git commit -m "Let the G6 shard reflect acks natively and reconcile the counters at every boundary

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Registered-profile enforcement in the evaluator, grader, controller, and ladder profile

**Files:**
- Modify: `tools/load/g6-c32-rca-evaluate.ts` (request type ~line 26-34; scan config checks ~line 108-121; CLI parse ~line 1456)
- Modify: `tools/load/g6-c32-successor-grade.ts` (`Profile` ~line 10-16; checks ~line 73-90; CLI ~line 192-204)
- Modify: `tools/load/g6-c32-rca-controller.sh` (`verify_ladder_profile` ~line 868-878; `run_cell_once` scan env ~line 747 and evaluator args ~line 754-765; `run_ladder_rung` and the companion ~line 990-1013; `run_winner` ~line 880-890)
- Modify: `tools/load/g6-c32-ladder-profile.json`
- Tests: `tools/load/g6-c32-rca-evaluate.test.ts`, `tools/load/g6-c32-successor-grade.test.ts`, `tools/load/g6-c32-rca-controller.test.ts`

**Interfaces:**
- Consumes: rated `config.ackReflector` from Task 5.
- Produces: `--expected-ack-reflector js|native` on both CLIs; evaluator `request.expectedAckReflector: "js" | "native"`; grader `profile.ackReflector: "js" | "native"`; ladder profile key `profile.ackReflector`; controller reads it with `read_winner_field profile.ackReflector` and sets `SCAN_ACK_REFLECTOR` in the scan env.

- [ ] **Step 1: Write the failing tests.** In the evaluator and grader test files, find the existing fixture helper that builds a scan (`grep -n "connectRatePerSec" tools/load/g6-c32-rca-evaluate.test.ts tools/load/g6-c32-successor-grade.test.ts`) and add one test each:

```ts
	test("fails closed when the scan's ackReflector differs from the registered expectation", () => {
		const request = fixtureRequest(); // the file's existing builder
		request.scan.config.ackReflector = "native";
		request.expectedAckReflector = "js";
		const decision = evaluateCell(request); // or gradeSuccessorRung for the grader
		expect(decision.valid).toBe(false);
		expect(decision.invalidReasons ?? decision.reasons).toContain("scan ackReflector differs from registered cell");
	});
	test("treats a scan without ackReflector as js", () => {
		const request = fixtureRequest();
		delete request.scan.config.ackReflector;
		request.expectedAckReflector = "js";
		expect(evaluateCell(request).valid).toBe(true);
	});
```

Adjust names to the file's actual builder and entry function (`evaluateCell` / `gradeSuccessorRung`) and the grader's message `"scan ackReflector differs from registered profile"`. In `tools/load/g6-c32-rca-controller.test.ts`, extend the ordering test:

```ts
		expect(script).toContain('for (const key of ["endpoints","connectConcurrency","connectRatePerSec","receiveBufferBytes","gradeMode","ackReflector"])');
		expect(script).toContain('ack_reflector=$(read_winner_field profile.ackReflector');
		expect(script).toContain("SCAN_ACK_REFLECTOR=$ack_reflector");
		expect(script).toContain('--expected-ack-reflector "$ack_reflector"');
```

and in the both-hosts executed harness add `ack_reflector=native` to the harness prelude and assert `operations` contains `SCAN_ACK_REFLECTOR=native` on the scan line.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tools/load/g6-c32-rca-evaluate.test.ts tools/load/g6-c32-successor-grade.test.ts tools/load/g6-c32-rca-controller.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** Evaluator: add `expectedAckReflector: "js" | "native";` to the request type; after the `fixedSourcePortBase` check add

```ts
	if ((scanConfig.ackReflector ?? "js") !== request.expectedAckReflector)
		reasons.push("scan ackReflector differs from registered cell");
```

and parse `--expected-ack-reflector` in the CLI with `resolveAckReflectorMode(arg("expected-ack-reflector") ?? undefined)`. Grader: `ackReflector: AckReflectorMode` on `Profile`; check `if ((scan.config.ackReflector ?? "js") !== profile.ackReflector) reasons.push("scan ackReflector differs from registered profile");`; CLI `ackReflector: resolveAckReflectorMode(arg("expected-ack-reflector") ?? undefined)`. Extend the grader's `RungScan.config` type in `tools/load/g6-sharded-grade.ts` with `ackReflector?: string;`.

Controller: `verify_ladder_profile` key list gains `"ackReflector"`; `run_cell_once` gains a `local ack_reflector` parameter read from the profile by its callers (`run_ladder_rung`, the companion runner, and `run_winner` each add `ack_reflector=$(read_winner_field profile.ackReflector "$root/winner-ack-reflector")` and pass it), the scan env string gains `SCAN_ACK_REFLECTOR=$ack_reflector`, and every evaluator and successor-grader invocation gains `--expected-ack-reflector "$ack_reflector"`. The probe/matrix cells that call `run_cell` with literal arguments pass `js` explicitly.

`tools/load/g6-c32-ladder-profile.json`: add `"ackReflector": "native"` to `profile` and append to `provenance.note`: `" ackReflector native added 2026-09-02 under the S4 native-path amendment: acks are reflected in the native crate, never through the shard's JS loop."`

- [ ] **Step 4: Run tests and the full campaign suite**

Run: `bun test tools/load/g6-c32-rca-evaluate.test.ts tools/load/g6-c32-successor-grade.test.ts tools/load/g6-c32-rca-controller.test.ts && bash -n tools/load/g6-c32-rca-controller.sh && FILES=$(bun -e 'import {G6_C32_GATE_CATALOG} from "./tools/load/g6-c32-gates.ts"; console.log(G6_C32_GATE_CATALOG.gates[0].args.filter(a=>a.endsWith(".test.ts")).join(" "))'); bun test ${=FILES}`
Expected: PASS everywhere (zsh: `${=FILES}` splits the list).

- [ ] **Step 5: Commit**

```bash
git add tools/load/g6-c32-rca-evaluate.ts tools/load/g6-c32-successor-grade.ts tools/load/g6-sharded-grade.ts tools/load/g6-c32-rca-controller.sh tools/load/g6-c32-ladder-profile.json tools/load/g6-c32-rca-evaluate.test.ts tools/load/g6-c32-successor-grade.test.ts tools/load/g6-c32-rca-controller.test.ts
git commit -m "Register the ack reflector mode and fail closed on any mismatch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Registration amendment and producer-identity table

**Files:**
- Modify: `.scratch/bare-metal-campaign/registrations/g6-c32-rca-closure-01.md` (ladder section after line 212; producer identity table lines 69-78)

- [ ] **Step 1: Append the amendment** after the companion paragraph of "Transfer, ladder, and companion requirements":

```markdown
Amendment (2026-09-02, from the run after r83 onward): the action ack is
reflected inside the native crate under the per-server datagram reflector
rule `G6_V3_ACK_REFLECTOR_RULE` and never traverses the shard's JS loop.
`S4` measures the client-observed round trip of that native reflection.
Reflected actions are counted toward `S1` through the native reflector
counters folded into `rxTotal` at every boundary; `ackDue`, `ackIssued` and
`sendErrors` reconcile the same way. The registered profile records
`ackReflector: native` and the evaluator and successor grader fail closed on
any other value. Rungs graded under this amendment are not comparable with
r75–r83 on `S4`, which measured the JS-loop path.
```

- [ ] **Step 2: Refresh the producer-identity table** for every listed file that changed (`tools/load/g6-sharded-scan.ts`, `tools/load/g6-c32-rca-evaluate.ts`, `tools/load/g6-c32-successor-grade.ts`, `tools/load/g6-sharded-grade.ts`):

```bash
for f in tools/load/g6-sharded-scan.ts tools/load/g6-sharded-diagnostic.ts tools/load/g6-linux-probe.ts tools/load/g6-c32-rca-evaluate.ts tools/load/g6-c32-successor-grade.ts tools/load/g6-sharded-grade.ts tools/offbox/linux-generator-entry-g6.sh tools/load/g6-shard-bpf-setup.sh; do printf "%s %s\n" "$(git show HEAD:$f | shasum -a 256 | cut -c1-64)" "$f"; done
```

and write each digest into its table row; update the refresh note's candidate to the Task 6 commit.

- [ ] **Step 3: Prove the table binds** with a dry freeze into an in-repo scratch path (the freeze refuses `--out` outside the repository), then delete it:

```bash
OUT=.scratch/bare-metal-campaign/freezes/pincheck-reflector.semantic.json
bun tools/load/g6-c32-freeze.ts semantic --run-id g6-c32-rca-fix-01-r83 --plan .scratch/bare-metal-campaign/plans/g6-c32-rca-closure-and-high-load-proof.md --controller tools/load/g6-c32-rca-controller.sh --budget-policy .scratch/bare-metal-campaign/plans/g6-c32-rca-fix-01-r83-budget.json --registration-template .scratch/bare-metal-campaign/registrations/g6-c32-rca-closure-01.md --runbook-template .scratch/bare-metal-campaign/runbooks/g6-c32-rca-closure-01.md --gate-catalog .scratch/bare-metal-campaign/plans/g6-c32-gate-catalog-661a386a.json --out $OUT && rm -f $OUT
```

Expected: `authoritySha256=...` printed (bound). The registration is an untracked campaign input, so there is nothing to commit for it; record the amendment and the new digests in the campaign ledger (`.omx/ultragoal/ledger.jsonl`) as a `steering_accepted` event.

---

### Task 8: Kill gate on the self-hosted Linux runner

**Files:**
- Create: `tools/load/g6-ack-reflector-gate.ts`
- Create: `tools/load/g6-ack-reflector-gate.test.ts`
- Modify: `.github/workflows/bench-bandwidth.yml` (new `mode` value `ack-reflector-gate`; new step after "Run G6 attribution matrix")

**Interfaces:**
- Produces: `bun tools/load/g6-ack-reflector-gate.ts --js <scan.json> --native <scan.json> --out <gate.json>` writing `{ schema: "g6-ack-reflector-gate/1", jsP99Ms, nativeP99Ms, ratio, threshold: 0.25, pass: boolean }` and exiting 0 on pass, 3 on fail, 2 on unusable input.

- [ ] **Step 1: Write the failing test** `tools/load/g6-ack-reflector-gate.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { gradeAckReflectorGate } from "./g6-ack-reflector-gate.ts";

describe("ack reflector kill gate", () => {
	test("passes only when native p99 is at or below a quarter of js p99", () => {
		expect(gradeAckReflectorGate(83.5, 20.0)).toMatchObject({ pass: true, ratio: 20.0 / 83.5 });
		expect(gradeAckReflectorGate(83.5, 20.9)).toMatchObject({ pass: true });
		expect(gradeAckReflectorGate(83.5, 21.0)).toMatchObject({ pass: false });
		expect(gradeAckReflectorGate(10, 2.5)).toMatchObject({ pass: true });
	});
	test("refuses non-finite inputs", () => {
		expect(() => gradeAckReflectorGate(Number.NaN, 1)).toThrow(/finite/);
		expect(() => gradeAckReflectorGate(1, -1)).toThrow(/finite|negative/);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tools/load/g6-ack-reflector-gate.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `tools/load/g6-ack-reflector-gate.ts`**

```ts
/**
 * Kill gate for the native ack reflector: the premise that the shard's JS
 * loop owns the ack tail stands only if reflecting natively cuts the
 * client-measured ack p99 to a quarter or less at the same load.
 *
 *   bun tools/load/g6-ack-reflector-gate.ts --js <scan.json> --native <scan.json> --out <gate.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { LatencyHistogram } from "./latency-histogram.ts";

export const ACK_REFLECTOR_GATE_THRESHOLD = 0.25;

export function gradeAckReflectorGate(jsP99Ms: number, nativeP99Ms: number) {
	if (!Number.isFinite(jsP99Ms) || !Number.isFinite(nativeP99Ms) || jsP99Ms <= 0 || nativeP99Ms < 0) {
		throw new Error("ack reflector gate needs finite, positive p99 inputs");
	}
	const ratio = nativeP99Ms / jsP99Ms;
	return {
		schema: "g6-ack-reflector-gate/1" as const,
		jsP99Ms,
		nativeP99Ms,
		ratio,
		threshold: ACK_REFLECTOR_GATE_THRESHOLD,
		pass: ratio <= ACK_REFLECTOR_GATE_THRESHOLD,
	};
}

function ackP99Ms(scanPath: string): number {
	const scan = JSON.parse(readFileSync(scanPath, "utf8")) as { clientStdout: string };
	const line = scan.clientStdout.split("\n").find((l) => l.includes('"schema":"mmo-client/2"'));
	if (!line) throw new Error(`${scanPath}: no mmo-client/2 report`);
	const report = JSON.parse(line.slice(line.indexOf("{"))) as {
		windows: { steadyDrain: { rtt: unknown } };
	};
	const summary = LatencyHistogram.fromJson(report.windows.steadyDrain.rtt as never).summary();
	if (summary.count === 0) throw new Error(`${scanPath}: empty ack RTT histogram`);
	return summary.p99Ns / 1e6;
}

function flag(name: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index === -1 ? undefined : process.argv[index + 1];
	if (!value) throw new Error(`--${name} is required`);
	return value;
}

if (import.meta.main) {
	try {
		const verdict = gradeAckReflectorGate(ackP99Ms(flag("js")), ackP99Ms(flag("native")));
		writeFileSync(flag("out"), `${JSON.stringify(verdict, null, 2)}\n`);
		console.log(JSON.stringify(verdict));
		process.exit(verdict.pass ? 0 : 3);
	} catch (error) {
		console.error(String(error));
		process.exit(2);
	}
}
```

- [ ] **Step 4: Run the unit test**

Run: `bun test tools/load/g6-ack-reflector-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the workflow mode.** In `.github/workflows/bench-bandwidth.yml`, extend the `mode` input description with `| ack-reflector-gate (one shard, 1,250 sessions, js vs native ack reflection)` and add a step after "Run G6 attribution matrix":

```yaml
      - name: Run ack reflector kill gate
        id: run_ack_reflector_gate
        if: ${{ always() && github.event.inputs.probe_only != 'true' && github.event.inputs.mode == 'ack-reflector-gate' && env.G6_CONFIGURE_OK == 'true' && env.G6_PREPARE_OK == 'true' }}
        continue-on-error: true
        env:
          G6_OFFBOX_SSH: ${{ github.event.inputs.g6_offbox_ssh }}
          G6_SERVER_ADDRESS: ${{ github.event.inputs.g6_server_address }}
          G6_CANDIDATE_SHA: ${{ github.event.inputs.candidate_commit }}
          G6_PREREGISTRATION_SHA256: ${{ github.event.inputs.g6_preregistration_sha256 }}
        run: |
          set -euo pipefail
          ulimit -n "$(ulimit -Hn)" || true
          sudo env PIN_DIR=/sys/fs/bpf/quic-lb G6_BPF_READY_RECEIPT="$G6_BUNDLE_DIR/g6-shard-bpf-ready.json" tools/load/g6-shard-bpf-setup.sh 1
          for mode in js native; do
            sudo -E env SCAN_DIAGNOSTIC=1 SCAN_SHARDS=1 SCAN_SESSIONS=1250 SCAN_WORKLOAD_ACTIVE_SESSIONS=1250 \
              SCAN_ENDPOINTS=128 SCAN_CONNECT_CONCURRENCY=50 SCAN_CONNECT_RATE_PER_SEC=250 SCAN_FIXED_SOURCE_PORT_BASE=20000 \
              SCAN_ACK_REFLECTOR="$mode" G6_BPF_READY_RECEIPT="$G6_BUNDLE_DIR/g6-shard-bpf-ready.json" \
              SCAN_OUT="$G6_BUNDLE_DIR/ack-gate-$mode.json" SCAN_DIAGNOSTIC_OUT="$G6_BUNDLE_DIR/ack-gate-$mode-diagnostic.json" \
              SCAN_POST_RUN_STEERING_OUT="$G6_BUNDLE_DIR/ack-gate-$mode-steering.json" G6_EMITTER_MODE=native-mirror \
              bun tools/load/g6-sharded-scan.ts
          done
          bun tools/load/g6-ack-reflector-gate.ts --js "$G6_BUNDLE_DIR/ack-gate-js.json" --native "$G6_BUNDLE_DIR/ack-gate-native.json" --out "$G6_BUNDLE_DIR/ack-reflector-gate.json"
```

The existing G6 configure/prepare steps in that workflow already build the candidate, set up the off-box generator over `G6_OFFBOX_SSH`, and upload `$G6_BUNDLE_DIR` as an artifact; reuse them unchanged. The gate step's exit code is the verdict: 0 pass, 3 fail, 2 unusable.

- [ ] **Step 6: Validate the workflow file and commit**

Run: `bunx yaml-lint .github/workflows/bench-bandwidth.yml 2>/dev/null || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/bench-bandwidth.yml')); print('yaml ok')"`
Expected: `yaml ok`.

```bash
bunx biome format --write tools/load/g6-ack-reflector-gate.ts tools/load/g6-ack-reflector-gate.test.ts
git add tools/load/g6-ack-reflector-gate.ts tools/load/g6-ack-reflector-gate.test.ts .github/workflows/bench-bandwidth.yml
git commit -m "Add the ack reflector kill gate to the bench workflow

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 7: Dispatch the gate** (maintainer action, no repository change): trigger `bench-bandwidth.yml` with `mode=ack-reflector-gate`, `candidate_commit=<Task 8 commit>`, and the existing `g6_offbox_ssh`, `g6_server_address`, `g6_preregistration_sha256` inputs. Read `ack-reflector-gate.json` from the run artifact. `pass: true` unlocks any funded re-climb; `pass: false` stops the work here and the evidence is re-read.
