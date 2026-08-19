# T34 mirror-send microbench — run log

Branch `design/mirror-send-01`, worktree off `rebind4-staging` @
`2a4145d0556a35f8b4a0849e5953927b5e028b64` (the composed tree: the promise-free
`trySendDatagram` and the counted/one-deadline batch fixes are all in the
baseline).

Box: maintainer's macOS arm64, shared with other agents. **No number here is a
result.** Only same-pass ratios are used, per T04's rule.

Build:

```
cd tools/bench/mirror-send/fanout && cargo build --release
cp fanout/target/release/libfanout_bench.dylib tools/bench/mirror-send/fanout-bench.node
```

Estimator: 6 interleaved passes per cell, **minimum kept** (identical to T04's
`crossing-bench.ts`). Warmup 0.5 s spread across the N ladder.

## Run 1 — payload 200 B (G10's market-data shape)

`bun tools/bench/mirror-send/fanout-bench.ts --payload 200 --seconds 3`

```
shape                                     N=10  N=100  N=1000  N=10000
----------------------------------------  ----  -----  ------  -------
per-target promise, pipelined             3749   2813    2828     2879
per-target trySendDatagram (sync)          309    314     317      331
mirror: string[] targets                   158     93      90       84
mirror: Uint32Array targets                 78     22      20       28
mirror: native group handle                 61     16      11       11
mirror: native group, per-target reframe    85     40      36       36
mirror: native group, behind one promise  1357    140      27       14

envelope shapes at N=10000, by failure fraction
shape                                          0%  1-in-1000  1-in-10  1-in-1
---------------------------------------------  --  ---------  -------  ------
envelope: {sent, failed}                       11         11       10       4
envelope: failures-only (Uint32Array + codes)  11         11       10      13
envelope: bitset (ceil(N/8) bytes)             11         11        9       1
envelope: per-target (string|null)[]           26         27       44      66
```

## Run 2 — payload 1150 B

`bun tools/bench/mirror-send/fanout-bench.ts --payload 1150 --seconds 3`

```
shape                                     N=10  N=100  N=1000  N=10000
----------------------------------------  ----  -----  ------  -------
per-target promise, pipelined             3783   3013    3004     3093
per-target trySendDatagram (sync)          341    334     354      358
mirror: string[] targets                   170     94      90       86
mirror: Uint32Array targets                 83     23      22       28
mirror: native group handle                 66     16      11       11
mirror: native group, per-target reframe   104     57      51       51
mirror: native group, behind one promise  1371    158      27       14

envelope shapes at N=10000, by failure fraction
shape                                          0%  1-in-1000  1-in-10  1-in-1
---------------------------------------------  --  ---------  -------  ------
envelope: {sent, failed}                       12         11       11       4
envelope: failures-only (Uint32Array + codes)  11         12       10      13
envelope: bitset (ceil(N/8) bytes)             11         12       10       1
envelope: per-target (string|null)[]           28         29       43      63
```

## Run 3 — payload 200 B, repeat (reproducibility)

Same command as run 1.

```
shape                                     N=10  N=100  N=1000  N=10000
----------------------------------------  ----  -----  ------  -------
per-target promise, pipelined             3832   2836    3082     2772
per-target trySendDatagram (sync)          313    314     327      334
mirror: string[] targets                   165     93      90       84
mirror: Uint32Array targets                 79     23      20       28
mirror: native group handle                 62     16      11       11
mirror: native group, per-target reframe    85     40      36       35
mirror: native group, behind one promise  1445    145      28       14
```

Every mirror cell reproduces to within 1–3% between runs 1 and 3; the
per-target promise row swings ~10%, which only makes the mirror/promise ratios
quoted in the design note lower bounds.

## Run 5 — payload 200 B, after the clippy fix (this is the committed source)

Runs 1–3 were taken before two cosmetic clippy fixes to the addon (a doc-comment
indent and `is_multiple_of` in the *setup* function `set_failures`, which no
timed cell calls). Re-run so the recorded numbers match the committed source:

```
shape                                     N=10  N=100  N=1000  N=10000
----------------------------------------  ----  -----  ------  -------
per-target promise, pipelined             3767   3380    3323     3367
per-target trySendDatagram (sync)          317    314     323      343
mirror: string[] targets                   161     95      90       86
mirror: Uint32Array targets                 84     27      24       30
mirror: native group handle                 64     16      11       11
mirror: native group, per-target reframe    88     42      36       37
mirror: native group, behind one promise  1455    184      26       15

envelope shapes at N=10000, by failure fraction
shape                                          0%  1-in-1000  1-in-10  1-in-1
---------------------------------------------  --  ---------  -------  ------
envelope: {sent, failed}                       11         11       10       4
envelope: failures-only (Uint32Array + codes)  11         11       10      22
envelope: bitset (ceil(N/8) bytes)             11         11       10       2
envelope: per-target (string|null)[]           26         26       63      67
```

Every mirror cell is within 1–8% of run 1. The design note's conservative
ratios are computed against the **worst** mirror cell and the **best** baseline
cell over runs 1, 2, 3 and 5, and all of them survive this run: `string[]`
314/90 = 3.5×, `Uint32Array` 314/30 = 10.5×, group 314/11 = 28.5×.

## Run 4 — JS-side target-list construction (not part of the addon)

```
bun -e "…"   # 8 passes of 120 ms, minimum kept, N = 10,000
Array.from(Set<string>)             7.1 ns/target
[...set]                            1.9 ns/target
Array.from(map.keys())              3.7 ns/target
reuse cached string[] (no build)    0.0 ns/target
Uint32Array copy from cache         0.1 ns/target
```

Materialising the target list from a live subscriber `Set` costs 2–7 ns/target,
i.e. ≤ 8% of the `string[]` mirror's own 84–90 ns. It does not change any
decision, and it is recorded so the design's numbers are not quoted without it.

## What the addon does and does not model

Models: a `DashMap<String, Arc<_>>` registry lookup per target (the product's
`get_datagram_send_state` shape), the payload copy at the crossing, a `Bytes`
clone per target, and an atomic counter bump per target.

Does not model: quinn's connection-state mutex, real framing, the byte
governor's reserve/release pair, or any IO. All of those are per-target work
that both the baseline and the mirror pay identically, so leaving them out makes
every mirror-vs-baseline ratio quoted in the design note a **lower bound** —
the direction that cannot flatter the API.
