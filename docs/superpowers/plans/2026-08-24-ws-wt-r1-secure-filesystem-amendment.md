# R1 Secure Filesystem Trust-Boundary Amendment

> **Scope amendment only.** This artifact amends, but does not replace,
> `2026-08-22-ws-wt-scenario-comparison.md` and its design. It authorizes no
> measurement, network traffic, Linux execution, or promotion by itself.

**Purpose:** Replace R0's intentional
`OUTPUT_TRUST_BOUNDARY_UNAVAILABLE` quarantine with a narrow, auditable,
handle-relative filesystem boundary before any comparison artifact can become
official.

**Amendment starting source:** worktree
`/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/ws-scenario-comparison`,
HEAD `9d79264a5ff786c3bb7a9820b0589ec9d3bb91f4`.

**Parent artifacts:**

- plan SHA-256
  `7981f289d7fdb044218a5c7348cc5a1fa755087d48a02acc589d127575983c16`
- design SHA-256
  `0b2b6e9ea38897ee76ea590f25916f39d2f6bce1320c096703ee68b60a4f10b6`

Status: **APPROVAL CANDIDATE — IMPLEMENTATION FORBIDDEN.** Begin the RED work
below only after an architect and an independent critic return unconditional
`APPROVED` for this exact path, SHA-256, worktree, and HEAD. An edit to this
artifact or a pre-execution HEAD change invalidates both approvals. The R1 RED
suite must then receive its own independent unconditional approval before any
GREEN implementation begins.

## Why this amendment is required

R0 correctly rejects every official report, verifier, and campaign filesystem
operation. Lexical pathname checks and `lstat`/`realpath` followed by later I/O
cannot prevent an ancestor from being replaced between check and use. An
in-memory archive can preserve bytes after ingress, but it cannot make the
initial read or final publication trustworthy. R1 therefore needs a dedicated,
reviewed Rust supervisor that owns the handle-relative boundary outside all
scenario, verifier, and report children.

The boundary is deliberately smaller than a general filesystem API. It may
read only explicitly named, manifest-declared files and create only new files
without replacement. It must not enumerate directories, follow links or
reparse points, open devices, accept arbitrary pathnames, or fall back to
`node:fs` for official I/O.

## Authority and trust model

1. Promotion authority is external to the mutable campaign artifact. The
   controller supplies reviewed expected capability, campaign-lock, source
   archive, staged-archive, and executable digests plus expected OS directory
   identities.
2. The same mutable caller may transport those values but may not derive them
   from the bytes being authorized. A digest merely recomputed from a supplied
   artifact is self-authorization and must be rejected.
3. Environment variables, artifact fields, path naming conventions, and a
   user-writable marker file are never authorization sources.
4. A capability may instead carry a verified cryptographic signature if a
   future separately approved amendment defines keys and verification. R1
   does not invent that scheme.
5. The capability binds candidate, campaign, lock digest, archive digests,
   exact Mac and Linux host submissions, staging IDs, pinned OS identities,
   issue/expiry times, and `fixtureOnly: false`.
6. Planned facts and observed facts remain separate. Route, peer, MTU, qdisc,
   process group, cleanup, telemetry, artifact, raw-sidecar, snapshot, role,
   cohort, WT primitive, and resumption observations are independently
   collected and bound; copying planned values is not observation.
7. Every validation failure is fail-closed: no promotable artifact, delta, or
   official report is written.

### Frozen authority record and provenance

The trusted controller—not a scenario role, candidate child, artifact builder,
verifier, or report process—constructs one canonical `campaign-authority/v1`
record only after the final exact-HEAD review, deterministic source-archive
receipt, both host staging submissions, and the separate final staging
approvals exist. The record has
exactly these fields; strict parsing rejects unknown, missing, duplicate, or
non-canonical fields:

```ts
interface CampaignAuthorityV1 {
  schema: "campaign-authority/v1";
  candidate: string;
  campaignId: string;
  issuedAt: string;
  notAfter: string;
  campaignReservationSha256: string;
  approval: {
    parentPlanSha256: string;
    parentDesignSha256: string;
    amendmentSha256: string;
    finalCandidateHead: string;
    sourceArchiveReceiptSha256: string;
    r1RedApprovalBundleSha256: string;
    finalArchitectApprovalSha256: string;
    finalCriticApprovalSha256: string;
    finalVerifierApprovalSha256: string;
  };
  source: {
    macHostSubmissionSha256: string;
    linuxHostSubmissionSha256: string;
    macStagedArchiveReceiptSha256: string;
    linuxStagedArchiveReceiptSha256: string;
    macLaunchProvenanceSha256: string;
    linuxLaunchProvenanceSha256: string;
    macRuntimeFactsSha256: string;
    linuxRuntimeFactsSha256: string;
    archiveSha256: string;
    macStagedArchiveSha256: string;
    linuxStagedArchiveSha256: string;
    macBunSha256: string;
    linuxBunSha256: string;
    macSupervisorSha256: string;
    linuxSupervisorSha256: string;
    macRoleEntrypointsSha256: string;
    linuxRoleEntrypointsSha256: string;
    macAddonSha256: string;
    linuxAddonSha256: string;
    macRouteToolSha256: string;
    macIfconfigToolSha256: string;
    linuxIpToolSha256: string;
    linuxTcToolSha256: string;
  };
  topology: {
    kind: "direct-cable";
    mac: { hostId: string; interface: "en8"; address: "10.99.0.1"; mtu: 1500 };
    linux: { hostId: string; interface: "eno1"; address: "10.99.0.2"; mtu: 1500 };
    sshControlReceiptSha256: string;
    tailscaleMeasurementForbidden: true;
    loopbackForbidden: true;
  };
  roots: readonly [
    { hostId: string; kind: "mac-campaign"; identity: MacosDirectoryIdentityV1 },
    { hostId: string; kind: "mac-staging"; identity: MacosDirectoryIdentityV1 },
    { hostId: string; kind: "linux-staging"; identity: LinuxDirectoryIdentityV1 },
    { hostId: string; kind: "mac-exec-parent"; identity: MacosDirectoryIdentityV1 },
  ];
}

interface LinuxDirectoryIdentityV1 {
  platform: "linux";
  deviceMajor: string; // unsigned decimal statx device major
  deviceMinor: string; // unsigned decimal statx device minor
  inode: string; // unsigned decimal st_ino, no numeric truncation
  mountId: string; // unsigned decimal STATX_MNT_ID, required
  fileSystemType: "ext4" | "xfs" | "btrfs";
  fileSystemTypeMagic: string; // lowercase hexadecimal f_type
  fsidWord0: string;
  fsidWord1: string;
  ownerUid: number;
  mode: number;
  hardLinkCount: string;
}

interface MacosDirectoryIdentityV1 {
  platform: "darwin";
  device: string; // unsigned decimal st_dev, no numeric truncation
  inode: string; // unsigned decimal st_ino, no numeric truncation
  fsidWord0: string; // unsigned decimal f_fsid word, no numeric truncation
  fsidWord1: string; // unsigned decimal f_fsid word, no numeric truncation
  fileSystemType: "apfs";
  volumeUuid: string; // lowercase 32-hex ATTR_VOL_UUID
  mountTableEntrySha256: string; // canonical getfsstat record
  canonicalDescriptorPathSha256: string; // exact F_GETPATH bytes
  ownerUid: number;
  mode: number;
  hardLinkCount: string;
}

type PosixDirectoryIdentity =
  | LinuxDirectoryIdentityV1
  | MacosDirectoryIdentityV1;
type OfficialDirectoryIdentity = PosixDirectoryIdentity;
declare const createdFileTokenBrand: unique symbol;
type CreatedFileToken = { readonly [createdFileTokenBrand]: true };

interface SourceArchiveReceiptV1 {
  schema: "source-archive-receipt/v1";
  candidate: string;
  finalCandidateHead: string;
  finalCandidateTreeOid: string;
  reviewedDiffSha256: string;
  cleanTreeProof: {
    statusBytesSha256: string;
    statusBytesSize: 0;
    unstagedDiffBytesSha256: string;
    unstagedDiffBytesSize: 0;
    stagedDiffBytesSha256: string;
    stagedDiffBytesSize: 0;
    untrackedFileCount: 0;
    allEmpty: true;
  };
  submoduleStatusSha256: string;
  submoduleStatusSize: number;
  gitVersion: string;
  gitExecutableSha256: string;
  sourceBuilderExecutableSha256: string;
  commandSetSha256: string;
  archiveRecipe: {
    kind: "git-archive-tar-head/v1";
    prefix: "source/";
    mtimeSource: "commit";
  };
  sourceArchiveSha256: string;
  sourceArchiveSize: number;
  archiveMemberInventorySha256: string;
  archiveMemberCount: number;
  producedAt: string;
}

interface R1RedApprovalRecordV1 {
  schema: "r1-red-approval/v1";
  role: "spec-reviewer" | "verifier";
  verdict: "APPROVED";
  worktree: string;
  redHead: string;
  redSuiteSha256: string;
  redFailureInventorySha256: string;
  issuedAt: string;
}

interface R1RedApprovalBundleV1 {
  schema: "r1-red-approval-bundle/v1";
  worktree: string;
  redHead: string;
  redSuiteSha256: string;
  records: readonly [R1RedApprovalRecordV1, R1RedApprovalRecordV1];
}

// records[0] is spec-reviewer and records[1] is verifier; their canonical
// byte digests must be distinct and neither record may be campaign-authored.

interface ExpectedCampaignInputsV1 {
  sourceArchiveReceiptSha256: string;
  sourceArchiveSha256: string;
  macHostSubmissionSha256: string;
  linuxHostSubmissionSha256: string;
  macStagedArchiveReceiptSha256: string;
  linuxStagedArchiveReceiptSha256: string;
  macLaunchProvenanceSha256: string;
  linuxLaunchProvenanceSha256: string;
  macRuntimeFactsSha256: string;
  linuxRuntimeFactsSha256: string;
  sshHostReceiptSha256: string;
  macStagedArchiveSha256: string;
  linuxStagedArchiveSha256: string;
  macBunSha256: string;
  linuxBunSha256: string;
  macSupervisorSha256: string;
  linuxSupervisorSha256: string;
  macRoleEntrypointsSha256: string;
  linuxRoleEntrypointsSha256: string;
  macAddonSha256: string;
  linuxAddonSha256: string;
  macRouteToolSha256: string;
  macIfconfigToolSha256: string;
  linuxIpToolSha256: string;
  linuxTcToolSha256: string;
  macCampaignParentIdentity: MacosDirectoryIdentityV1;
  macStagingIdentity: MacosDirectoryIdentityV1;
  linuxStagingIdentity: LinuxDirectoryIdentityV1;
  macExecParentIdentity: MacosDirectoryIdentityV1;
}

interface OfficialFileIdentityV1 {
  platform: "darwin" | "linux";
  device: string;
  inode: string;
  mountIdentitySha256: string;
  size: string;
  ownerUid: number;
  mode: number;
  hardLinkCount: "1";
}

interface StagedArchiveReceiptV1 {
  schema: "staged-archive-receipt/v1";
  candidate: string;
  sourceArchiveReceiptSha256: string;
  sourceArchiveSha256: string;
  hostId: string;
  platform: "darwin-arm64" | "linux-x86_64";
  stagedArchiveSha256: string;
  stagedArchiveSize: string;
  stagedMemberInventorySha256: string;
  stagedMemberCount: number;
  symlinkCount: 0;
  hardlinkCount: 0;
  deviceCount: 0;
  stagingIdentity: PosixDirectoryIdentity;
  supervisorInstanceNonceSha256: string;
  observedAt: string;
}

interface LaunchFileProvenanceV1 {
  kind: "bun" | "supervisor" | "role-entrypoint-manifest" | "role-entrypoint" | "addon" | "observation-tool";
  role: string | null;
  components: Components;
  sha256: string;
  identity: OfficialFileIdentityV1;
}

interface HostLaunchProvenanceV1 {
  schema: "host-launch-provenance/v1";
  candidate: string;
  hostId: string;
  platform: "darwin-arm64" | "linux-x86_64";
  stagedArchiveReceiptSha256: string;
  files: readonly LaunchFileProvenanceV1[]; // sorted kind, role, components
  canonicalFileSetSha256: string;
  residentSupervisorLaunch: ProcessLaunchReceiptV1;
  bunRoleLaunchContract: BunRoleLaunchContractV1;
  initialDescriptorMap: readonly DescriptorBindingV1[];
  supervisorInstanceNonceSha256: string;
  observedAt: string;
}

interface DescriptorBindingV1 {
  logicalName: string;
  fd: number;
  access: "read" | "write" | "read-write";
  kind: "regular" | "executable" | "directory" | "pipe" | "seqpacket" | "observation-file";
  closeOnExec: boolean;
  inheritedByChild: boolean;
  identitySha256: string;
}

interface ProcessLaunchReceiptV1 {
  executableSha256: string;
  executableIdentity: OfficialFileIdentityV1;
  argv: readonly string[];
  environment: readonly string[]; // sorted exact KEY=value entries
  descriptorMapSha256: string;
  startupNonceSha256: string;
  startupDigestSha256: string;
  launchedAt: string;
}

interface BunRoleLaunchContractV1 {
  argvTemplate: readonly [
    "bun",
    "--no-install",
    "--no-env-file",
    "/dev/fd/{roleFd}",
  ];
  environmentTemplate: readonly [
    "LC_ALL=C",
    "WT_COMPARISON_PROTOCOL_IN_FD={protocolInFd}",
    "WT_COMPARISON_PROTOCOL_OUT_FD={protocolOutFd}",
    "WT_COMPARISON_STARTUP_NONCE_FD={startupNonceFd}",
    "WT_COMPARISON_STRICT_ADDON_FD={addonFd}",
  ];
  inheritedLogicalDescriptors: readonly [
    "roleFd",
    "addonFd",
    "protocolInFd",
    "protocolOutFd",
    "startupNonceFd",
  ];
  cwd: "sealed-exec-root";
  pathLookup: false;
  shell: false;
  addonSpecifierTemplate: "/dev/fd/{addonFd}";
  addonLoadAttemptCount: 1;
  addonFallbackAttemptCount: 0;
}

interface BunRoleLaunchReceiptV1 {
  schema: "bun-role-launch-receipt/v1";
  hostId: string;
  runId: string;
  executionIndex: number;
  logicalRole: string;
  processOrdinal: number;
  bunSha256: string;
  roleEntrypointSha256: string;
  addonSha256: string;
  argv: readonly string[];
  environment: readonly string[];
  descriptorMap: readonly DescriptorBindingV1[];
  sealedExecutionIdentity: MacosDirectoryIdentityV1 | null;
  launchPrimitive: "linux-execveat-empty-path" | "macos-sealed-relative-posix-spawn";
  startupNonceSha256: string;
  startupDigestSha256: string;
  addonRequestedSpecifier: string;
  addonLoadAttemptCount: 1;
  addonLoadedSha256: string;
  addonFallbackCandidates: readonly [];
  socketBeforeStartupHandshake: false;
  launchedAt: string;
}

interface HostRuntimeFactsV1 {
  schema: "host-runtime-facts/v1";
  hostId: string;
  platform: "darwin-arm64" | "linux-x86_64";
  hostnameSha256: string;
  os: {
    system: "Darwin" | "Linux";
    release: string;
    versionSha256: string;
    architecture: "arm64" | "x86_64";
  };
  cpu: {
    modelSha256: string;
    logicalCpuCount: number;
    availableLogicalCpuCount: number;
    minimumAvailableLogicalCpuCount: 8;
    frequencyGovernorSha256: string;
  };
  toolchain: {
    bunVersion: "1.3.14";
    bunExecutableSha256: string;
    bunVersionOutputSha256: string;
    rustcVersion: string;
    rustcExecutableSha256: string;
    rustcVersionOutputSha256: string;
    cargoVersion: string;
    cargoExecutableSha256: string;
    cargoVersionOutputSha256: string;
    opensslVersion: string;
    opensslExecutableSha256: string;
    opensslVersionOutputSha256: string;
  };
  limits: {
    nofileSoft: string;
    nofileHard: string;
    effectiveChildNofile: string;
    minimumEffectiveChildNofile: "65536";
    ephemeralPortFirst: number;
    ephemeralPortLast: number;
    occupiedSourcePortsSha256: string;
    freeSourcePortCount: number;
    requiredFreeSourcePortCount: number;
  };
  measurementEndpoint: {
    interface: "en8" | "eno1";
    interfaceIndex: number;
    address: "10.99.0.1" | "10.99.0.2";
    peerAddress: "10.99.0.2" | "10.99.0.1";
    mtu: 1500;
    wsTcpPort: 4433;
    wtUdpPort: 4433;
    wsPortFreeAtInspection: true;
    wtPortFreeAtInspection: true;
    listeningSocketInventorySha256: string;
  };
  descriptorMapSha256: string;
  commandReceiptsSha256: string;
  observedAt: string;
}

interface BunRoleLaunchReceiptSetV1 {
  schema: "bun-role-launch-receipt-set/v1";
  candidate: string;
  campaignId: string;
  authoritySha256: string;
  lockSha256: string;
  capabilitySha256: string;
  expectedProcessCount: number;
  receipts: readonly BunRoleLaunchReceiptV1[];
  orderedReceiptSetSha256: string;
}

The expected process count and ordered `(executionIndex, logicalRole,
processOrdinal)` tuples are recomputed from the frozen role plan for all 588
executions. A missing, extra, reordered, path-launched, differently
environmented, pre-handshake-socket, second addon attempt, or fallback addon
candidate invalidates the complete campaign. `argv` and `environment` contain
the actual decimal descriptor numbers; substituting those numbers into the
single frozen logical template must reproduce the exact arrays, and the
descriptor map must account for every substituted number and every inherited
descriptor with no extras.

`HostRuntimeFactsV1` is supervisor-owned evidence, not a role report. Before a
host submission, the supervisor collects OS release/architecture, CPU model and
available logical-CPU count, exact Bun/Rust/Cargo/OpenSSL version outputs,
soft/hard/effective child `nofile`, ephemeral-port range, occupied-source-port
inventory, interface index/address/MTU, and TCP/UDP port-4433 occupancy through
the sealed `SupervisorObservationSyscalls` and approved command-runner seams.
Mac values must describe `10.99.0.1/en8`; Linux values must describe
`10.99.0.2/eno1`. TCP 4433 and UDP 4433 must both be free before every server
launch, are used sequentially rather than concurrently, and must be absent
again in the post-run cleanup receipt. A child-supplied `uname`, CPU count,
toolchain string, descriptor map, FD limit, port count, route, socket list, or
launch receipt is never authoritative.

The toolchain command set is exact and shell-free: Bun `--version`, Rustc
`--version --verbose`, Cargo `--version --verbose`, and OpenSSL `version -a`,
each through its approved descriptor and `["LC_ALL=C"]`. OS identity comes
from `uname(2)`. Mac CPU/availability/ephemeral-range facts come from the fixed
`sysctlbyname` keys `machdep.cpu.brand_string`, `hw.logicalcpu`,
`hw.logicalcpu_max`, `net.inet.ip.portrange.first`, and
`net.inet.ip.portrange.last`; its governor value is canonical
`not-applicable-darwin`. Linux CPU model, governor, and ephemeral range are
read exactly once from the three pre-opened observation descriptors, while
available CPUs come from `sched_getaffinity`; no `/proc` or `/sys` pathname is
opened by the supervisor. Every source has a fixed byte bound and raw digest.

Each final reviewer receives the two canonical runtime-facts records and their
raw approved-command receipts separately from the host submissions, computes
their expected digests independently, and records only those expected digests
in `ExpectedCampaignInputsV1`. An opaque `roleFactsSha256`, toolchain string, or
host-submission echo cannot replace the strict records. At campaign end,
`BunRoleLaunchReceiptSetV1` and the ordered per-run cleanup/network receipts
must prove the exact actual argv, sorted environment, descriptor substitutions,
addon attempt, process/port ownership, and port release for every process
declared by the frozen role plan.

interface ExactApprovalRecordV1 {
  schema: "exact-approval/v1";
  phase: "campaign-staging";
  role: "architect" | "critic" | "verifier";
  verdict: "APPROVED";
  worktree: string;
  finalCandidateHead: string;
  parentPlanSha256: string;
  parentDesignSha256: string;
  amendmentSha256: string;
  reviewedDiffSha256: string;
  sourceArchiveReceiptSha256: string;
  r1RedApprovalBundleSha256: string;
  expectedCampaignInputs: ExpectedCampaignInputsV1;
  issuedAt: string;
}

interface CampaignReservationV1 {
  schema: "campaign-reservation/v1";
  candidate: string;
  campaignId: string;
  campaignIdentity: MacosDirectoryIdentityV1;
  supervisorInstanceNonce: string;
  state: "RESERVED";
  createdAt: string;
}
```

All four authority roots are created or opened and pinned by trusted Mac/Linux
supervisors before authority serialization. They must be owned by the
supervisor UID, be real directories on the expected local filesystem, and be
neither group- nor world-writable. Created descendants use mode `0700`.

The controller receives three strict `exact-approval/v1` records—one per role,
with unique byte digests and matching exact bindings—through operator-supplied
read-only descriptors. Duplicate roles, any conditional verdict, stale HEAD,
or mismatched diff/artifact digest is rejected. It hashes their exact canonical
bytes into `approval`; it never accepts approval text from the candidate
archive or campaign directory. The controller itself is the explicit trust
root. The threat model prevents a mutable candidate child or output artifact
from minting authority; it does not claim cryptographic protection from a
compromised controller/operator.

`reviewedDiffSha256` is SHA-256 of the exact bytes from
`git diff --binary --full-index --no-ext-diff
9d79264a5ff786c3bb7a9820b0589ec9d3bb91f4..<finalCandidateHead>` under the
frozen Git version recorded by the final verifier. Reviewers receive and bind
that same byte artifact. A dirty tree or untracked production/evidence file is
rejected before approval-record ingestion.

### Frozen controller/supervisor launch protocol

`comparison-supervisor` is a new reviewed Rust binary and the only authority
constructor, role launcher, trusted network observer, qdisc mutator, and
official-root opener. The final campaign uses a three-ceremony sequence; none
of these ceremonies is performed by a TypeScript child.

First, the trusted verifier creates the source archive and
`source-archive-receipt/v1` in one clean-repository operation. It requires
`git status --porcelain=v2 -z --untracked-files=all
--ignore-submodules=none` to emit zero bytes, records `HEAD` and `HEAD^{tree}`,
hashes `git submodule status --recursive`, hashes the frozen binary diff, and
writes `git archive --format=tar --prefix=source/ HEAD` directly to a
write-only archive descriptor. It hashes those exact bytes while writing.
all three clean-tree byte streams must therefore have size zero and SHA-256 of
zero bytes, `untrackedFileCount` must be zero, and the archive member inventory
must equal the committed tree inventory. A source archive produced by a campaign
child, extracted staging tree, dirty repository, different Git version/recipe,
or later HEAD is rejected. The source receipt and source archive are separate
read-only descriptor inputs to every later host inspection and controller
ceremony.

The source builder invokes the pre-opened, approval-recorded Git executable
without a shell or PATH lookup using exactly this command set, recording argv,
exit, output size, and output digest for each:

```text
git rev-parse --verify HEAD^{commit}
git rev-parse --verify HEAD^{tree}
git status --porcelain=v2 -z --untracked-files=all --ignore-submodules=none
git diff --binary --full-index --no-ext-diff --exit-code HEAD --
git diff --cached --binary --full-index --no-ext-diff --exit-code
git submodule status --recursive
git ls-tree -r --full-tree -z HEAD
git archive --format=tar --prefix=source/ HEAD
```

The first two outputs must equal the receipt; both diff outputs and status must
be empty; `ls-tree` defines the member inventory; the final command's exact
bytes define the archive. A different argv, Git executable/version, prefix,
compression, member inventory, or output is a new source and invalidates every
approval.

Second, a trusted operator launches `inspect-host` once on Mac and once on
Linux. Each launch receives pre-opened read-only descriptors for the exact
source receipt, source archive, platform staged archive, Bun executable,
supervisor executable, canonical role-entrypoint manifest, native addon, and
observation tools. It also receives the already opened exact staging-root
directory descriptor and a 256-bit operator nonce. The supervisor hashes those
descriptor bytes, adopts that root without descendant lookup, opens only the
archive-declared role bundles and addon relative to it, and emits
one canonical `host-submission/v1` containing its full staged-archive receipt
and launch provenance. The supervisor verifies the staged archive member
inventory against the pinned staging tree without enumeration beyond the
archive-declared components; only lowercase-ASCII regular files/directories,
no links/devices, and exact byte digests are accepted. Shell extraction, `scp`
as a provenance source, and candidate-provided inventory authority are
forbidden. A role-entrypoint manifest contains a
sorted mapping from every logical role name to one Bun-bundled ESM file and
its SHA-256; bundles have no relative runtime imports. A host submission is an
observation, not approval.

Third, architect, critic, and verifier inspect the final source receipt, both
host submissions, final diff, exact R1 RED approval bundle, and staged files.
Only then do they issue the three `exact-approval/v1` records. Every record
must carry the same independently expected `ExpectedCampaignInputsV1`; a
reviewer may not copy values out of an authority or campaign artifact. The Mac
`prepare-controller` mode consumes all three approvals and recomputes every
local digest from file descriptors. It accepts the Linux submission only when
the pinned SSH receipt and a fresh Linux supervisor challenge bind it, then
requires every observed digest to equal all three approval records. The
controller copies no unapproved digest into authority. This removes the former
self-hash/self-authorization path.

The resident descriptor-only protocol is frozen below. `inspect-host`,
`prepare-controller`, `serve-host`, `run-campaign`, `verify-campaign`, and
`render-report` are states of already launched supervisors, not independent
CLIs. Exactly one Mac supervisor and one Linux supervisor OS process are
launched for an ordinary official campaign. Repeated, missing, unknown,
pathname-valued, environment-derived, or access-mode-incompatible inputs are
rejected.

```text
resident-mac (one launch; initial state inspect-host)
  --platform darwin-arm64
  --candidate <40-hex>
  --campaign-id <strict component>
  --source-receipt-fd <read-only regular-file/pipe fd>
  --red-approval-bundle-fd <read-only regular-file/pipe fd>
  --source-archive-fd <read-only regular-file fd>
  --staged-archive-fd <read-only regular-file fd>
  --staging-root-fd <read-only directory fd>
  --bun-fd <read-only regular executable fd>
  --self-fd <read-only regular executable fd>
  --role-manifest-fd <read-only regular-file fd>
  --addon-fd <read-only regular-file fd>
  --route-tool-fd <read-only regular executable fd>
  --interface-tool-fd <read-only regular executable fd>
  --rustc-fd <read-only regular executable fd>
  --cargo-fd <read-only regular executable fd>
  --openssl-fd <read-only regular executable fd>
  --exec-parent-fd <read-only APFS directory fd>
  --submission-nonce-fd <read-only 32-byte pipe fd>
  --phase-control-fd <AF_UNIX SOCK_SEQPACKET fd>
  --host-submission-out-fd <write-only pipe fd>
  --authority-out-fd <write-only pipe fd>
  --authority-digest-out-fd <write-only 32-byte pipe fd>

resident-linux (one pinned SSH session; initial state inspect-host)
  --platform linux-x86_64
  --source-receipt-fd <read-only regular-file/pipe fd>
  --red-approval-bundle-fd <read-only regular-file/pipe fd>
  --source-archive-fd <read-only regular-file fd>
  --staged-archive-fd <read-only regular-file fd>
  --staging-root-fd <read-only directory fd>
  --bun-fd <read-only regular executable fd>
  --self-fd <read-only regular executable fd>
  --role-manifest-fd <read-only regular-file fd>
  --addon-fd <read-only regular-file fd>
  --ip-tool-fd <read-only regular executable fd>
  --tc-tool-fd <read-only regular executable fd>
  --rustc-fd <read-only regular executable fd>
  --cargo-fd <read-only regular executable fd>
  --openssl-fd <read-only regular executable fd>
  --cpu-info-fd <read-only bounded /proc/cpuinfo observation fd>
  --governor-fd <read-only bounded sysfs governor observation fd>
  --ephemeral-range-fd <read-only bounded proc-sys observation fd>
  --submission-nonce-fd <read-only 32-byte pipe fd>
  --ssh-challenge-fd <read-only 32-byte pipe fd>
  --control-in-fd <read-only pipe fd>
  --control-out-fd <write-only pipe fd>
  --host-submission-out-fd <write-only pipe fd>
```

The exact staging root is supplied and adopted by descriptor; a
staging-parent descriptor, descendant name, lookup, extraction path, or
directory enumeration cannot substitute for it. The staged archive inventory
must match only archive-declared components beneath that root, and the fixed
reserved leaves `campaign-lock.json` and `staged-capability.json` must be absent
when the host submission is emitted.

After both submissions exist, the operator sends one canonical
`prepare-controller/v1` message on the Mac `SOCK_SEQPACKET` control socket and
transfers with one `SCM_RIGHTS` ancillary message exactly seven descriptors:
the architect, critic, and verifier approvals; the independently retained
Linux submission; the SSH receipt; the Mac campaign-parent directory; and the
known-hosts record used by the pinned SSH session. The Mac supervisor already
retains its own exact submission bytes. Message truncation, multiple ancillary
messages, a duplicate/missing/extra descriptor, wrong access mode, or an
identity that differs from `ExpectedCampaignInputsV1` invalidates staging.
Ordinary pipes are never claimed to transfer descriptors.

Linux receives no late local descriptor. Its transition to `serve-host` uses
only bounded canonical authority, authority-digest, lock, capability, and
phase-command frames on the already established SSH control stream. Both
resident processes retain all staged files, tools, launch inputs, root
handles, instance nonces, and control endpoints through campaign, verification,
and report publication. A lost process, descriptor, phase-control socket, SSH
session, challenge, or nonce invalidates both submissions and all later
outputs; no state may re-exec, reopen, or reacquire an approved root by
pathname.

The resident-supervisor actual argv is the platform list above in that exact
option order with each logical descriptor replaced by its decimal FD; the
environment array is exactly `["LC_ALL=C"]`. `ProcessLaunchReceiptV1` records
the expanded argv, environment, complete initial descriptor map, executable
identity/digest, startup nonce, and startup digest. No PATH, cwd-derived value,
loader variable, inherited ambient variable, additional descriptor, or option
is permitted. The Mac bootstrap uses the sealed relative launch rule below;
Linux uses `execveat(..., AT_EMPTY_PATH)`. Reviewers bind both canonical launch
receipts independently before authority can be created.

Two recovery-only Mac modes make the operator-only verify/report operations
complete without granting pathname authority. The similarly named package
scripts remain fixture-only as frozen below. These modes are separate
supervisor launches and are
admitted only from operator-preopened descriptors:

```text
verify-existing
  --authority-fd <read-only canonical authority fd>
  --authority-digest-fd <read-only 32-byte fd>
  --campaign-root-fd <read-only directory fd>
  --staging-root-fd <read-only directory fd>
  --self-fd <read-only regular executable fd>
  --bun-fd <read-only regular executable fd>
  --role-manifest-fd <read-only regular-file fd>
  --addon-fd <read-only regular-file fd>
  --exec-parent-fd <read-only APFS directory fd>

report-existing
  <the same nine descriptors as verify-existing>
```

Each mode first validates the independent authority bytes/digest, approved
executable digests, exact campaign/staging/exec-parent identities, fixed lock
and capability, reservation, and resident-produced manifest. `verify-existing`
then streams and validates the complete 3,599-descriptor set before exclusively
creating `verifier-result.json`. `report-existing` reruns the same verifier
logic, requires byte-identical `verifier-result.json`, streams the 490 measured
artifacts, and exclusively creates `report.md` then `report.json`. No resume
mode accepts candidate/campaign/path arguments, enumerates a directory, uses an
environment locator, contacts Linux, or executes scenario traffic. If the
operator-owned authority copy or any required descriptor is unavailable,
`verify-existing`/`report-existing` return
`OUTPUT_TRUST_BOUNDARY_UNAVAILABLE` before artifact access. The ordinary
resident campaign performs both phases in-process; recovery mode is not a way
to repair or promote an incomplete campaign.

`fcntl(F_GETFL)` must prove input/output access modes; `fstat` must prove
anonymous pipes or regular files as declared. Directory descriptors must be
read-only real directories owned by the supervisor UID and not group/world
writable. Executable descriptors must be regular, non-writable by group/world,
and executable by the supervisor UID. All descriptors are duplicated with
the exact close-on-exec policy, byte-bounded, consumed to EOF exactly once, and
closed deterministically. Descriptor reuse, aliases, trailing bytes, premature
EOF, extra writers, and mode mismatch are typed failures.

On Linux, the trusted operator starts every supervisor with
`execveat(self_fd,"",...,AT_EMPTY_PATH)` (or `fexecve` where equivalent) and
supplies that descriptor as `--self-fd`; Linux Bun roles use the same
descriptor-execution rule. A pathname `execve`, shell, or hash-then-path launch
is forbidden.

macOS exposes no accepted executable-descriptor primitive for this plan. The
trusted operator bootstraps the resident Mac supervisor with the same sealed
copy ceremony that the resident supervisor later uses for Bun and every
observation tool. For each executable launch, the responsible trusted process:

1. exclusively creates one fresh private directory below the approved pinned
   `mac-exec-parent` APFS descriptor;
2. streams the exact approved executable descriptor bytes into one fixed leaf
   by exclusive create while recomputing the independently expected digest;
3. requires owner UID match and link count one, syncs leaf and parent, changes
   both leaf and directory to `0500`, and proves no other directory entry ever
   existed through the native creation-token ledger;
4. reopens and rehashes the leaf relative to the retained directory descriptor,
   rechecks file/directory/volume identities immediately before launch, and
   launches only that fixed relative leaf after
   `posix_spawn_file_actions_addfchdir_np` (or its non-`_np` successor); and
5. requires the child startup nonce/digest handshake before addon load, socket
   creation, observation output, or protocol output.

Each sealed execution directory is single-launch and single-executable; it is
never adopted from staging, writable while launch is possible, or reused. Bun,
`route`, and `ifconfig` each receive distinct sealed directories. The
supervisor-bootstrap receipt and every later child/tool receipt bind the
approved source descriptor, sealed identities, exact argv/environment, startup
nonce, and digest. Absence of the API, inability to seal, extra entry, or any
digest/identity/mode/link-count drift is
`OUTPUT_EXEC_HANDLE_UNAVAILABLE`/`OUTPUT_EXEC_REPLACED`. Ordinary
`posix_spawn(path)`, PATH search, shell launch, hash-then-path launch, and a
writable staging-relative launch are forbidden. The macOS path never claims or
uses `fexecve`. This protects the stated buggy-child/race threat model; a
malicious same-UID process remains explicitly outside it.

The supervisor checks its inherited executable identity and digest against the
final approvals before accepting any other input. It launches Bun with the
platform rule above and the exact actual argv obtained by substituting the
recorded `roleFd` into
`["bun","--no-install","--no-env-file","/dev/fd/{roleFd}"]` and the exact
sorted environment obtained from `BunRoleLaunchContractV1`; there are no other
arguments or environment entries.
The role descriptor and addon descriptor are opened once relative to the
pinned staging handle, hashed, kept open across launch, and supplied as the
only non-close-on-exec content descriptors. The supervisor sets the sole
native override to `/dev/fd/<addon-fd>`; the official runtime test must prove
exactly one addon load attempt and no fallback search. If Bun cannot load the
role or addon through those inherited descriptors on either host, the campaign
is `OUTPUT_TRUST_BOUNDARY_UNAVAILABLE`; there is no pathname fallback.

The SSH client is owned by the trusted operator, uses a fixed read-only
`known_hosts` descriptor with `StrictHostKeyChecking=yes`, and emits a
canonical `ssh-host-receipt/v1` containing the known-hosts digest, negotiated
host-key algorithm/fingerprint, exact remote host ID, SSH control peer address,
session nonce, and Linux challenge response. Tailscale is permitted only for
this SSH control channel. The Linux submission and every later Linux receipt
must carry the same nonce/challenge and Linux supervisor digest. A new SSH
session, host key, challenge, or supervisor creates a new receipt and
invalidates authority.

The Mac supervisor exclusively creates the single-use campaign directory,
compares the complete source/host/approval chain, constructs canonical
authority bytes, and writes the bytes and digest to two separate
operator-owned pipes. The operator supplies the exact authority bytes+digest
to `serve-host`; Linux recomputes every local descriptor digest against
authority before launching a role. TypeScript children receive validated
authority content only as bounded supervisor frames, never as authority/root
descriptors or pathnames.

Only the supervisor/controller process owns an official campaign handle.
Scenario children receive neither the campaign descriptor nor its pathname and
can emit only bounded framed records to supervisor-owned pipes. The security
claim covers accidental/self-referential authorization, namespace races, and
buggy children; a compromised operator/supervisor or malicious same-UID host
process is explicitly outside it.

Authority/bootstrap descriptors exist only at the supervisor boundary:

- the trusted Mac supervisor consumes approval/host descriptors and retains
  staging/campaign handles; local child stdin receives validated input frames;
- over SSH, one bounded binary control frame carries authority bytes+digest to
  the trusted Linux supervisor, which already retains its staging handle;
- descriptor numbers are explicit supervisor arguments, never environment
  values, and are never forwarded to TypeScript children;
- a child cannot substitute roots, optional identities, expected digests, or
  bytes read from its own artifact.

Staged trust metadata publication is an exact post-authority activation
protocol, not an implicit path lookup:

1. The Mac resident fixes canonical authority bytes and its digest once; those
   bytes never change in response to a later receipt.
2. It derives canonical `campaign-lock.json` from that authority and canonical
   `staged-capability.json` from authority plus lock, then exclusively creates
   both fixed leaves through its retained Mac staging-root handle in that
   order, syncing each leaf and the root.
3. It sends the exact lock and capability frames to the resident Linux
   supervisor. Linux validates both before writing, exclusively creates the
   same two fixed leaves through its retained Linux staging-root handle in the
   same order, syncs each leaf and the root, and returns canonical
   `staged-metadata-receipt/v1` bytes.
4. Mac rereads/hashes its two leaves through its retained handle, constructs
   its own receipt, and requires both receipts to bind the same authority,
   lock, capability, host submission, staging identity, file identities,
   sizes, and supervisor instance nonce.
5. Only then may either supervisor enter `run-campaign`. A partial create,
   existing leaf, digest mismatch, lost SSH session, or missing sync is a typed
   activation failure; no scenario socket opens. The receipts are downstream
   observations, never inputs to authority, lock, or capability, so the digest
   graph remains acyclic. The ordered receipt pair is bound into the observed
   attestation and is mandatory for standalone verification.

No trusted process later locates a staging root. Every fixed metadata read is
relative to the already adopted root descriptor. The staged archive inventory
and receipt explicitly exclude the two reserved metadata leaves; their absence
at host inspection and exclusive post-authority creation are both verified.

The only official campaign output root is the pinned Mac campaign directory.
The Linux supervisor retains its read-only-open directory descriptor (usable
only as the `*at` anchor for supervisor-controlled reads and exclusive creates)
and emits bounded,
length-prefixed observed records/sidecars over the SSH control stream; the Mac
controller validates their declared lengths/digests and creates the official
copies through its campaign handle. Linux scenario roles never write an
official evidence pathname. Scenario network bytes still use only the physical
cable; SSH carries control/evidence bytes, not workload traffic.

Each child may report runtime/addon diagnostics, but those values are never
launch authority. Launch identity comes only from the supervisor-held Bun,
role, and addon descriptors and the supervisor-owned platform launch plus
descriptor-load receipt. A child-supplied path, cwd, digest, environment
override, or identity
cannot repair a mismatch and is non-promotable.

If the platform/runtime cannot inherit and validate these descriptors, the
entrypoint returns `OUTPUT_TRUST_BOUNDARY_UNAVAILABLE` before pathname access.

### Acyclic digest graph and invalidation

The binding graph is one-way and exact:

```text
final approvals + final HEAD + source/executables + pinned roots + reservation
  -> authoritySha256
  -> campaign lock (contains authoritySha256)
  -> capability (contains authoritySha256 + lockSha256)
  -> run/raw/snapshot records (contain authoritySha256 + lockSha256 + capabilitySha256)
  -> manifest (contains those three parent hashes and hashes every record)
  -> verifier result (adds manifestSha256)
  -> report (adds verifierResultSha256)
```

No ancestor contains a descendant digest. Artifacts do not contain the
manifest digest that hashes them. Any amendment/parent-plan/design edit,
candidate HEAD change, archive/executable change, role/registry/capacity/tool
change, staging/root identity change, or final-review change invalidates the
authority and everything below it. A new campaign ID and fresh authority are
required; old outputs remain quarantined.

### Frozen registry, execution, and descriptor expansion

The parent design's 35 cells, 82 arms, balanced blocks, warmups, repetitions,
and adjacent overlays expand exactly as follows. This table is the independent
literal oracle; GREEN must not derive its expected values from production
registry or scheduling helpers. `seed` is `20260824 + cellIndex`.

| cellIndex | cellId | warmup/measured repetitions per primary transport | first primary transport | overlay |
| ---: | --- | --- | --- | --- |
| 0 | `chat-fanout/subscribers-1000` | 1/5 | WT | no |
| 1 | `chat-fanout/subscribers-5000` | 1/5 | WT | no |
| 2 | `chat-fanout/subscribers-10000` | 1/5 | WS | no |
| 3 | `ticker-fanout/rate-10000` | 1/5 | WS | no |
| 4 | `ticker-fanout/rate-50000` | 1/5 | WS | no |
| 5 | `ticker-fanout/rate-100000` | 1/5 | WT | no |
| 6 | `game-tick-loss/tick-20-loss-1-delay-20` | 1/5 | WT | yes |
| 7 | `game-tick-loss/tick-20-loss-1-delay-40` | 1/5 | WS | yes |
| 8 | `game-tick-loss/tick-20-loss-2.5-delay-20` | 1/5 | WS | yes |
| 9 | `game-tick-loss/tick-20-loss-2.5-delay-40` | 1/5 | WT | yes |
| 10 | `game-tick-loss/tick-20-loss-5-delay-20` | 1/5 | WS | yes |
| 11 | `game-tick-loss/tick-20-loss-5-delay-40` | 1/5 | WS | yes |
| 12 | `game-tick-loss/tick-60-loss-1-delay-20` | 1/5 | WT | yes |
| 13 | `game-tick-loss/tick-60-loss-1-delay-40` | 1/5 | WS | yes |
| 14 | `game-tick-loss/tick-60-loss-2.5-delay-20` | 1/5 | WS | yes |
| 15 | `game-tick-loss/tick-60-loss-2.5-delay-40` | 1/5 | WS | yes |
| 16 | `game-tick-loss/tick-60-loss-5-delay-20` | 1/5 | WS | yes |
| 17 | `game-tick-loss/tick-60-loss-5-delay-40` | 1/5 | WT | yes |
| 18 | `reconnect-storm/cold-full` | 1/5 | WS | no |
| 19 | `reconnect-storm/warm-after-prime` | 1/5 | WT | no |
| 20 | `connection-memory/live-1000` | 1/5 | WS | no |
| 21 | `connection-memory/live-5000` | 1/5 | WS | no |
| 22 | `connection-memory/live-10000` | 1/5 | WT | no |
| 23 | `crdt-sync/default` | 1/5 | WS | no |
| 24 | `ai-token-stream/chunk-32` | 1/5 | WT | no |
| 25 | `ai-token-stream/chunk-64` | 1/5 | WT | no |
| 26 | `ai-token-stream/chunk-128` | 1/5 | WT | no |
| 27 | `ai-token-stream/chunk-256` | 1/5 | WS | no |
| 28 | `handshake-matrix/physical-cold` | 3/15 | WS | no |
| 29 | `handshake-matrix/physical-warm-after-prime` | 3/15 | WS | no |
| 30 | `handshake-matrix/delay40-cold` | 3/15 | WS | no |
| 31 | `handshake-matrix/delay40-warm-after-prime` | 3/15 | WS | no |
| 32 | `bulk-one-way/physical` | 1/5 | WS | no |
| 33 | `bulk-one-way/delay40-loss1` | 1/5 | WT | no |
| 34 | `tail-under-cross-traffic/default` | 1/5 | WT | no |

Each cell has exactly two primary arms, `${cellId}/ws` and `${cellId}/wt`,
both with `armKind:"primary"`. Each `overlay:yes` row also has exactly
`${cellId}/ws-overlay` with `transport:"ws"`, `armKind:"overlay"`, and
`overlayOf:${cellId}/ws`. `ws-lossy-overlay` is not a transport or arm-kind
discriminant.

Global schedule order is table order. Within a cell, warmup precedes measured.
`repetitionIndex` is zero-based independently within each `(cell, phase,
transport)` arm: a phase with count `r` has exactly the indexes `0...r-1` for
each primary transport. For a phase with first transport `S`, other transport
`O`, and `r` repetitions, every complete pair starting at the even index
`k = 2*j` expands as `S@k,O@k,O@(k+1),S@(k+1)`. When `r` is odd, the sole tail
uses index `r-1` and expands as `S@(r-1),O@(r-1)`.
Immediately after each WS primary in an overlay cell, append the matching WS
overlay with the same phase and repetition. Nothing may appear between that WS
primary and overlay. `executionIndex` is then assigned monotonically `0...587`.
The canonical schedule hash covers the exact ordered array of
`executionIndex`, `cellIndex`, `cellId`, `scenarioId`, `phase`, `armId`,
`transport`, `armKind`, nullable `overlayOf`, `repetitionIndex`, `seed`, and the
fixed Mac/Linux role and endpoint identities.

The arithmetic is fixed and is itself tested:

- primary warmups: `31*2*1 + 4*2*3 = 86`; overlay warmups: `12*1 = 12`;
  total warmups: **98**;
- primary measured: `31*2*5 + 4*2*15 = 430`; overlay measured:
  `12*5 = 60`; total measured: **490**;
- total execution entries and artifacts: **588**;
- five raw descriptors for each execution: **2,940**;
- one pre and one post snapshot for each cell: **70**;
- one campaign attestation: **1**;
- manifest descriptors: `588 + 2940 + 70 + 1 =` **3,599**.

`runId` is exactly
`${phase}/${armId}/rep-${repetitionIndex.toString().padStart(2,"0")}`.
`runToken` and `cellToken` replace every `/` with `__` and perform no other
normalization. Exact component arrays are:

```text
artifact       ["official","artifacts","<runToken>.json"]
raw-client     ["official","raw","<runToken>","client.ndjson"]
raw-server     ["official","raw","<runToken>","server.ndjson"]
raw-topology   ["official","raw","<runToken>","topology.ndjson"]
raw-impairment ["official","raw","<runToken>","impairment.ndjson"]
raw-cleanup    ["official","raw","<runToken>","cleanup.ndjson"]
snapshot-pre   ["official","cell-snapshots","<cellToken>","pre.ndjson"]
snapshot-post  ["official","cell-snapshots","<cellToken>","post.ndjson"]
attestation    ["official","observed-attestation.json"]
```

Manifest descriptor order is not set-like: for execution indexes `0...587`,
append `artifact`, `raw-client`, `raw-server`, `raw-topology`,
`raw-impairment`, and `raw-cleanup` in that order; then, for cell indexes
`0...34`, append `snapshot-pre`, `snapshot-post`; append `attestation` last.
Artifact and raw-client descriptors use the authority's Mac host ID;
raw-server, raw-topology, raw-impairment, and raw-cleanup use the Linux host ID.
Snapshots and attestation use the Mac controller host ID. Run descriptors carry
the exact run/cell/execution identity. Snapshots carry their cell ID with null
run/execution; attestation carries `cellId:"campaign"` with null run/execution.
No other null or host mapping is accepted. That uniquely defines all 3,599
positions. Artifacts contain child-authored
metrics inside a supervisor wrapper; `raw-client` and `raw-server` contain
bounded role telemetry inside supervisor wrappers. Only supervisors construct
`raw-topology`, `raw-impairment`, `raw-cleanup`, snapshots, attestation,
descriptor envelopes, and their trust fields. A child cannot submit any of
those authoritative kinds.

### Frozen downstream records and ordering

All trust records use UTF-8 canonical JSON: recursively sorted object keys,
original array order, no duplicate keys, no unknown keys, no BOM, no trailing
bytes, no `undefined`/NaN/infinity, integers only where declared, lowercase
64-hex SHA-256, RFC 3339 UTC timestamps, and a terminal newline. Parsers hash
the exact bytes before parsing, then reserialize and require byte equality.

The following schemas are complete trust envelopes. Scenario/artifact payload
objects are separately frozen by the parent design and registry hash; they may
not add trust authority.

```ts
type Sha256 = string;
type Components = readonly [string, ...string[]];

interface CardinalityV1 {
  cellCount: 35;
  armCount: 82;
  wsPrimaryArmCount: 35;
  wtPrimaryArmCount: 35;
  overlayArmCount: 12;
  primaryWarmupCount: 86;
  primaryMeasuredCount: 430;
  overlayWarmupCount: 12;
  overlayMeasuredCount: 60;
  warmupExecutionCount: 98;
  measuredExecutionCount: 490;
  primaryExecutionCount: 516;
  executionCount: 588;
  wsPrimaryExecutionCount: 258;
  wtPrimaryExecutionCount: 258;
  wsOverlayExecutionCount: 72;
  artifactCount: 588;
  rawClientCount: 588;
  rawServerCount: 588;
  rawTopologyCount: 588;
  rawImpairmentCount: 588;
  rawCleanupCount: 588;
  rawDescriptorCount: 2940;
  snapshotPreCount: 35;
  snapshotPostCount: 35;
  snapshotDescriptorCount: 70;
  attestationCount: 1;
  descriptorCount: 3599;
}

interface HostSubmissionV1 {
  schema: "host-submission/v1";
  hostId: string;
  platform: "darwin-arm64" | "linux-x86_64";
  stagingIdentity: PosixDirectoryIdentity;
  execParentIdentity: MacosDirectoryIdentityV1 | null;
  sourceArchiveReceiptSha256: Sha256;
  redApprovalBundleSha256: Sha256;
  sourceArchiveSha256: Sha256;
  stagedArchiveReceipt: StagedArchiveReceiptV1;
  stagedArchiveReceiptSha256: Sha256;
  launchProvenance: HostLaunchProvenanceV1;
  launchProvenanceSha256: Sha256;
  runtimeFacts: HostRuntimeFactsV1;
  runtimeFactsSha256: Sha256;
  stagedArchiveSha256: Sha256;
  bunSha256: Sha256;
  supervisorSha256: Sha256;
  roleEntrypointsSha256: Sha256;
  addonSha256: Sha256;
  routeToolSha256: Sha256;
  interfaceToolSha256: Sha256;
  submissionNonceSha256: Sha256;
  reservedStagingMetadataComponentsAbsent: true;
  observedAt: string;
}

interface SshHostReceiptV1 {
  schema: "ssh-host-receipt/v1";
  linuxHostId: string;
  knownHostsSha256: Sha256;
  hostKeyAlgorithm: string;
  hostKeyFingerprintSha256: Sha256;
  controlPeerAddress: string; // control only; never a measurement address
  sessionNonceSha256: Sha256;
  linuxChallengeResponseSha256: Sha256;
  linuxSupervisorSha256: Sha256;
  connectedAt: string;
}

interface CampaignLockV1 {
  schema: "campaign-lock/v1";
  authoritySha256: Sha256;
  candidate: string;
  campaignId: string;
  sourceArchiveReceiptSha256: Sha256;
  r1RedApprovalBundleSha256: Sha256;
  sourceArchiveSha256: Sha256;
  registryHash: Sha256;
  scheduleHash: Sha256;
  capacityProfileHash: Sha256;
  tlsPlanHash: Sha256;
  topologyPlanHash: Sha256;
  executionPlanHash: Sha256;
  cardinality: CardinalityV1;
  createdAt: string;
}

interface StagedCapabilityV1 {
  schema: "staged-capability/v1";
  authoritySha256: Sha256;
  lockSha256: Sha256;
  candidate: string;
  campaignId: string;
  sourceArchiveReceiptSha256: Sha256;
  r1RedApprovalBundleSha256: Sha256;
  sourceArchiveSha256: Sha256;
  macStagedArchiveSha256: Sha256;
  linuxStagedArchiveSha256: Sha256;
  hostSubmissions: readonly [HostSubmissionV1, HostSubmissionV1];
  sshHostReceiptSha256: Sha256;
  macCampaignIdentity: PosixDirectoryIdentity;
  issuedAt: string;
  notAfter: string;
  fixtureOnly: false;
}

interface StagedMetadataReceiptV1 {
  schema: "staged-metadata-receipt/v1";
  hostId: string;
  platform: "darwin-arm64" | "linux-x86_64";
  authoritySha256: Sha256;
  lockSha256: Sha256;
  lockSize: number;
  lockIdentity: OfficialFileIdentityV1;
  capabilitySha256: Sha256;
  capabilitySize: number;
  capabilityIdentity: OfficialFileIdentityV1;
  hostSubmissionSha256: Sha256;
  stagingIdentity: PosixDirectoryIdentity;
  supervisorSha256: Sha256;
  supervisorInstanceNonceSha256: Sha256;
  leafAndParentSyncComplete: true;
  activatedAt: string;
}

interface EvidenceDescriptorV1 {
  schema: "evidence-descriptor/v1";
  kind:
    | "artifact"
    | "raw-client"
    | "raw-server"
    | "raw-topology"
    | "raw-impairment"
    | "raw-cleanup"
    | "snapshot-pre"
    | "snapshot-post"
    | "attestation";
  components: Components;
  sha256: Sha256;
  size: number;
  candidate: string;
  campaignId: string;
  authoritySha256: Sha256;
  lockSha256: Sha256;
  capabilitySha256: Sha256;
  hostId: string;
  cellId: string;
  runId: string | null;
  executionIndex: number | null;
}

interface ObservedAttestationV1 {
  schema: "observed-attestation/v1";
  authoritySha256: Sha256;
  lockSha256: Sha256;
  capabilitySha256: Sha256;
  candidate: string;
  campaignId: string;
  observedSource: {
    archiveSha256: Sha256;
    macStagedArchiveSha256: Sha256;
    linuxStagedArchiveSha256: Sha256;
    macBunSha256: Sha256;
    linuxBunSha256: Sha256;
    macSupervisorSha256: Sha256;
    linuxSupervisorSha256: Sha256;
    macRoleEntrypointsSha256: Sha256;
    linuxRoleEntrypointsSha256: Sha256;
    macAddonSha256: Sha256;
    linuxAddonSha256: Sha256;
  };
  sshHostReceiptSha256: Sha256;
  stagedMetadataReceiptSetSha256: Sha256;
  supervisorObservationSetSha256: Sha256;
  macRouteFactsSha256: Sha256;
  linuxRouteFactsSha256: Sha256;
  serverPeerFactsSha256: Sha256;
  qdiscFactsSha256: Sha256;
  tlsFactsSha256: Sha256;
  roleFactsSha256: Sha256;
  bunRoleLaunchReceiptSetSha256: Sha256;
  macRuntimeFactsSha256: Sha256;
  linuxRuntimeFactsSha256: Sha256;
  wtFactsSha256: Sha256;
  telemetryFactsSha256: Sha256;
  cleanupFactsSha256: Sha256;
  runFactsSha256: Sha256;
  pathSnapshotCount: 70;
  runNetworkReceiptCount: 588;
  qdiscRunReceiptCount: 588;
  cleanupRunReceiptCount: 588;
  childAuthoredObservationForbidden: true;
  observedAt: string;
}

interface SupervisorCommandReceiptV1 {
  schema: "supervisor-command-receipt/v1";
  hostId: string;
  supervisorSha256: Sha256;
  toolSha256: Sha256;
  argv: readonly string[];
  sanitizedEnvironmentSha256: Sha256;
  exitCode: number;
  stdoutSha256: Sha256;
  stdoutSize: number;
  stderrSha256: Sha256;
  stderrSize: number;
  startedAt: string;
  completedAt: string;
}

interface SupervisorPathReceiptV1 {
  schema: "supervisor-path-receipt/v1";
  hostId: string;
  platform: "darwin-arm64" | "linux-x86_64";
  supervisorSha256: Sha256;
  phase: "pre-cell" | "post-cell";
  cellId: string;
  interface: "en8" | "eno1";
  interfaceIndex: number;
  sourceAddress: "10.99.0.1" | "10.99.0.2";
  destinationAddress: "10.99.0.2" | "10.99.0.1";
  mtu: 1500;
  routeCommandReceiptSha256: Sha256;
  interfaceCommandReceiptSha256: Sha256;
  socketRouteProbeSha256: Sha256;
  capturedAt: string;
}

interface SupervisorRunReceiptBaseV1 {
  linuxHostId: string;
  linuxSupervisorSha256: Sha256;
  runId: string;
  executionIndex: number;
  transport: "ws" | "wt";
  interface: "eno1";
  interfaceIndex: number;
  macAddress: "10.99.0.1";
  linuxAddress: "10.99.0.2";
}

type SupervisorRunNetworkReceiptV1 =
  | (SupervisorRunReceiptBaseV1 & {
      schema: "supervisor-run-network-receipt/v1";
      status: "OBSERVED";
      serverPort: 4433;
      protocol: "tcp" | "udp";
      peerObservation: "inet-diag" | "af-packet";
      serverPgid: number;
      packetsMacToLinux: number;
      packetsLinuxToMac: number;
      bytesMacToLinux: number;
      bytesLinuxToMac: number;
      captureDropCount: 0;
      firstPacketAt: string;
      lastPacketAt: string;
      capturedHeaderDigestSha256: Sha256;
    })
  | (SupervisorRunReceiptBaseV1 & {
      schema: "supervisor-run-network-receipt/v1";
      status: "BLOCKED_BEFORE_TRAFFIC";
      blockerCode: string;
      packetsMacToLinux: 0;
      packetsLinuxToMac: 0;
      bytesMacToLinux: 0;
      bytesLinuxToMac: 0;
      captureDropCount: 0;
      blockedAt: string;
    });

interface SupervisorQdiscReceiptBaseV1 {
  schema: "supervisor-qdisc-receipt/v1";
  linuxHostId: string;
  linuxSupervisorSha256: Sha256;
  runId: string;
  executionIndex: number;
  interface: "eno1";
  expectedProfileHash: Sha256;
  beforeCommandReceiptSha256: Sha256;
  beforeKind: "fq";
}

type SupervisorQdiscReceiptV1 =
  | (SupervisorQdiscReceiptBaseV1 & {
      status: "RESTORED";
      applyCommandReceiptSha256: Sha256 | null;
      activeCommandReceiptSha256: Sha256;
      restoreCommandReceiptSha256: Sha256 | null;
      afterCommandReceiptSha256: Sha256;
      activeKind: "fq" | "netem";
      afterKind: "fq";
      restored: true;
      completedAt: string;
    })
  | (SupervisorQdiscReceiptBaseV1 & {
      status: "BLOCKED_BEFORE_MUTATION";
      blockerCode: string;
      afterCommandReceiptSha256: Sha256;
      afterKind: "fq";
      restored: true;
      blockedAt: string;
    })
  | (SupervisorQdiscReceiptBaseV1 & {
      status: "FAILED_RESTORATION";
      failureCode: string;
      applyCommandReceiptSha256: Sha256;
      activeCommandReceiptSha256: Sha256;
      restoreCommandReceiptSha256: Sha256;
      afterCommandReceiptSha256: Sha256;
      activeKind: "netem";
      afterKind: string;
      restored: false;
      failedAt: string;
    });

interface SupervisorCleanupReceiptBaseV1 {
  schema: "supervisor-cleanup-receipt/v1";
  runId: string;
  executionIndex: number;
  macSupervisorSha256: Sha256;
  linuxSupervisorSha256: Sha256;
  macPgid: number;
  linuxPgid: number;
}

type SupervisorCleanupReceiptV1 =
  | (SupervisorCleanupReceiptBaseV1 & {
      status: "CLEAN";
      allOwnedChildrenReaped: true;
      noOwnedSocketsRemain: true;
      tcp4433ListenerAbsent: true;
      udp4433ListenerAbsent: true;
      qdiscRestored: true;
      completedAt: string;
    })
  | (SupervisorCleanupReceiptBaseV1 & {
      status: "FAILED";
      failureCodes: readonly string[];
      allOwnedChildrenReaped: boolean;
      noOwnedSocketsRemain: boolean;
      tcp4433ListenerAbsent: boolean;
      udp4433ListenerAbsent: boolean;
      qdiscRestored: boolean;
      failedAt: string;
    });

interface CampaignManifestV1 {
  schema: "campaign-manifest/v1";
  authoritySha256: Sha256;
  lockSha256: Sha256;
  capabilitySha256: Sha256;
  candidate: string;
  campaignId: string;
  registryHash: Sha256;
  scheduleHash: Sha256;
  cardinality: CardinalityV1;
  descriptors: readonly EvidenceDescriptorV1[];
  sealedAt: string;
}

interface CampaignVerifierResultV1 {
  schema: "campaign-verifier-result/v1";
  authoritySha256: Sha256;
  lockSha256: Sha256;
  capabilitySha256: Sha256;
  manifestSha256: Sha256;
  candidate: string;
  campaignId: string;
  evidenceStatus: "PASS" | "FAIL" | "BLOCKED";
  scenarioVerdict: "PASS" | "MISS" | "NO_VERDICT";
  promotable: boolean;
  comparisonRowCount: number; // integer 0...35
  failures: readonly string[];
  verifiedAt: string;
}

interface CampaignReportV1 {
  schema: "campaign-report/v1";
  authoritySha256: Sha256;
  lockSha256: Sha256;
  capabilitySha256: Sha256;
  manifestSha256: Sha256;
  verifierResultSha256: Sha256;
  reportMarkdownSha256: Sha256;
  candidate: string;
  campaignId: string;
  comparisonRowCount: number; // integer 0...35
  renderedAt: string;
}
```

`hostSubmissions[0]` is exactly the Mac submission and `[1]` the Linux
submission; host IDs/platforms/root identities and every digest must equal the
corresponding authority fields. Each direct Bun/supervisor/role/addon/tool
digest is a convenience projection derived from the embedded launch-provenance
file set; the controller recomputes it and rejects any disagreement. Each
staged archive digest/identity likewise derives from the embedded staged
receipt. Bare projections can never authorize missing receipt/provenance
bytes. Arrays elsewhere are ordered by execution
index and then the frozen descriptor-kind order; set-like reordering is not
accepted. Lock, manifest, and verifier independently recompute every
`CardinalityV1` member from the literal registry and schedule and require exact
equality; an internally consistent but wrong count object is rejected.

Exact bootstrap and publication order:

1. Consume and validate authority bytes/digest from supervisor-owned pipes.
2. Through the pinned campaign handle, read exactly
   `.campaign-reservation.json` and require its digest/identity to equal
   authority. Through the pinned staging handle, read exactly
   `campaign-lock.json`, hash
   and validate it against authority; then read exactly
   `staged-capability.json`, hash and validate it against authority+lock.
   Require the ordered Mac/Linux staged-metadata receipts from the activation
   protocol to match those exact bytes and retained root/file identities.
3. Execute roles. Each untrusted framed record is parsed, bound to all three
   parent hashes, and written exclusively by the supervisor. Write the observed
   attestation after every cleanup/restoration fact is complete.
4. Write `manifest.json` last; require exactly 3,599 unique descriptors, exact
   kind counts, unique canonical component arrays, and byte/hash/identity
   agreement for every declared file. A manifest never names itself.
5. The verifier bootstraps only the same fixed lock, capability, and manifest
   names, then reads exactly manifest descriptors. It writes the fixed
   `verifier-result.json` exclusively; that file is not a manifest descriptor.
6. The report process first reads and validates fixed
   `verifier-result.json`, then exactly the 490 already validated measured
   artifacts in exact measured-schedule order: 430 primary plus 60 visible
   overlays interleaved immediately after their paired WS entries; warmups are
   excluded. Only the 430 primary artifacts may feed 35
   WS/WT delta rows. It
   writes `report.md`, followed by `report.json` containing the Markdown digest;
   neither report file is a manifest descriptor.
7. Only an externally consumed `report.json` whose entire parent chain and
   `PASS/PASS/promotable:true` verifier tuple validate may be advertised as an
   official comparison. `PASS/MISS` numbers remain visible but nonpromotable.

### Supervisor-owned direct-cable observation contract

Planned topology values and child telemetry are never evidence of the network
path. The Mac and Linux supervisors independently obtain the authoritative
facts and serialize the receipt schemas above. A role child may only provide
application metrics and a non-authoritative cross-check; it cannot provide a
route, interface, MTU, qdisc, packet, server-peer, process, cleanup, tool, or
SSH-host receipt, nor raw bytes later relabeled as one.

The Mac supervisor copies and executes the approved `route` and `ifconfig`
descriptor bytes only through the sealed relative `posix_spawn` ceremony above,
with exact argv respectively `["route","-n","get","10.99.0.2"]` and
`["ifconfig","en8"]` and an environment containing exactly `LC_ALL=C`. The
macOS path never uses `fexecve`. It also performs its own
`if_nametoindex("en8")`, `SIOCGIFMTU`, and UDP `connect(10.99.0.2)` plus
`getsockname` route probe. All sources must independently resolve to
`10.99.0.1`, interface `en8`, the same positive MTU, and the approved Mac host
ID. No packet is sent by the UDP connect probe. Any route that selects `lo0`,
`utun*`, another source, another interface, or another destination is a hard
pre-cell blocker.

The Linux supervisor executes, by `fexecve` of approved descriptors and the
same sanitized locale, exactly `/usr/sbin/ip -j route get 10.99.0.1 from
10.99.0.2`, `/usr/sbin/ip -j address show dev eno1`, and `/usr/sbin/tc -j
qdisc show dev eno1`. It independently checks `if_nametoindex("eno1")` and
`SIOCGIFMTU`. The route must select source `10.99.0.2`, destination
`10.99.0.1`, and device `eno1`; addresses from `lo`, `tailscale*`, `tun*`,
`wg*`, or any other device are forbidden.

Only the Linux supervisor invokes `tc`. For a physical profile it observes
`fq` without mutation. For an impaired profile it records `fq`, applies the
one registry-declared `netem` argv, records the active exact profile, restores
`fq` in its cleanup guard, and records the final `fq`. Every invocation is a
`SupervisorCommandReceiptV1`; shell strings, PATH lookup, `sudo`, and
child-supplied arguments are forbidden. Missing privilege or a non-`fq`
precondition is `BLOCKED/NO_VERDICT` before workload traffic. A failed or
different restore is `FAIL/NO_VERDICT`, stops subsequent runs, and can never be
reclassified as a product MISS.

For every schedule entry that passes preflight, before role release the Linux
supervisor opens an `AF_PACKET/SOCK_RAW` observer bound to the numeric ifindex
for `eno1`, installs a kernel filter for only `10.99.0.1 <-> 10.99.0.2` and the
run's approved server port/protocol, enables kernel timestamps, and starts with
zero dropped packets. The observer retains headers only (snap length 128), not
application payload. WS peer identity is additionally resolved through
`NETLINK_SOCK_DIAG` to a TCP socket inode owned by the recorded Linux server
PGID. WT peer identity is derived from the supervisor's UDP packet headers on
`eno1` and cross-checked against the addon session event; the child event alone
has no authority. Each executed run requires positive packet and byte counts in both
directions, exact endpoints/interface/protocol, the owned server PGID, and
`captureDropCount:0`. Missing `CAP_NET_RAW`, packet observation, PGID ownership,
or peer agreement is a typed blocker/failure; no loopback, same-host, Tailscale,
or child-echo fallback exists. A genuine pre-traffic external blocker produces
the alternate `BLOCKED_BEFORE_TRAFFIC` network receipt with zero counters and
no numeric metric/delta; it does not invent a packet receipt. Thus the ordered
network-receipt set still has exactly 588 entries while observed packet counts
remain honest.

Pre/post `SupervisorPathReceiptV1` records are captured on both hosts for every
cell and combined into that cell's two snapshot descriptors. Per-run packet,
qdisc, and cleanup receipts become supervisor-authored topology, impairment,
and cleanup raw descriptors. The attestation hashes the ordered receipt set
and requires 70 path snapshots plus 588 network, qdisc, and cleanup receipts.
The verifier compares these receipts to the approved tool, supervisor, host,
schedule, and topology identities before reading any numeric metric. This
supervisor-observed path proof is mandatory for WS, WT, warmup, measured, and
overlay entries alike.

## Supervisor filesystem and IPC contract

`comparison-supervisor` keeps opaque Rust `OfficialDirectory`,
`OfficialReadStream`, `OfficialWriteStream`, and `CreatedFileToken` values in
its own process. No NAPI export, TypeScript object, scenario child, verifier
child, or report child can acquire them. Its internal API is:

```rust
fn adopt_staging(fd: RawFd, expected: PosixDirectoryIdentity)
  -> Result<OfficialDirectory>;
fn create_campaign_exclusive(
  parent_fd: RawFd,
  candidate: &str,
  campaign_id: &str,
) -> Result<(OfficialDirectory, PosixDirectoryIdentity, CampaignReservation)>;
fn open_read_stream(dir: &OfficialDirectory, components: &[Component], max: u64)
  -> Result<OfficialReadStream>;
fn read_chunk(stream: &mut OfficialReadStream, out: &mut [u8])
  -> Result<usize>;
fn finish_read(stream: OfficialReadStream) -> Result<FileDigest>;
fn hash_file(dir: &OfficialDirectory, components: &[Component], max: u64)
  -> Result<FileDigest>;
fn ensure_directory(dir: &OfficialDirectory, components: &[Component])
  -> Result<()>;
fn create_file_stream_exclusive(
  dir: &OfficialDirectory,
  components: &[Component],
  max: u64,
) -> Result<(OfficialWriteStream, CreatedFileToken)>;
fn write_chunk(stream: &mut OfficialWriteStream, bytes: &[u8]) -> Result<()>;
fn finish_file(stream: OfficialWriteStream, token: CreatedFileToken)
  -> Result<CreatedFileToken>;
fn abort_created_file(dir: &OfficialDirectory, token: CreatedFileToken)
  -> Result<()>;
fn sync(dir: &OfficialDirectory) -> Result<()>;
```

Contract rules:

- Each component is validated in the Rust supervisor. Empty, `.`, `..`,
  separators, NUL, absolute paths, drive prefixes, UNC syntax, ADS syntax,
  reserved device names, and platform aliases are rejected.
- The supervisor pins every root for the complete operation. A later ancestor
  rename or replacement cannot redirect reads, writes, sync, or cleanup.
- Intermediates must be real directories. Leaf reads must be bounded regular
  files. Directory, link, socket, FIFO, block/character device, and reparse
  leaves are rejected.
- There is no root pathname or optional identity input after bootstrap. The
  supervisor duplicates and owns inherited descriptors, rejects non-directory
  roots, and matches required OS identities before reading a child.
- `open_read_stream` rejects a non-positive/excessive bound before allocation,
  snapshots the admitted size, detects growth/truncation, and never exposes a
  whole-file buffer. `hash_file` uses the same stream without exposing bytes to
  JS.
- `create_file_stream_exclusive` is create-new only, mode `0600`, never
  replaces a destination, and returns a writer plus opaque token bound to
  supervisor instance, campaign reservation, parent identity, leaf identity,
  byte bound, and operation. `finish_file` succeeds only after exact EOF,
  cumulative-size validation, digest completion, leaf sync, and parent sync.
- `abort_created_file` accepts only that token and may remove only the still
  matching uncommitted leaf. There is no component-based deletion surface.
- `sync` durably synchronizes created files and pinned parents before success.
- Close is deterministic and idempotent; other operations after close fail
  `OUTPUT_HANDLE_CLOSED`.
- No operation starts the WebTransport Tokio runtimes or permits unbounded
  buffering.
- There is no `readdir`, glob, rename, replace, arbitrary-open, or pathname
  escape. The supervisor reads the manifest, then exactly its components.

The live payload-memory ceiling is **2,097,152 bytes per process per
direction**, including codec buffers and in-flight filesystem chunks. A
supervisor or official child uses at most one reusable 1 MiB chunk plus bounded
parser/digest state in a direction; it must not retain the preceding chunk when
requesting the next. Authority, approval, submission, receipt, reservation,
lock, capability, descriptor, command, error, and report-envelope records must
each fit in one bounded metadata frame. Every admitted class that may exceed 2
MiB—including an artifact, raw file, snapshot, attestation, manifest, verifier
result, or report Markdown—remains streaming end-to-end. It may not become one
Rust `Vec<u8>`, JS `Uint8Array`, JS string, or whole parsed object.

Canonical JSON validation for large records is incremental and native. The
manifest validator emits one already validated descriptor declaration at a
time; verifier/report children receive a bounded stream of declarations and
payload chunks, never the full manifest. Large child output is streamed
directly into an uncommitted native exclusive writer while hashing and parsing;
only `finish_file` can publish it. Raw sidecar bytes are hashed/copied by the
supervisors and never enter a JS heap. Short read/write, `EINTR`, zero progress,
declared-size exhaustion, overrun, `ENOSPC`, parser failure, child failure, or
digest mismatch aborts the matching native token and drains/kills the child
before another frame. No temporary final-name file is ever treated as
committed.

Children communicate only over inherited stdin/stdout pipes using this binary
frame, with stderr reserved for bounded logs:

```text
4-byte big-endian canonical-header length (max 64 KiB)
canonical SupervisorFrameV1 JSON header
8-byte big-endian payload length (bounded by frame kind)
payload bytes in chunks no larger than 1 MiB
32-byte SHA-256 of exact payload bytes
```

`SupervisorFrameV1` has exactly `schema:"comparison-supervisor-frame/v1"`,
monotonic `sequence`, `direction:"input"|"output"`, `kind`, all three parent
digests, candidate, campaign ID, optional run/cell/execution identity, payload
size, and payload SHA-256. Campaign role children may emit only
`artifact-payload`, `client-telemetry`, or `server-telemetry`; the Mac role may
emit the first two and the Linux role only the third. Supervisors, never role
children, construct the five raw kinds, snapshots, attestation, descriptors,
and manifest. The verifier child may emit only `verifier-result`; the report
child may emit only `report-markdown` then `report-envelope`. The supervisor
supplies only the input kinds allowed for that process: authority, lock,
capability, run-command, manifest, verifier-result, and exact
descriptor-declared bytes. Unknown kinds,
out-of-order/replayed frames, size/digest/identity mismatch, trailing stdout,
protocol text, timeout, or premature EOF kills the owned child PGID and writes
nothing for that frame.

### Frozen byte and crash limits

All counters use checked `u64` arithmetic and are charged before allocation.
There is no caller-selected bound and no counter reset within an operation.

| Item | Exact maximum bytes |
| --- | ---: |
| canonical frame header | 65,536 |
| one streamed payload chunk | 1,048,576 |
| approval, RED approval record, host submission, host runtime facts, SSH receipt, staged metadata receipt, descriptor, run command, launch receipt, error | 65,536 each |
| source receipt, RED approval bundle, authority | 262,144 each |
| reservation | 65,536 |
| staged capability | 1,048,576 |
| campaign lock | 16,777,216 |
| manifest | 67,108,864 |
| artifact payload / official artifact | 16,777,216 |
| each role telemetry / each official raw file | 16,777,216 |
| each snapshot | 16,777,216 |
| attestation | 16,777,216 |
| verifier result | 16,777,216 |
| report Markdown | 33,554,432 |
| report envelope | 1,048,576 |
| child stderr for one process | 1,048,576 |

A component is at most 128 UTF-8 bytes; a component array has at most eight
components and at most 512 component bytes in total. A protocol session has at
most 4,096 frames and a sequence in `0...4095`. At most 2 MiB per direction may
be buffered in memory; larger accepted payloads are streamed to one
supervisor-owned uncommitted file while hashing and are never accumulated in
JS memory.

The exact aggregate limits and successful counts are:

| Operation | Frame/count contract | Aggregate byte cap |
| --- | --- | ---: |
| one scenario child | at most 4 input and 2 output frames; no more than one artifact and one role-telemetry output | 67,108,864 per direction |
| complete campaign untrusted child output | exactly 588 artifact payloads, 588 client telemetry payloads, and 588 server telemetry payloads = 1,764 | 34,359,738,368 |
| complete official campaign publication | exactly 3,599 descriptor payload files in the frozen order | 68,719,476,736 |
| verifier input/output | exactly authority + lock + capability + manifest + 3,599 descriptor payloads = 3,603 inputs; exactly 1 output | 68,719,476,736 input; 16,777,216 output |
| report input/output | exactly authority + lock + capability + manifest + verifier result + 490 measured artifacts = 495 inputs; exactly 2 outputs | 8,589,934,592 input; 34,603,008 output |

Bootstrap/control channels separately permit exactly one source receipt, one
RED approval bundle, three final approvals, two host submissions, two host
runtime-facts records, one SSH receipt, one authority, one authority digest,
one lock, one capability, and exactly two staged-metadata receipts. Header/digest reads have a five-second
idle deadline; payload streaming has a 30-second inter-chunk idle deadline;
each role also has its registry-declared overall deadline. Count, byte, or
deadline exhaustion kills/drains the owned PGID and publishes no frame.

Native loops retry `EINTR`, account every short read/write, fail on unexpected
EOF or growth, and map `ENOSPC`/quota/permission errors without partial
success. A completed create performs file `fdatasync`/`fsync`, then parent
directory `fsync`; `sync()` flushes every created descendant parent in deepest
first order. Fault-injection tests cover each write and sync boundary.

The campaign directory and campaign ID are durably single-use. The supervisor
creates `<candidate>/<campaign-id>` with one parent-relative `mkdirat`; any
`EEXIST` is `OUTPUT_CAMPAIGN_EXISTS` and create mode never adopts an existing
directory. Before returning its handle it exclusively writes and syncs
`.campaign-reservation.json` with candidate, campaign ID, new directory
identity, supervisor instance nonce, `state:"RESERVED"`, and creation time,
then syncs both the directory and candidate parent. That reservation is itself
included in authority. No later process can obtain a create-capable handle for
the same ID.

A crash may leave an exclusive final-name file, but without a committed
manifest and verifier result the whole reserved campaign is non-promotable and
may never be resumed or reused. Recovery creates a new campaign ID; it never
replaces or guesses whether a partial file is safe. In-process failure may call
`abort_created_file` with the opaque token. Cleanup failure is a hard blocker.

## Platform implementation

### macOS and Linux

- Adopt the already pinned supervisor descriptor, duplicate it with close-on-
  exec, and require its complete platform identity, owner, mode, directory
  type, and approved local-filesystem class to equal authority before any
  component access. Linux permits only ext4, XFS, or Btrfs; macOS permits only
  local APFS. tmpfs, overlayfs, NFS/SMB, procfs, sysfs, devfs/devtmpfs, FUSE,
  network filesystems, and unknown types are unsupported for official roots.
- Linux requires `openat2` for every component with
  `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS |
  RESOLVE_NO_XDEV`, plus `statx(..., AT_EMPTY_PATH,
  STATX_BASIC_STATS|STATX_MNT_ID)` and `fstatfs` on every returned descriptor.
  Every descriptor must retain the root device, mount ID, filesystem type and
  fsid. `ENOSYS`, missing `STATX_MNT_ID`, or an unsupported resolve flag is
  `OUTPUT_MOUNT_IDENTITY_UNAVAILABLE`; the campaign does not fall back to a
  weaker `openat` walk.
- macOS requires `fstat`, `fstatfs`, `fgetattrlist(ATTR_VOL_UUID)`,
  `fcntl(F_GETPATH)`, and `getfsstat`. The adopted descriptor must map to
  exactly one getfsstat entry with matching APFS fsid/volume UUID; its
  descriptor path must be the canonical mount-relative path, and no separate
  mount-table entry may be nested below it. Every opened component must retain
  the root device, fsid, APFS type, and volume UUID. Multiple matching mount
  entries, a mount alias, nested mount, or unavailable volume identity is
  `OUTPUT_FILESYSTEM_IDENTITY_MISMATCH`.
- Create an intermediate with `mkdirat`, then reopen it with the same no-follow
  directory flags. Capture the created identity with no-follow `fstatat`, then
  require the reopened descriptor to match; treat any replacement,
  cross-device component, non-directory, link, or mount alias as failure.
- For a leaf, use no-follow `fstatat` first to reject a visible link, FIFO,
  socket, or device without opening it. Open reads parent-relative with
  `O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC`, then require descriptor
  `fstat` to be the same regular-file identity observed before open and require
  regular-file link count one. Root and
  descendant ownership/modes prevent concurrent untrusted replacement; both
  checks and adversarial replacement hooks remain mandatory.
- Publish leaves with parent-relative `openat(..., O_WRONLY | O_CREAT |
  O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600)`.
- Use bounded write loops, `fdatasync`/`fsync`, parent-directory `fsync`, and
  parent-relative `unlinkat` only through a matching native creation token.
- Official evidence components are lowercase ASCII only. Reject uppercase,
  non-ASCII/Unicode normalization, percent encoding, trailing dot/space,
  `/dev/fd` aliases, proc magic links, bind/mount aliases, cross-device
  descendants, hard-linked leaves, and any group/world-writable root or
  intermediate. The separately specified `/dev/fd/<role|addon fd>` launch
  handoff is not an official-evidence component and is the sole descriptor
  alias exception.

`secure_fs.rs` routes every OS operation through a sealed internal
`SecureFsSyscalls` trait. Production uses `LibcSyscalls`; tests use
`ScriptedSyscalls` with an exact ordered call queue for `dup`, `fcntl` access
and path queries, `fstat`, `fstatat`, `fstatfs`, Linux `statx`/`openat2`, macOS
`fgetattrlist`/`getfsstat`, `openat`, `mkdirat`, `read`/`pread`/`lseek`,
`write`, `fdatasync`, `fsync`, `fchdir`, `unlinkat`, executable-handle launch,
pinned-directory spawn, `waitpid`, and `close`. Each scripted call can return a
short count, `EINTR`, `ENOSPC`, permission/quota failure, mount/fsid/volume or
identity replacement, launch replacement, or sync failure. Tests assert the
next call sequence, byte counters, cleanup token identity, and final error; an
unexpected, missing, reordered, pathname-based, or extra syscall fails the
test. The trait is not exported from the production crate surface.

A separate sealed `SupervisorObservationSyscalls` seam covers
`if_nametoindex`, `SIOCGIFMTU`, UDP connect/getsockname, AF_PACKET bind/filter/
timestamp/drop counters, NETLINK_SOCK_DIAG, process-group/socket ownership,
qdisc cleanup guards, and PGID kill/wait. A sealed `SupervisorCommandRunner`
accepts only the host-mode-declared pre-opened approved tool descriptors and the exact argv/
environment enumerated above; it records bounded stdout/stderr, exit, timing,
and tool identity. Scripted tests reject an unexpected tool, argv, environment,
PATH/shell lookup, child-supplied observation, missing packet receipt, or
changed command order.

### Windows

R1 official comparison I/O is explicitly unsupported on Windows. Every native
supervisor subcommand enters a `#[cfg(windows)]` compile-time stub before
argument parsing, environment access, descriptor access, module/addon loading,
pathname access, child spawn, or artifact access and returns exactly
`OUTPUT_PLATFORM_UNSUPPORTED`. The comparison supervisor still compiles on
Windows. An import-time/process-start Windows test injects argument,
environment, path, descriptor, loader, and spawn spies and proves zero I/O
before the error. No TypeScript comparison module or package addon is imported
on that path. There is no `NtCreateFile`, Win32, NAPI, or `node:fs` fallback in
R1.

Adding Windows official-I/O support later requires a fresh amendment that
freezes exact `NtCreateFile` access/share/disposition/options flags,
`RootDirectory` inheritance, `FILE_OPEN_REPARSE_POINT` handling, volume/file-ID
tuples, ADS/device rejection, create-new durability, and reparse/rename/delete
race tests.

## Typed failures

Preserve existing path failures and add stable codes as needed:

- `OUTPUT_HANDLE_CLOSED`
- `OUTPUT_PATH_REPARSE`
- `OUTPUT_PATH_DEVICE`
- `OUTPUT_FILE_INVALID`
- `OUTPUT_FILE_EXISTS`
- `OUTPUT_CAMPAIGN_EXISTS`
- `OUTPUT_FILE_TOO_LARGE`
- `OUTPUT_READ_FAILED`
- `OUTPUT_WRITE_FAILED`
- `OUTPUT_SYNC_FAILED`
- `OUTPUT_CLEANUP_FAILED`
- `OUTPUT_EXEC_HANDLE_UNAVAILABLE`
- `OUTPUT_EXEC_HANDLE_INVALID`
- `OUTPUT_EXEC_DIGEST_MISMATCH`
- `OUTPUT_EXEC_REPLACED`
- `OUTPUT_EXEC_FAILED`
- `OUTPUT_MOUNT_IDENTITY_UNAVAILABLE`
- `OUTPUT_MOUNT_IDENTITY_MISMATCH`
- `OUTPUT_FILESYSTEM_IDENTITY_MISMATCH`
- `OUTPUT_PATH_ALIAS`
- `OUTPUT_PATH_HARDLINK`
- `OUTPUT_PATH_CROSS_DEVICE`
- `OUTPUT_SYSCALL_SCRIPT_MISMATCH`
- `OUTPUT_PLATFORM_UNSUPPORTED`
- `OUTPUT_INTERNAL`
- `TRUST_SOURCE_RECEIPT_REQUIRED`
- `TRUST_SOURCE_RECEIPT_INVALID`
- `TRUST_SOURCE_ARCHIVE_HEAD_MISMATCH`
- `TRUST_SOURCE_ARCHIVE_DIGEST_MISMATCH`
- `TRUST_LAUNCH_PROVENANCE_MISMATCH`
- `TRUST_REVIEWED_HEAD_MISMATCH`
- `TRUST_R1_RED_APPROVAL_REQUIRED`
- `TRUST_R1_RED_APPROVAL_MISMATCH`
- `TRUST_SUPERVISOR_OBSERVATION_REQUIRED`
- `TRUST_OBSERVATION_COMMAND_MISMATCH`
- `TRUST_SSH_HOST_MISMATCH`
- `TRUST_ROUTE_OBSERVATION_MISSING`
- `TRUST_ROUTE_MISMATCH`
- `TRUST_SOURCE_ADDRESS_MISMATCH`
- `TRUST_MTU_MISMATCH`
- `TRUST_QDISC_OBSERVATION_MISSING`
- `TRUST_QDISC_MISMATCH`
- `TRUST_SERVER_PEER_MISSING`
- `TRUST_SERVER_PEER_MISMATCH`
- `TRUST_CHILD_OBSERVATION_FORBIDDEN`
- `TRUST_AUTHORITY_REQUIRED`
- `TRUST_AUTHORITY_SELF_AUTH_FORBIDDEN`
- `TRUST_CAPABILITY_LOCATOR_UNSAFE`
- `TRUST_CAPABILITY_READ_FAILED`
- `TRUST_CAPABILITY_DIGEST_MISMATCH`
- `TRUST_CAPABILITY_ROOT_IDENTITY_MISMATCH`
- `TRUST_CAPABILITY_EXPIRED`
- `TRUST_CAPABILITY_FIXTURE_ONLY_FORBIDDEN`

Unknown native errors are wrapped with a stable comparison error code while
preserving a non-secret cause for diagnostics.

The supervisor sends a structured protocol error
`{ schema:"comparison-supervisor-error/v1", code, operation, osCode? }` to its
trusted parent and kills/drains the child. TypeScript converts only known codes
to `ComparisonTrustError`; unknown/malformed frames become `OUTPUT_INTERNAL`
and are non-promotable. The top-level CLI emits one canonical JSON diagnostic
to stderr, emits no success stdout, writes no official output, and exits
according to this frozen map:

| Failure class | Codes | Exit |
| --- | --- | ---: |
| invocation/authority absent or self-auth | `TRUST_AUTHORITY_*`, unsafe locator/argument | 64 |
| malformed/mismatch/expired evidence | capability, digest, identity, manifest, lock validation | 65 |
| output already exists | `OUTPUT_FILE_EXISTS`, `OUTPUT_CAMPAIGN_EXISTS` | 73 |
| native read/write/sync/cleanup/type/race/launch failure | `OUTPUT_*` except platform/unavailable/exists | 74 |
| boundary/platform/required-handle-or-mount primitive unavailable | `OUTPUT_TRUST_BOUNDARY_UNAVAILABLE`, `OUTPUT_PLATFORM_UNSUPPORTED`, `OUTPUT_EXEC_HANDLE_UNAVAILABLE`, `OUTPUT_MOUNT_IDENTITY_UNAVAILABLE` | 69 |
| unknown native payload/internal invariant | `OUTPUT_INTERNAL` | 70 |

Tests assert the Rust error, supervisor frame, JS error object, CLI JSON/exit,
empty stdout, killed/drained PGID, and absence of new files for every row.
Platform-unavailable mapping is never ambiguous.

## Files and ownership

Native boundary owner:

- create `crates/native/src/secure_fs.rs`
- create `crates/native/src/bin/comparison-supervisor.rs`
- modify `crates/native/src/lib.rs`
- modify `crates/native/Cargo.toml` to add the binary target, enable the library
  `rlib` needed by that binary, and move the already-present `libc = "0.2"`
  dependency from Linux-only to `cfg(unix)` for macOS/Linux; no new package is
  introduced
- create `crates/native/tests/secure_fs.rs`

`secure_fs` is Rust-public only so the package binary can link it; it has no
`#[napi]` symbols and is absent from the JavaScript addon export surface.

Trust-model owner:

- create `tools/compare/secure-fs.ts`
- create `tools/compare/staged-capability.ts`
- create `tools/compare/campaign-lock.ts`
- create `tools/compare/manifest-lock.ts`
- create `tools/compare/supervisor-protocol.ts`
- create `tools/compare/supervisor-client.ts`
- modify `tools/compare/output-policy.ts`
- create `tools/compare/r1-fixtures.ts`
- create `tools/compare/r1-authority-red.test.ts`
- create `tools/compare/r1-secure-fs-red.test.ts`
- create `tools/compare/r1-manifest-red.test.ts`

Entrypoint owner, after the boundary and validators are green:

- modify `tools/compare/run-campaign.ts`
- modify `tools/compare/verify-artifact.ts`
- modify `tools/compare/render-report.ts`
- modify `tools/compare/artifact-builder.ts`
- delete `tools/compare/remote.ts`; the Rust supervisor replaces its Bun/shell/
  accept-new SSH execution surface
- keep `tools/compare/remote-supervisor.ts` only as pure legacy-state parsing,
  unreachable from every official root
- modify `tools/compare/adapters/wt.ts` to replace its runtime dynamic package
  import with the one approved static role-child edge
- modify `packages/webtransport/src/index.ts` and its focused loader tests so a
  supervisor-set comparison addon FD causes exactly one `/dev/fd/<n>` load
  attempt and disables all fallback candidate searches
- modify `package.json` so `compare:run`, `compare:verify`, and
  `compare:report` remain explicitly fixture-only and reject official
  capabilities; remove any `compare:campaign` spelling
- create `tools/compare/r1-entrypoint-red.test.ts`
- create `tools/compare/r1-physical-path-red.test.ts`
- create `tools/compare/check-official-io.ts`
- create `tools/compare/official-io-allowlist.json`

The four and only four official Bun child roots are concrete file entrypoints:

| Logical child | Exact source root | Required conversion |
| --- | --- | --- |
| `campaign-child` | `tools/compare/run-campaign.ts` | framed campaign transform only |
| `artifact-child` | `tools/compare/artifact-builder.ts` | convert the current library module into the framed artifact CLI root while retaining pure helpers behind that root |
| `verifier-child` | `tools/compare/verify-artifact.ts` | framed verifier transform only |
| `report-child` | `tools/compare/render-report.ts` | framed report transform only |

The role-entrypoint manifest maps exactly those four logical names to their
four independently Bun-bundled, import-closed ESM files and byte digests. The
supervisor never launches the TypeScript source path itself. The allowlist
checker roots its transitive analysis at exactly those four source files, and
runtime spies launch each corresponding bundle through its role descriptor.
`artifact-builder.ts` is therefore no longer merely an in-process library on
the official path; direct imports may reach only separately exported pure
helpers and can never invoke its CLI protocol. No fifth official child,
implicit `import.meta.main`, generated wrapper, or package-script root exists.

Documentation/CI owner, after behavior is verified:

- update `docs/TRANSPORT_COMPARISON.md`
- update `docs/TESTPLAN.md`
- add an ADR under `docs/adr/` for the filesystem/authority contract
- update existing native platform CI only as needed to exercise the new tests

Agents have exclusive ownership of their listed files during a task, are not
alone in the worktree, must not revert others' edits, and must report any
required scope crossing before editing.

`tools/compare/supervisor-client.ts` contains only the bounded frame codec and
typed child-side request/response API. `tools/compare/secure-fs.ts` contains
schema/limit validation for tests but no OS I/O and no package-addon import.
Official TypeScript entrypoints receive validated input frames and emit output
frames; they never receive root path strings or OS handles. The supervisor is
the sole official filesystem implementation.

The manifest bootstrap is fixed and non-enumerating: authority bytes come only
from supervisor-owned bootstrap pipes/control frames; the campaign handle first reads exactly
`.campaign-reservation.json`; the adopted staging handle reads exactly
`campaign-lock.json` and `staged-capability.json`; after a campaign the adopted
campaign handle reads exactly `manifest.json`. Only successfully validated
manifest component arrays may select artifacts, raw files, snapshots,
and the attestation. `verifier-result.json`, `report.md`, and `report.json` use
the fixed post-manifest order above and are not manifest-selected.
`readOfficialComparisonFile`,
`writeOfficialComparisonFile`, `readdirSync`, `glob`, `Bun.file`, and pathname
open/write calls remain unavailable to these official entrypoints.

`official-io-allowlist.json` has schema
`comparison-official-io-allowlist/v1`, no optional fields, and exactly these
top-level keys: `officialRoots`, `roleChildTs`, `protocolOnlyTs`,
`controllerOnlyTs`, `fixtureTs`, `checkerTs`, `nativeSources`,
`resolvedStaticImports`, `packageLoaderExceptions`, `forbiddenImports`, and
`forbiddenCalls`. Every non-test TypeScript file under `tools/compare` appears
in exactly one TypeScript class; every test is excluded by exact `.test.ts`
suffix and may import only `fixtureTs` plus production APIs. The frozen special
classes are:

```text
officialRoots:
  artifact-builder.ts render-report.ts run-campaign.ts verify-artifact.ts

fixtureTs:
  r1-fixtures.ts

checkerTs:
  check-official-io.ts

controllerOnlyTs:
  host-sidecar.ts netem.ts remote-supervisor.ts topology.ts

nativeSources:
  crates/native/src/secure_fs.rs
  crates/native/src/bin/comparison-supervisor.rs
```

The remaining final non-test files—including `secure-fs.ts`,
`staged-capability.ts`, `campaign-lock.ts`, `manifest-lock.ts`,
`supervisor-client.ts`, and `supervisor-protocol.ts`—must be exhaustively
listed under `roleChildTs` or `protocolOnlyTs` in the tracked JSON. The final
set deliberately contains `r1-fixtures.ts` and `check-official-io.ts` and does
not contain deleted `remote.ts`. A missing, extra, duplicate-classified, or
unresolved file fails. `check-official-io.ts` is an audit-only program: it may
read repository source and the allowlist through `node:fs`/`node:path`, but may
not write, spawn, access network, be imported by production, or exempt any
other file. `r1-fixtures.ts` cannot be reached from production.

Using the installed TypeScript AST, the checker resolves static imports and
re-exports, package exports, aliases, destructured bindings, computed
properties, and type-only edges. It rejects dynamic `import()`, `require`,
`module.require`, `createRequire`, `eval`, `Function`, `process.binding`,
`process.dlopen`, `Bun.dlopen`, `Bun.file`, `Bun.write`, `Bun.spawn`,
`Bun.spawnSync`, `Deno.Command`, Deno filesystem calls, `fetch(file:...)`,
directory enumeration/globbing, legacy official path helpers, arbitrary addon
or `.node` loading, `measureCellArm`, and imports of `node:fs`,
`node:fs/promises`, `node:path`, `node:child_process`, `node:module`,
`node:vm`, or FFI surfaces in the transitive graph rooted at all four official
roots. Equivalent alias/computed/re-export spellings are rejected, not merely
literal tokens. Ambient cwd, environment path, and user locator authority are
also forbidden.

There is one reviewed loader exception, represented structurally in
`packageLoaderExceptions`: the statically imported WT package may use
`createRequire` only in `packages/webtransport/src/index.ts`, only while the
supervisor's strict comparison mode is active, and only for the literal
descriptor request `/dev/fd/<validated-addon-fd>`. Runtime spies require one
attempt, the pre-opened addon identity/digest, and zero fallback candidates.
Every other `node:module`, native-loader, dynamic-import, environment-path, or
fallback edge remains forbidden. The supervisor launches roles with an empty
environment except its fixed comparison addon FD, locale, and protocol FDs;
children cannot supply or modify authority-bearing environment values.

The checker also scans Rust: direct `std::fs`, `std::path` open/traversal, and
arbitrary `Command`/shell use is forbidden outside the sealed syscall and
fixed command-runner implementations. Adversarial fixtures cover import
aliases, computed properties, re-exports, dynamic imports, subprocesses,
package export indirection, addon loaders, and native path opens. `bun
tools/compare/check-official-io.ts` prints canonical classified-file and
resolved-graph SHA-256 values; the final source receipt and all three approvals
bind the tracked JSON and checker bytes through the reviewed source/diff, so no
self-referential diff hash is stored inside the allowlist.

## Execution sequence

The architect and critic are boundary reviewers only. This amendment receives
one architect verdict and one critic verdict before any R1 development begins;
revisions required to turn a rejected draft into that approved artifact remain
part of the same pre-development gate. After approval, Tasks A through E and
the parent R2 through R8 execution proceed without intermediate architect or
critic calls. Ordinary TDD runs, implementer self-checks, focused spec tests,
and verification are execution evidence rather than architecture gates. The
architect is called once more and the critic once more only after Tasks A-E,
the parent implementation work, and both-host source-bound staging are complete
but before any official campaign traffic. Their post-development verdicts
cover the complete implementation and exact staged inputs and are the campaign
staging approvals consumed by authority. No architect or critic is called
again during diagnostics, the 82-arm campaign, verification, or reporting.

### Task A — Complete and approve the R1 RED contract

1. Move stable literal fixtures into `r1-fixtures.ts` and split the existing
   large RED suite into the five named RED test files above. Each file has one
   exclusive owner; the original file is deleted only after every assertion is
   accounted for. The focused command is
   `bun test tools/compare/r1-*-red.test.ts` and is socket-free.
2. Freeze the 35-cell/82-arm semantic registry and exact 588-entry schedule
   using literal expectations independent of production helpers.
3. In `r1-secure-fs-red.test.ts` and
   `crates/native/tests/secure_fs.rs`, add RED tests for required inherited
   identities; component rejection; symlink, magic-link, cross-device, FIFO,
   socket, device and alias rejection; group/world-writable roots; closed
   handles; bounded reads and hashes; exclusive create; short I/O, `EINTR`,
   `ENOSPC`, file/parent sync failures; opaque-token cleanup; intermediate and
   leaf ancestor-swap races; and single-use crash recovery.
4. In `r1-authority-red.test.ts`, freeze the exact authority schema,
   supervisor CLI/pipe access modes, descriptor-only approval/host provenance,
   authority digest output source, POSIX identity tuples, separate Mac/Linux
   staged-archive hashes, acyclic digest graph, final
   plan/amendment/HEAD/approval invalidation, durable exclusive reservation,
   single-use campaign ID, and import/process-start no-I/O Windows result. Add
   capability content mutations for both host
   submissions, staging IDs and
   OS identities, lock/archive/staged-archive digests, issue/expiry,
   `fixtureOnly`, unknown/duplicate fields, and self/ambient authorization.
5. In `r1-entrypoint-red.test.ts`, exercise the real load -> lock/manifest
   verify -> promotion/report path,
   including typed CLI propagation, rather than only parser helpers.
6. In `r1-manifest-red.test.ts`, bind exact manifest cardinality, entry
   identity, raw kinds, snapshot kinds,
   path components, descriptor digests, observed facts, PGID/snapshot
   relationships, overlays, warmups, and every incompatibility axis.
7. Prove all positive fixture bytes satisfy their own SHA-256, schema, and
   descriptor contracts; extreme overlay metrics must not alter primary
   deltas.
8. Freeze canonical bytes and every field/order for source receipt, RED
   approval bundle, staged receipt, launch provenance, authority, host
   submission, SSH receipt, reservation, lock, capability, supervisor
   observations, attestation, descriptor, manifest, verifier, report,
   supervisor input/output, and supervisor error records. The R1-only fixture
   helper must encode ```${canonicalJson(value)}\n```; changing global
   canonical JSON behavior is forbidden. Test the
   exact seven-step bootstrap/publication order and reject a manifest that
   names itself, verifier output, or report output.
9. In `r1-entrypoint-red.test.ts`, add the tracked allowlist checker and
   runtime I/O spies proving all four official entrypoints cannot call
   `node:fs`, `Bun.file`, pathname helpers, enumeration, the legacy official-I/O
   functions, or a synthetic/default `measureCellArm`. Test executors require
   `fixtureOnly: true` and cannot receive an official handle or promote output.
10. In `r1-physical-path-red.test.ts`, require independently supervisor-observed
   Mac route, Linux route, packet/server peer, interface, source, MTU, SSH host,
   qdisc, command-tool, and cleanup facts.
   Reject copied planned facts, localhost/loopback, same-host roles, Tailscale
   measurement addresses/interfaces, missing Linux observations, and any
   scenario that did not use the Linux server.
11. Run the focused RED command, Rust scripted-syscall tests, and the allowlist
   checker; independently verify failures correspond to
   missing production APIs—not broken fixtures or accidental network access.
12. Hash the sorted path+byte-digest set for exactly `r1-fixtures.ts`, the five
   `r1-*-red.test.ts` files, and `crates/native/tests/secure_fs.rs`; separately
   hash the exact commands and bounded failure inventory. Obtain unconditional
   `r1-red-approval/v1` records from an independent spec reviewer and verifier,
   store only their canonical external bytes/digests in the RED approval
   bundle, and bind that bundle in every later final campaign approval. Any RED
   edit or changed failure inventory requires another focused run and fresh
   records before Task B.

### Task B — Implement the native boundary

1. Treat the Task-A-approved `crates/native/tests/secure_fs.rs` and five RED
   TypeScript suites as immutable inputs. Implement production code against
   those exact tests; Task B does not add, delete, rename, or edit any file in
   the RED approval bundle. Additional non-contract regression coverage, if
   genuinely needed, goes in separately named GREEN test files outside that
   bundle. Any change to an approved RED file or its failure inventory stops
   implementation immediately and requires a new focused RED run plus fresh
   spec-reviewer/verifier RED approval records before production edits resume.
2. Implement the POSIX handle-relative core, sealed `SecureFsSyscalls` seam,
   exclusive campaign reservation, bounded supervisor frame codec, and
   `comparison-supervisor` binary. Do not add a NAPI filesystem surface.
3. Implement the Windows supervisor compile-time stub and prove it returns exactly
   `OUTPUT_PLATFORM_UNSUPPORTED` before all I/O.
4. Build the supervisor and native addon; run Rust tests, clippy, TypeScript
   frame definitions, subprocess protocol tests, and focused boundary tests.
5. Independent spec review, then independent quality/security review.

### Task C — Implement trust and manifest validation

1. Parse strict canonical authority, capability, lock, attestation, and
   manifest records: reject missing, unknown, duplicate, malformed, or
   contradictory fields.
2. The Rust supervisor reads authority only from its anonymous-pipe descriptor,
   owns staging/campaign descriptors, compares every required OS identity, and
   sends validated canonical input frames to children.
3. The supervisor reads capability and lock bytes through pinned handles,
   enforces byte bounds,
   hash exact bytes, validate all bindings and times, then read only exact
   manifest-declared component lists.
4. Maintain distinct planned and observed structures and fail on omission,
   echo-only observation, drift, or cleanup/restoration failure.
5. Run focused tests, typecheck, native verification, then independent spec and
   quality/security reviews.

### Task D — Integrate official entrypoints

1. Preserve `compare:run` as the single canonical package command name and
   remove every `compare:campaign` spelling; update package metadata, docs, and
   tests together. `compare:run`, `compare:verify`, and `compare:report` are
   explicitly non-authoritative developer/fixture conveniences: they require
   `fixtureOnly:true`, cannot accept an official capability, and can never
   create or promote official output. The authoritative path is operator-only:
   the trusted operator launches the already approved
   `comparison-supervisor resident-mac`, `verify-existing`, or
   `report-existing` binary mode directly with the exact pre-opened descriptor
   argv frozen above. A package script, Bun process, shell, PATH lookup,
   candidate child, or path argument cannot bootstrap official descriptor
   authority. The supervisor launches the four exact Bun child roots below
   with validated input frames; children receive no filesystem
   descriptors/paths. Remove unbound defaults and trust-marker environment
   paths.

   The final package script values are exact:
   `"compare:run":"bun tools/compare/run-campaign.ts --fixture-only"`,
   `"compare:verify":"bun tools/compare/verify-artifact.ts --fixture-only"`,
   and
   `"compare:report":"bun tools/compare/render-report.ts --fixture-only"`.
   Their parsers reject an official authority/capability, root/path locator, or
   missing fixture marker before filesystem or network I/O. Documentation and
   tests label them fixture-only. Official operator instructions show the
   native binary plus descriptor argv and never present a package script as an
   official launch command.
2. Remove directory discovery and path-based official I/O. The validated
   manifest is the complete read set; supervisor-owned Rust handles are the
   only official write path.
3. Write artifacts, raw descriptors, snapshots, manifest, verifier result, and
   report using exclusive creates. Sync before success; clean owned partials
   relative to pinned parents on failure.
4. Propagate `PASS|FAIL|BLOCKED`, `PASS|MISS|NO_VERDICT`, and promotability
   without contradiction. A valid MISS may retain numbers; blocked, failed,
   incompatible, warmup, and overlay records cannot enter primary deltas.
5. Run real supervisor->child CLI integration against temporary directories
   and inherited pipes with no sockets. Prove the native operator-only
   descriptor path and separately prove each package script remains fixture-only,
   frame timeouts/replays/trailing bytes/child crash, PGID cleanup, and every
   exit mapping—not only exported parsers.
6. Run the static and runtime no-bypass gates and the synthetic/default
   executor rejection gate.
7. Independent spec review, then independent code-quality/security review.

### Task E — Documentation and verification gate

1. Document the external authority ceremony, platform support, recovery, and
   typed blockers without implying any measurements exist.
2. Run all comparison tests, native tests, typecheck, clippy/static checks, and
   relevant package regression tests.
3. Run adversarial no-follow/race tests on macOS and Linux; require the Windows
   platform lane to prove the early zero-I/O unsupported stub and do not claim
   Windows official-comparison-I/O support.
4. Confirm the worktree contains no tracked generated evidence and no numeric
   comparison report.
5. Independent exact-HEAD spec review, quality/security review, and completion
   verification. These close R1 implementation only; they are not
   `exact-approval/v1` campaign-staging records and cannot mint authority. Only
   then may the parent recovery plan proceed to real roles and staging. After
   R5 produces the deterministic source receipt and both host submissions,
   obtain a fresh architect/critic/verifier `phase:"campaign-staging"` triad
   bound to those exact bytes before R6 diagnostics or any scenario socket.
   Any source, staged byte, host identity, or tool change restarts staging and
   that triad.

## Scoped commit sequence

Use one logical Lore commit per behavior. Suggested intents:

1. `Freeze secure comparison boundaries so RED proves official I/O safety`
2. `Pin official directories so ancestor swaps cannot redirect evidence`
3. `Bind campaign authority so artifacts cannot authorize themselves`
4. `Verify declared evidence so directory discovery cannot widen trust`
5. `Publish comparison output exclusively so reruns cannot replace evidence`
6. `Document evidence authority so operators fail closed across platforms`

Each commit records constraints, rejected fallbacks, confidence, scope risk,
tests, and known platform gaps. Do not bundle planning files into behavior
commits. A post-review fix receives its own scoped commit and fresh relevant
review.

## Verification commands and evidence

Exact commands may adapt to repository scripts, but the final evidence must
include:

- focused R1 RED/GREEN Bun tests with counts and failure inventory
- `bun test tools/compare/r1-authority-red.test.ts`
- `bun test tools/compare/r1-secure-fs-red.test.ts`
- `bun test tools/compare/r1-manifest-red.test.ts`
- `bun test tools/compare/r1-entrypoint-red.test.ts`
- `bun test tools/compare/r1-physical-path-red.test.ts`
- the complete `bun test tools/compare/` suite
- `bunx tsc --noEmit`
- `cargo test -p native --test secure_fs`
- `cargo test -p native --lib secure_fs`
- `cargo build -p native --bin comparison-supervisor`
- `cargo clippy -p native --lib --bin comparison-supervisor -- -D warnings`
- native addon build/load smoke remains a regression check; it is not the
  official-I/O loader
- `bun tools/compare/check-official-io.ts`
- temporary-directory CLI integration for campaign/verify/report main paths
- descriptor-provenance, final-HEAD/digest invalidation, no-bypass,
  partial-write/durability, Windows-zero-I/O, and direct-cable negative gates
- Windows CI build plus process-start test for the supervisor stub, with spies
  proving no argument/environment/path/descriptor/addon/child access
- git status, exact HEAD, changed-file inventory, and absence of tracked
  generated evidence
- exact spec-review, quality/security-review, and verifier verdicts

No command in Tasks A–E opens a scenario socket. Tests that need filesystem
races use local temporary directories only.

## Rollback and fail-closed behavior

- Before integration, failure leaves R0's
  `OUTPUT_TRUST_BOUNDARY_UNAVAILABLE` behavior intact.
- After integration, any unsupported platform, boundary error, identity drift,
  malformed authority/capability/lock/manifest, hash mismatch, expired
  capability, partial-write cleanup failure, or sync failure produces typed
  non-promotable output or no output.
- Rollback is by reverting the scoped behavior commits in reverse order; never
  restore a path-based official I/O fallback.
- Existing fake or quarantined evidence remains inadmissible and must not be
  reintroduced.

## Network and campaign invariant preserved

This amendment does not relax the parent plan. All later integration,
diagnostic, and measured scenario traffic—WS, WT, warmups, measured runs, and
overlays—must use Mac `10.99.0.1/en8` to Linux `10.99.0.2/eno1` over the direct
physical cable. SSH control may use Tailscale; scenario bytes may not. There is
no loopback or same-host fallback. The Linux machine must be used for every
network scenario.

## Remaining gated decisions

There are no implementation-shaping decisions deferred to GREEN. The authority
schema/transfer, acyclic digest graph, POSIX identity, byte limits, crash model,
native/JS/CLI errors, bootstrap read set, and Windows unsupported behavior are
frozen above.

Any need for atomic replacement, directory enumeration, generic deletion,
pathname roots, cryptographic signing, Windows official-I/O support, a helper
executable, or a different authority-transfer mechanism is new scope and
requires another exact-artifact architect and critic review.

### Deferred RED contract coverage — R8-i, deferred to round 9

*The paragraph above concerns decisions deferred to GREEN. One item of **RED contract coverage** is
separately deferred, to round 9, and is recorded here in full.*

`tools/compare/secure-fs.ts:339-441` holds `SECURE_FS_INJECTED_FAILURES` / `SECURE_FS_RACE_CODES` as
hardcoded name→code tables mirroring the Rust oracle, and `comparisonSupervisorWindowsStub` ignores
its input. Two red flips are therefore **shape-only by construction**: they prove the table matches
itself and evidence **nothing** about engine behaviour.

Making them real needs a napi or CLI bridge from TS to the Rust secure-fs engine; adversarial on-disk
fixtures (real symlink races, real mount-point swaps, real EINTR storms) that cannot be produced
synchronously; and an injectable failure seam in the engine. All three break the frozen tests'
**synchronous pure-function calling convention** — `runSecureFsSyscallScript(input)` returns a value;
a bridged version returns a Promise and needs process lifecycle, temp directories and platform
gating. That is a different test architecture, not an edit.

Round 8 already carries a four-arm restructure touching every cardinality field and all 4,679
descriptors, a load-bearing streaming rewrite, a required-lock-field change, and — after v3's
completeness amendments — **seventeen schema rows across nine interfaces plus eight rejection codes**.
Folding in an async architecture plus a napi bridge would multiply the digest-convergence surface,
turn the dual-platform compile gate into a *runtime* gate on two platforms, and put the round-8
approval bundle at serious risk of a round-9 reopen for reasons unrelated to the maintainer's
decisions.

**Deferral is recorded here and must be restated verbatim in the amendment and in the spec-reviewer
approval record.** An unrecorded deferral is how the round-4/5 escapes happened. Add a `TODO(R9)`
marker beside **both** tables naming this deferral record.
