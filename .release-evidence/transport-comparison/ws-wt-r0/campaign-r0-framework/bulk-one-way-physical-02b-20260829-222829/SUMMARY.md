# bulk-one-way/physical — server-opened uni (ticket 02b)

**Date:** 2026-08-29
**Topology:** Linux source opens uni → Mac sink accepts, hashes, records Mbps
**Payload:** 100 MiB / 64 KiB chunks (1600), pattern fill matching `generateBulkPayload`
**Path:** physical (no netem); Mac `en13` ↔ Linux `eno1` (`10.99.0.1` ↔ `10.99.0.2`)
**TLS:** SAN `DNS:gravvene-dev-home,IP:10.99.0.2`; SNI `gravvene-dev-home`

| Arm | p50 (Mbps) | p95 (Mbps) | samples | spanMs | deliveredBytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| WS | 938.48 | 953.16 | 9 | 892 | 104857600 |
| WT | 295.52 | 373.38 | 30 | 2988 | 104857600 |

**Delta (WS − WT) p50:** 642.95 Mbps (WS/WT ≈ 3.18×)

## Notes

- This replaces the interim client-send + echo-drain pilot numbers (~228 / ~105 Mbps).
- Sink-side Mbps only counts received+hashed bytes; digest verified against `generateBulkPayload`.
- Not yet supervisor-sealed into a full `RunArtifact` / render-report PASS cell.
