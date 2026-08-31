# Deviation — A5 live mint exact trust schemas

**Date:** 2026-08-31  
**Scope:** focused A5 live staging only  
**Plan:** unchanged

## Discovery

The live mint emitted slim authority, lock, and capability records plus
signing-key leaves that are not members of Rust's exact R1 schemas.
`CampaignAuthorityV1::parse`, `CampaignLockV1::parse`, and
`StagedCapabilityV1::parse` therefore rejected the bootstrap with
`OUTPUT_TRUST_BOUNDARY_UNAVAILABLE`.

## Resolution

The focused A5 mint now emits the exact Rust field sets and stages only the
final records; the invalid placeholder bootstrap was removed.

- The approved plan digest supplies `parentPlanSha256`,
  `parentDesignSha256`, and `amendmentSha256` because this focused run has no
  separate design or amendment artifact.
- The focused approval-record digest supplies the architect, critic, and
  verifier approval fields. This binds all three roles to the preserved
  focused approval record without inventing additional approvals.
- A minimal source-archive receipt, RED approval bundle, campaign reservation,
  and SSH-host receipt are written under `campaign-root` and bound by digest.
- The authority topology uses the live direct-cable endpoints:
  Mac `en13` / `10.99.0.1` and Linux `eno1` / `10.99.0.2`.
- Registry and capacity hashes come from the canonical scenario registry.
  Focused schedule, TLS, topology, and execution hashes use canonical,
  labeled preimages bound to the live candidate and campaign.
- Rust requires distinct Mac and Linux staged-archive digests. Both derive
  from the common source archive plus the corresponding host ID and live
  staging `DirectoryIdentity`, recording host-specific staging without
  claiming different source bytes.

Signing-key leaves remain staged separately and are not fields of the
authority, lock, or capability.
