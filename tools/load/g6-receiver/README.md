# Receiver evidence primitives

Stdlib-only Python, tested on Python 3.11 (Linux) and 3.13 (macOS). These modules
are diagnostic infrastructure, not product packet-path code. They are not yet
wired to the campaign entry, authority or grader.

- `format.py`: exact 128-socket / 1..512-thread dictionary, absolute-value sample
  codec, bounded canonical control JSON and hash-chained record framing.
- `observe.py`: actual G6RD1 endpoint handshake, durable ACK-prefix binding,
  phase intervals, counter continuity and complete consecutive 100 ms cadence.
- `replay.py`: closed no-follow manifest/file verification, retained descriptor
  checks, bounded log-line validation and two-pass observation replay.

Run local tests with:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tools/load/g6-receiver -p 'test_*.py' -q
```

## Wire records

All record envelopes carry magic `GRF1`, a closed kind code, zero reserved fields,
payload length, consecutive ordinal, previous complete-record SHA256 and payload
SHA256. Integers use unsigned big-endian fixed width; semantic counters/clocks
remain strictly below 2^53. `iter_frames` must be consumed to exhaustion.

The ordered control path is BEGIN, READY, two FREEZE records, ACK_INTENT, ACK,
PHASE/observations, END, CLIENT_EXIT, STREAM_END. Samples may interleave delayed
phase receipts; their attribution uses the complete driver timeline in pass two.
An optional failed non-required fractional slot uses TAIL_CANCEL, never fabricated
sample values. Normal END and exact recorded client exit zero remain required.

BEGIN contains `g6-receiver-evidence/1`, the exact independently expected binding
(including the 40-hex candidate Git commit and distinct 64-hex source digest),
client/supervisor/writer identities, token and arm time. FREEZE contains `atNs`
and the complete snapshot. The second freeze seeds the sample codec with its
`beganNs` as the baseline's `scheduledNs`; it is not a periodic observation.

READY, PHASE, END and ACK_INTENT wrap original driver bytes with an 8-byte local
receipt/creation timestamp. ACK_INTENT contains `ARMED\n` plus the original READY.
ACK contains four u64s (actual before/after, durable commit receipt time, committed
prefix length), the 32-byte prefix chain hash, and the identical ACK bytes. Its
prefix must equal the actual ACK_INTENT record end offset/hash.

STREAM_END binds pre-end count, byte offset and chain hash, recorded client pipe
EOF and local time. It is an internal completion intent only. It cannot attest
future writer fsync/close/reap, supervisor exit, transport closure or PG absence.

## Admission and acceptance boundaries

Maximum sample payload: 17,476 bytes. The conservative complete framed valid-record
envelope, including freezes/controls and 64 KiB terminal reserve, is 74,452,192
bytes, below the 80 MiB raw cap. Each client log is limited to 8 MiB and each line
(including LF when present) to 128 KiB. Manifest plus settlement metadata is at
most 1 MiB; total artifacts cannot exceed 128 MiB. These are byte bounds, not
live writer/observer memory or whole-cell timing measurements.

`replay_verified(root, expected_manifest_sha256, expected_binding)` hashes every
closed file before parsing the raw stream. The manifest digest and binding must
come from the caller's independently verified source/owner authority, never be
derived from the presented evidence. Retained file identities and hashes are
checked again through both bounded semantic passes. `replay_observations` is the
lower-level API for already verified readers; it is not a replacement for the
manifest layer.

The returned observation summary always has `externalSettlementVerified=false`
and `capacityQualified=false`. The settlement file is hash-checked but not yet
semantically accepted by this component. Campaign integration must independently
verify the complete settlement chain, source authority, clocks, real launch,
calibration and workload before using observation attribution. Synthetic unit
fixtures and historical raw codec round trips do not supply those gates.
