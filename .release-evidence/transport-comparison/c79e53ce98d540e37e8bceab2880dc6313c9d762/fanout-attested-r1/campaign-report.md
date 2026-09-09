# WebTransport vs WebSocket Comparison Report

> **Campaign ID**: `fanout-attested-r1` | **Generated**: 2026-09-09T09:58:33.347Z
> **Comparison status**: 6/6 cells comparable; 0 rejected or quarantined
> **Note**: Full matrix campaign index entries=60. Execution purpose: canonical campaign. serverAggregate: aggregate receive-loop work over Linux baseline-to-capture window; transparency only; may exceed 1x window. Sealed p50 table below is the honest measured view when formal compare is blocked.
> **Signing leaves**: resolved from the campaign index's stagedDir (mac 7db9059d62100579e7e63f241cbde2f8f47bd45a04dc58e031698f702645155b, rig 8028b0e2c50f0474ab93b4b79caeba9e835bb8ac2247c653bb42826f66c86fee)

Only externally trusted, source-bound artifacts are eligible for a numeric comparison. Missing, incompatible, synthetic, or quarantined inputs remain typed rows and do not produce a delta.

`serverAggregate` loop utilization is reported for transparency and is **unobserved** / non-claim for saturation ranking when busyMs is a placeholder.

## Summary Table

| Scenario | Status | Primary Metric | WS | WT | Delta (%) | Winner | Loop Utilization | Notes |
| :--- | :---: | :--- | :---: | :---: | :---: | :---: | :--- | :--- |
| `ticker-fanout/rate-25` | **COMPATIBLE** | delivered-updates-per-second (count) | 2,500 | 2,500 | 0.00% | TIE | WS ps=6%/agg=6%; WT ps=4%/agg=4% | - |
| `ticker-fanout/rate-50` | **COMPATIBLE** | delivered-updates-per-second (count) | 5,000 | 5,000 | 0.00% | TIE | WS ps=10%/agg=10%; WT ps=9%/agg=9% | - |
| `ticker-fanout/rate-100` | **COMPATIBLE** | delivered-updates-per-second (count) | 9,902.88 | 10,000 | +0.98% | WT | WS ps=18%/agg=18%; WT ps=15%/agg=15% | - |
| `chat-fanout/subscribers-250` | **COMPATIBLE** | delivered-messages-per-second (count) | 2,500 | 2,500 | 0.00% | TIE | WS ps=4%/agg=4%; WT ps=2%/agg=2% | - |
| `chat-fanout/subscribers-500` | **COMPATIBLE** | delivered-messages-per-second (count) | 5,000 | 5,000 | 0.00% | TIE | WS ps=8%/agg=8%; WT ps=4%/agg=4% | - |
| `chat-fanout/subscribers-1000` | **COMPATIBLE** | delivered-messages-per-second (count) | 10,000 | 10,000 | 0.00% | TIE | WS ps=15%/agg=15%; WT ps=7%/agg=7% | - |

## Provenance

- Numeric values are copied from verified run artifacts; this report does not contain a fallback baseline.
- A comparison is withheld unless both transport arms pass the evidence and external-trust quarantine gates.
- Loop-utilization saturation caveat fires when per-session busyMs/windowMs exceeds 0.3 (30%); server-aggregate utilization is shown for transparency and never triggers the caveat.
- busyMs is the JavaScript event-loop time this server spent on this session's transport work, ingest and egress, over the same wall-clock window. Ingest is the loop time spent on both turns a byte costs: the arrival turn that takes it off the wire and decodes it, and the consumer turn that reads it back out, never the wall time a reader spends waiting for one. Egress is the loop time spent framing, scheduling and resuming outbound writes, never the wall time the bytes take to leave. It is not process CPU: native, kernel and other-thread time are excluded, as is harness work outside the session such as generating or digesting a bulk payload. Per-session busyMs is one session's own loop; the server aggregate is the sum over that server's sessions, completed and live, across the same window, so it can exceed any one session's and is not a utilisation of one loop. Sealed artifacts whose per-session reading is exactly 65 over a 1250 ms window carry a fixture constant rather than a measurement, and are not comparable with a measured arm.
- Charging correction applied in this tree: the fanout relay now charges its own frame reassembly and routing decode, which ran outside every span before, so any relay busyMs published before this correction is short by them. Measured on the steady-state 100-byte ticker data frame, the two bodies cost 1.28 to 1.38 microseconds per frame, which at the campaign's 10,000 frames per second inbound rate is 12.8 to 13.8 ms of loop time per second, or 0.77 to 0.83 seconds per minute. That figure is this frame shape only: control frames and the 128-byte chat data frame are a different shape and are not measured by it.
- Generated output belongs under the ignored `.release-evidence/transport-comparison/` tree.

## Sealed primary metrics (honest measured view)

| Cell | Unit | WS p50 | WT p50 | WS samples | WT samples | WS attestation | WT attestation |
| :--- | :---: | ---: | ---: | ---: | ---: | :---: | :---: |
| `ticker-fanout/rate-25` | count | 2500 | 2500 | 10 | 10 | attested | attested |
| `ticker-fanout/rate-50` | count | 5000 | 5000 | 10 | 10 | attested | attested |
| `ticker-fanout/rate-100` | count | 10000 | 10000 | 10 | 10 | attested | attested |
| `chat-fanout/subscribers-250` | count | 2500 | 2500 | 30 | 30 | attested | attested |
| `chat-fanout/subscribers-500` | count | 5000 | 5000 | 30 | 30 | attested | attested |
| `chat-fanout/subscribers-1000` | count | 10000 | 10000 | 30 | 30 | attested | attested |

## Per-arm attestation

### WS attested arm — `ticker-fanout/rate-25`

- p50: 2500 count
- serverAggregate: aggregate receive-loop work over Linux baseline-to-capture window; transparency only; may exceed 1x window
- Raw sidecar digests (this execution's own): topology de9473a2b738828fcaa1dd4c4c97978a57dce3682db85001d7ce766fce305545, impairment f0694be8250f5b8afbed65add7033972b9b0075f54ac9959273d00061f78ab05, cleanup 10f18f2564ee6b45328429af87d383e048478f976671723bb06df1d37b7d558c
- Topology: 1 publisher / 8 workers / 100 subscribers / 101 sessions
- Totals (recomputed from the retained partials): offered ingress 250, accepted ingress 250, relay writes 25000, delivered 25000, delivered bytes 2500000, post-stop drain 0
- busyMs (relay timed spans on the server child's JS thread): 582 ms (5.7% of the 10264 ms window)
- Server-child main-thread CPU (rig-read utime+stime): 1120 ms (10.9% of the 10271 ms window)
- Server-child process CPU (rig-read utime+stime): 2630 ms (25.6% of the 10271 ms window)
- Claim boundary: this is a resource-accounting comparison at equal work, not a throughput ranking -- a promoted arm's delivered rate equals the declared rate by construction (promotion requires D = L = A x K in every window at the row's pacing), so what separates the transports is the three attested figures above, of which busyMs is only the relay's timed spans on the server child's JS thread and excludes the settler's bookkeeping between spans, the transport's asynchronous completion work on that thread and the native transport threads, which the main-thread and process CPU account for.

### WT attested arm — `ticker-fanout/rate-25`

- p50: 2500 count
- serverAggregate: aggregate receive-loop work over Linux baseline-to-capture window; transparency only; may exceed 1x window
- Raw sidecar digests (this execution's own): topology fd0ec05e8a3855db728cf25d9b683797bb09d8aab3e236a6e0fe859f239d80c5, impairment 3487b7e9ca79180ee04470e5c343f7a47856ab99f21bcccb8e3830f1da6b637b, cleanup 88b3e9bc776eb0cb5ad9fba33b2434d1e9f268efd45a6d241d1796123a27cd7b
- Topology: 1 publisher / 8 workers / 100 subscribers / 101 sessions
- Totals (recomputed from the retained partials): offered ingress 250, accepted ingress 250, relay writes 25000, delivered 25000, delivered bytes 2500000, post-stop drain 0
- busyMs (relay timed spans on the server child's JS thread): 418 ms (4.1% of the 10257 ms window)
- Server-child main-thread CPU (rig-read utime+stime): 1120 ms (10.9% of the 10268 ms window)
- Server-child process CPU (rig-read utime+stime): 4770 ms (46.5% of the 10268 ms window)
- Claim boundary: this is a resource-accounting comparison at equal work, not a throughput ranking -- a promoted arm's delivered rate equals the declared rate by construction (promotion requires D = L = A x K in every window at the row's pacing), so what separates the transports is the three attested figures above, of which busyMs is only the relay's timed spans on the server child's JS thread and excludes the settler's bookkeeping between spans, the transport's asynchronous completion work on that thread and the native transport threads, which the main-thread and process CPU account for.

### WS attested arm — `ticker-fanout/rate-50`

- p50: 5000 count
- serverAggregate: aggregate receive-loop work over Linux baseline-to-capture window; transparency only; may exceed 1x window
- Raw sidecar digests (this execution's own): topology f484347a03cdb44f6b45673df6fe5a6e7a70f89c1c36664f95ca32ddf556a0cf, impairment d5651d82b88b58a140ec29605d14df0c0dd37a5ab3e4532419a20f160b08ba81, cleanup 0b453c005408dc32b049a45938f16de62ba78c301e39eff706d8c890ee493af3
- Topology: 1 publisher / 8 workers / 100 subscribers / 101 sessions
- Totals (recomputed from the retained partials): offered ingress 500, accepted ingress 500, relay writes 50000, delivered 50000, delivered bytes 5000000, post-stop drain 0
- busyMs (relay timed spans on the server child's JS thread): 1068 ms (10.4% of the 10263 ms window)
- Server-child main-thread CPU (rig-read utime+stime): 1710 ms (16.6% of the 10271 ms window)
- Server-child process CPU (rig-read utime+stime): 3420 ms (33.3% of the 10271 ms window)
- Claim boundary: this is a resource-accounting comparison at equal work, not a throughput ranking -- a promoted arm's delivered rate equals the declared rate by construction (promotion requires D = L = A x K in every window at the row's pacing), so what separates the transports is the three attested figures above, of which busyMs is only the relay's timed spans on the server child's JS thread and excludes the settler's bookkeeping between spans, the transport's asynchronous completion work on that thread and the native transport threads, which the main-thread and process CPU account for.

### WT attested arm — `ticker-fanout/rate-50`

- p50: 5000 count
- serverAggregate: aggregate receive-loop work over Linux baseline-to-capture window; transparency only; may exceed 1x window
- Raw sidecar digests (this execution's own): topology f62aa24dbd0e9a0abeefbbc10fc319dd786a883d6dce40d6fe0b92305ca7469e, impairment 08812900870826af76519226a5b4aafa27181475f097693938cce04bac3c4518, cleanup a760a8b1853721203c0a9c64ab62cee5c4c77396758e9fb5b391ef49e75333da
- Topology: 1 publisher / 8 workers / 100 subscribers / 101 sessions
- Totals (recomputed from the retained partials): offered ingress 500, accepted ingress 500, relay writes 50000, delivered 50000, delivered bytes 5000000, post-stop drain 0
- busyMs (relay timed spans on the server child's JS thread): 879 ms (8.6% of the 10257 ms window)
- Server-child main-thread CPU (rig-read utime+stime): 1870 ms (18.2% of the 10271 ms window)
- Server-child process CPU (rig-read utime+stime): 7150 ms (69.6% of the 10271 ms window)
- Claim boundary: this is a resource-accounting comparison at equal work, not a throughput ranking -- a promoted arm's delivered rate equals the declared rate by construction (promotion requires D = L = A x K in every window at the row's pacing), so what separates the transports is the three attested figures above, of which busyMs is only the relay's timed spans on the server child's JS thread and excludes the settler's bookkeeping between spans, the transport's asynchronous completion work on that thread and the native transport threads, which the main-thread and process CPU account for.

### WS attested arm — `ticker-fanout/rate-100`

- p50: 10000 count
- serverAggregate: aggregate receive-loop work over Linux baseline-to-capture window; transparency only; may exceed 1x window
- Raw sidecar digests (this execution's own): topology 17db1e0f5fa7ec3216e27ae7ad0cc1d97b9f8cb993d6395ea59c4761fdcd98e6, impairment f5bfac6c7e02958ac99ef9a705c224c2e11c993cc17d22b1d107635d2b622410, cleanup 188c1086af01585dfb5b323896603fb9021bbd3ecaffbb63f1f18f6843e6c613
- Topology: 1 publisher / 8 workers / 100 subscribers / 101 sessions
- Totals (recomputed from the retained partials): offered ingress 1000, accepted ingress 1000, relay writes 100000, delivered 100000, delivered bytes 10000000, post-stop drain 0
- busyMs (relay timed spans on the server child's JS thread): 1831 ms (17.8% of the 10258 ms window)
- Server-child main-thread CPU (rig-read utime+stime): 2560 ms (24.9% of the 10265 ms window)
- Server-child process CPU (rig-read utime+stime): 4500 ms (43.8% of the 10265 ms window)
- Claim boundary: this is a resource-accounting comparison at equal work, not a throughput ranking -- a promoted arm's delivered rate equals the declared rate by construction (promotion requires D = L = A x K in every window at the row's pacing), so what separates the transports is the three attested figures above, of which busyMs is only the relay's timed spans on the server child's JS thread and excludes the settler's bookkeeping between spans, the transport's asynchronous completion work on that thread and the native transport threads, which the main-thread and process CPU account for.

### WT attested arm — `ticker-fanout/rate-100`

- p50: 10000 count
- serverAggregate: aggregate receive-loop work over Linux baseline-to-capture window; transparency only; may exceed 1x window
- Raw sidecar digests (this execution's own): topology 2618abdc32825697efd059af8a6f1a570e7c47c70d39c1fc83b89fc155ffa780, impairment 5c56fc9bcb9bb956f12ba4d2e85bdcbca6301be36b00eb72131a2acd0874bf2f, cleanup 68716b97b1d20befb9cf7048343cbb09e6bacb1a39e3e4364ae2796273431dc0
- Topology: 1 publisher / 8 workers / 100 subscribers / 101 sessions
- Totals (recomputed from the retained partials): offered ingress 1000, accepted ingress 1000, relay writes 100000, delivered 100000, delivered bytes 10000000, post-stop drain 0
- busyMs (relay timed spans on the server child's JS thread): 1498 ms (14.6% of the 10255 ms window)
- Server-child main-thread CPU (rig-read utime+stime): 2640 ms (25.7% of the 10269 ms window)
- Server-child process CPU (rig-read utime+stime): 10730 ms (104.5% of the 10269 ms window)
- Claim boundary: this is a resource-accounting comparison at equal work, not a throughput ranking -- a promoted arm's delivered rate equals the declared rate by construction (promotion requires D = L = A x K in every window at the row's pacing), so what separates the transports is the three attested figures above, of which busyMs is only the relay's timed spans on the server child's JS thread and excludes the settler's bookkeeping between spans, the transport's asynchronous completion work on that thread and the native transport threads, which the main-thread and process CPU account for.

### WS attested arm — `chat-fanout/subscribers-250`

- p50: 2500 count
- serverAggregate: aggregate receive-loop work over Linux baseline-to-capture window; transparency only; may exceed 1x window
- Raw sidecar digests (this execution's own): topology 49232f345981554f9bf8aa4e858f5856438ee050492b00523bff4e2bb78a504b, impairment 4a5d06953014623e18461501c7b99bfd499f9f614ec994d04e69b1e98fd5256c, cleanup 936a58aea7cc87539d75fcec4a36bfc952c8e677f5d892dc861c1e69abd94f8a
- Topology: 10 publishers / 8 workers / 250 subscribers / 260 sessions
- Totals (recomputed from the retained partials): offered ingress 300, accepted ingress 300, relay writes 75000, delivered 75000, delivered bytes 9600000, post-stop drain 0
- busyMs (relay timed spans on the server child's JS thread): 1170 ms (3.9% of the 30269 ms window)
- Server-child main-thread CPU (rig-read utime+stime): 1500 ms (5.0% of the 30275 ms window)
- Server-child process CPU (rig-read utime+stime): 2290 ms (7.6% of the 30275 ms window)
- Claim boundary: this is a resource-accounting comparison at equal work, not a throughput ranking -- a promoted arm's delivered rate equals the declared rate by construction (promotion requires D = L = A x K in every window at the row's pacing), so what separates the transports is the three attested figures above, of which busyMs is only the relay's timed spans on the server child's JS thread and excludes the settler's bookkeeping between spans, the transport's asynchronous completion work on that thread and the native transport threads, which the main-thread and process CPU account for.

### WT attested arm — `chat-fanout/subscribers-250`

- p50: 2500 count
- serverAggregate: aggregate receive-loop work over Linux baseline-to-capture window; transparency only; may exceed 1x window
- Raw sidecar digests (this execution's own): topology b009c043f30e0117541a54f93fb420f8922a02037c44f0680a70502ecdbddb3b, impairment ad95c132acd2f5a9c2725606b01648a7a665e1d7587b2a687d155c9c4896dca1, cleanup b5e23c686c3d97cdffb1efd26a45b41a38702e095517b21ff7f31a97af5ae983
- Topology: 10 publishers / 8 workers / 250 subscribers / 260 sessions
- Totals (recomputed from the retained partials): offered ingress 300, accepted ingress 300, relay writes 75000, delivered 75000, delivered bytes 9600000, post-stop drain 0
- busyMs (relay timed spans on the server child's JS thread): 576 ms (1.9% of the 30270 ms window)
- Server-child main-thread CPU (rig-read utime+stime): 1430 ms (4.7% of the 30277 ms window)
- Server-child process CPU (rig-read utime+stime): 5060 ms (16.7% of the 30277 ms window)
- Claim boundary: this is a resource-accounting comparison at equal work, not a throughput ranking -- a promoted arm's delivered rate equals the declared rate by construction (promotion requires D = L = A x K in every window at the row's pacing), so what separates the transports is the three attested figures above, of which busyMs is only the relay's timed spans on the server child's JS thread and excludes the settler's bookkeeping between spans, the transport's asynchronous completion work on that thread and the native transport threads, which the main-thread and process CPU account for.

### WS attested arm — `chat-fanout/subscribers-500`

- p50: 5000 count
- serverAggregate: aggregate receive-loop work over Linux baseline-to-capture window; transparency only; may exceed 1x window
- Raw sidecar digests (this execution's own): topology 8f5571b35753491ff87752c9d0976287747f6d2c851dc62712fb11bc1918f856, impairment b31cd76c2dc404cdffe6e0eca3e3f80f506ac26949ef2668359e58d5258515a8, cleanup 56adbd6c001541e9aef5ef3731f433cd8b1fb72034f5acad6b56b65a61057bab
- Topology: 10 publishers / 8 workers / 500 subscribers / 510 sessions
- Totals (recomputed from the retained partials): offered ingress 300, accepted ingress 300, relay writes 150000, delivered 150000, delivered bytes 19200000, post-stop drain 0
- busyMs (relay timed spans on the server child's JS thread): 2478 ms (8.2% of the 30283 ms window)
- Server-child main-thread CPU (rig-read utime+stime): 2980 ms (9.8% of the 30290 ms window)
- Server-child process CPU (rig-read utime+stime): 3930 ms (13.0% of the 30290 ms window)
- Claim boundary: this is a resource-accounting comparison at equal work, not a throughput ranking -- a promoted arm's delivered rate equals the declared rate by construction (promotion requires D = L = A x K in every window at the row's pacing), so what separates the transports is the three attested figures above, of which busyMs is only the relay's timed spans on the server child's JS thread and excludes the settler's bookkeeping between spans, the transport's asynchronous completion work on that thread and the native transport threads, which the main-thread and process CPU account for.

### WT attested arm — `chat-fanout/subscribers-500`

- p50: 5000 count
- serverAggregate: aggregate receive-loop work over Linux baseline-to-capture window; transparency only; may exceed 1x window
- Raw sidecar digests (this execution's own): topology ee7a05d0e7a060b217175e93546e13cebab2e9c89776d5679be6342db97cfe28, impairment 446c901d88c8790ce38741178f8335fc2c5776614ef429bd31ebf39ca7883e44, cleanup 9273bef035b493754295233fdb6f0cc1f63221b892177c2e933bbe6eda087257
- Topology: 10 publishers / 8 workers / 500 subscribers / 510 sessions
- Totals (recomputed from the retained partials): offered ingress 300, accepted ingress 300, relay writes 150000, delivered 150000, delivered bytes 19200000, post-stop drain 0
- busyMs (relay timed spans on the server child's JS thread): 1100 ms (3.6% of the 30289 ms window)
- Server-child main-thread CPU (rig-read utime+stime): 2750 ms (9.1% of the 30295 ms window)
- Server-child process CPU (rig-read utime+stime): 9670 ms (31.9% of the 30295 ms window)
- Claim boundary: this is a resource-accounting comparison at equal work, not a throughput ranking -- a promoted arm's delivered rate equals the declared rate by construction (promotion requires D = L = A x K in every window at the row's pacing), so what separates the transports is the three attested figures above, of which busyMs is only the relay's timed spans on the server child's JS thread and excludes the settler's bookkeeping between spans, the transport's asynchronous completion work on that thread and the native transport threads, which the main-thread and process CPU account for.

### WS attested arm — `chat-fanout/subscribers-1000`

- p50: 10000 count
- serverAggregate: aggregate receive-loop work over Linux baseline-to-capture window; transparency only; may exceed 1x window
- Raw sidecar digests (this execution's own): topology c39e3824f5f944fc7a6ed45cab204864005bbfcc9b153c3acb6e18ea1dcd1370, impairment 16cbc701f1d8a47debb26680a8acceb81ab34999c1dee96cf5498e05d29bbb64, cleanup a41f144dc0914fb5af579f00250702a6b0e20fcffe0d80bb65761f11f686b081
- Topology: 10 publishers / 8 workers / 1000 subscribers / 1010 sessions
- Totals (recomputed from the retained partials): offered ingress 300, accepted ingress 300, relay writes 300000, delivered 300000, delivered bytes 38400000, post-stop drain 0
- busyMs (relay timed spans on the server child's JS thread): 4399 ms (14.5% of the 30311 ms window)
- Server-child main-thread CPU (rig-read utime+stime): 5100 ms (16.8% of the 30318 ms window)
- Server-child process CPU (rig-read utime+stime): 6250 ms (20.6% of the 30318 ms window)
- Claim boundary: this is a resource-accounting comparison at equal work, not a throughput ranking -- a promoted arm's delivered rate equals the declared rate by construction (promotion requires D = L = A x K in every window at the row's pacing), so what separates the transports is the three attested figures above, of which busyMs is only the relay's timed spans on the server child's JS thread and excludes the settler's bookkeeping between spans, the transport's asynchronous completion work on that thread and the native transport threads, which the main-thread and process CPU account for.

### WT attested arm — `chat-fanout/subscribers-1000`

- p50: 10000 count
- serverAggregate: aggregate receive-loop work over Linux baseline-to-capture window; transparency only; may exceed 1x window
- Raw sidecar digests (this execution's own): topology 5115eaaf49fee1fe22eadc8dda0268f9f2566ff95567cc8791c57961f9b03037, impairment 551aab0e103c06ae771e57f2280d3e2078d24cd92d5bea19a3efffe2f25f262e, cleanup 631dea9ee5597a42ddfe109314a0c3c90bcfc56dcba8191b09ddf9ade2919541
- Topology: 10 publishers / 8 workers / 1000 subscribers / 1010 sessions
- Totals (recomputed from the retained partials): offered ingress 300, accepted ingress 300, relay writes 300000, delivered 300000, delivered bytes 38400000, post-stop drain 0
- busyMs (relay timed spans on the server child's JS thread): 2270 ms (7.5% of the 30293 ms window)
- Server-child main-thread CPU (rig-read utime+stime): 5170 ms (17.1% of the 30308 ms window)
- Server-child process CPU (rig-read utime+stime): 19110 ms (63.1% of the 30308 ms window)
- Claim boundary: this is a resource-accounting comparison at equal work, not a throughput ranking -- a promoted arm's delivered rate equals the declared rate by construction (promotion requires D = L = A x K in every window at the row's pacing), so what separates the transports is the three attested figures above, of which busyMs is only the relay's timed spans on the server child's JS thread and excludes the settler's bookkeeping between spans, the transport's asynchronous completion work on that thread and the native transport threads, which the main-thread and process CPU account for.

Canonical fanout result: all 6 primary fanout cells promoted as WS/WT pairs from 60 fresh measured PASS seals.

Source: median-promoted `*-ws.json` / `*-wt.json` under this campaign root; see `campaign-index.json` for per-rep PASS/FAIL.
