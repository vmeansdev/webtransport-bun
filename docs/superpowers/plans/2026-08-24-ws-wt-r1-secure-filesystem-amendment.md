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
record after the final exact-HEAD reviews and before staging. The record has
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
    finalArchitectApprovalSha256: string;
    finalCriticApprovalSha256: string;
    finalVerifierApprovalSha256: string;
  };
  source: {
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
  };
  topology: {
    kind: "direct-cable";
    mac: { hostId: string; interface: "en8"; address: "10.99.0.1" };
    linux: { hostId: string; interface: "eno1"; address: "10.99.0.2" };
    tailscaleMeasurementForbidden: true;
    loopbackForbidden: true;
  };
  roots: readonly [
    { hostId: string; kind: "mac-campaign"; identity: PosixDirectoryIdentity },
    { hostId: string; kind: "mac-staging"; identity: PosixDirectoryIdentity },
    { hostId: string; kind: "linux-staging"; identity: PosixDirectoryIdentity },
  ];
}

interface PosixDirectoryIdentity {
  platform: "posix";
  device: string; // unsigned decimal st_dev, no numeric truncation
  inode: string; // unsigned decimal st_ino, no numeric truncation
  ownerUid: number;
  mode: number;
}

type OfficialDirectoryIdentity = PosixDirectoryIdentity;
declare const createdFileTokenBrand: unique symbol;
type CreatedFileToken = { readonly [createdFileTokenBrand]: true };

interface ExactApprovalRecordV1 {
  schema: "exact-approval/v1";
  role: "architect" | "critic" | "verifier";
  verdict: "APPROVED";
  worktree: string;
  finalCandidateHead: string;
  parentPlanSha256: string;
  parentDesignSha256: string;
  amendmentSha256: string;
  reviewedDiffSha256: string;
  issuedAt: string;
}

interface CampaignReservationV1 {
  schema: "campaign-reservation/v1";
  candidate: string;
  campaignId: string;
  campaignIdentity: PosixDirectoryIdentity;
  supervisorInstanceNonce: string;
  state: "RESERVED";
  createdAt: string;
}
```

All three roots are created or opened and pinned by trusted Mac/Linux
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
constructor and official-root opener. The operator launches its Mac
`prepare-controller` mode from the exact binary whose SHA-256 is in the final
approval records. It receives no authority values from environment variables
or candidate files. Its complete bootstrap inputs are:

```text
--candidate <40-hex>
--campaign-id <strict component>
--architect-approval-fd <read-only pipe fd>
--critic-approval-fd <read-only pipe fd>
--verifier-approval-fd <read-only pipe fd>
--mac-staging-parent-fd <read-only directory fd>
--mac-campaign-parent-fd <read-only directory fd>
--linux-submission-fd <read-only pipe fd>
--authority-out-fd <write-only pipe fd>
--authority-digest-out-fd <write-only pipe fd>
```

The Linux `prepare-host` mode receives its staging-parent descriptor and writes
one canonical host submission to a pipe returned over SSH. Both modes reject
unknown arguments and inherited ambient trust variables. `fcntl(F_GETFL)` must
show approval/submission inputs as read-only and outputs as write-only;
`fstat` must show anonymous FIFO/pipe descriptors. Directory descriptors must
be read-only real directories owned by the supervisor UID and not group/world
writable. All descriptors are duplicated close-on-exec, byte-bounded, consumed
to EOF exactly once, and closed deterministically. Descriptor reuse, trailing
bytes, premature EOF, extra writers, and access-mode mismatch are typed
failures.

The Mac supervisor exclusively creates the single-use campaign directory under
the pinned parent, obtains the three root identities, consumes the approval and
Linux-submission pipes, hashes exact staged archives/Bun/supervisors/role
entrypoints/addons on both hosts, constructs canonical authority bytes, and
writes bytes and digest to two separate operator-owned pipes. The authority
digest source is therefore the reviewed supervisor operating on independent
approval/host inputs, never a candidate CLI string. The operator records that
digest and supplies the exact authority bytes+digest to the Linux supervisor in
one bounded supervisor-protocol control frame over SSH. The Linux supervisor
validates both before launching a role. TypeScript children receive validated
authority content only as supervisor input frames, not as filesystem or
authority descriptors.

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

The only official campaign output root is the pinned Mac campaign directory.
The Linux supervisor adopts a read-only staging descriptor and emits bounded,
length-prefixed observed records/sidecars over the SSH control stream; the Mac
controller validates their declared lengths/digests and creates the official
copies through its campaign handle. Linux scenario roles never write an
official evidence pathname. Scenario network bytes still use only the physical
cable; SSH carries control/evidence bytes, not workload traffic.

Each supervisor verifies the source archive, its own independently hashed
staged archive, Bun runtime, supervisor, role entrypoint, and native addon
hashes against authority and capability before launch, changes directory with
`fchdir` on the pinned non-writable staging descriptor, and launches only the
verified relative role entrypoint with official descriptors closed. The child
reports its runtime/addon identity through a frame; the supervisor binds that
observation to its independently hashed files. A path or cwd supplied by the
child, or a mismatch between supervisor and child observations, is
non-promotable.

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

interface HostSubmissionV1 {
  schema: "host-submission/v1";
  hostId: string;
  platform: "darwin-arm64" | "linux-x86_64";
  stagingIdentity: PosixDirectoryIdentity;
  stagedArchiveSha256: Sha256;
  bunSha256: Sha256;
  supervisorSha256: Sha256;
  roleEntrypointsSha256: Sha256;
  addonSha256: Sha256;
  observedAt: string;
}

interface CampaignLockV1 {
  schema: "campaign-lock/v1";
  authoritySha256: Sha256;
  candidate: string;
  campaignId: string;
  sourceArchiveSha256: Sha256;
  registryHash: Sha256;
  scheduleHash: Sha256;
  capacityProfileHash: Sha256;
  tlsPlanHash: Sha256;
  topologyPlanHash: Sha256;
  executionPlanHash: Sha256;
  scheduleCount: 588;
  artifactCount: 588;
  rawDescriptorCount: 2940;
  snapshotDescriptorCount: 70;
  createdAt: string;
}

interface StagedCapabilityV1 {
  schema: "staged-capability/v1";
  authoritySha256: Sha256;
  lockSha256: Sha256;
  candidate: string;
  campaignId: string;
  sourceArchiveSha256: Sha256;
  macStagedArchiveSha256: Sha256;
  linuxStagedArchiveSha256: Sha256;
  hostSubmissions: readonly [HostSubmissionV1, HostSubmissionV1];
  macCampaignIdentity: PosixDirectoryIdentity;
  issuedAt: string;
  notAfter: string;
  fixtureOnly: false;
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
  macRouteFactsSha256: Sha256;
  linuxRouteFactsSha256: Sha256;
  serverPeerFactsSha256: Sha256;
  qdiscFactsSha256: Sha256;
  tlsFactsSha256: Sha256;
  roleFactsSha256: Sha256;
  wtFactsSha256: Sha256;
  telemetryFactsSha256: Sha256;
  cleanupFactsSha256: Sha256;
  runFactsSha256: Sha256;
  observedAt: string;
}

interface CampaignManifestV1 {
  schema: "campaign-manifest/v1";
  authoritySha256: Sha256;
  lockSha256: Sha256;
  capabilitySha256: Sha256;
  candidate: string;
  campaignId: string;
  registryHash: Sha256;
  scheduleHash: Sha256;
  scheduleCount: 588;
  descriptors: readonly EvidenceDescriptorV1[];
  descriptorCount: 3599; // 588 artifacts + 2940 raw + 70 snapshots + attestation
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
corresponding authority fields. Arrays elsewhere are ordered by execution
index and then the frozen descriptor-kind order; set-like reordering is not
accepted.

Exact bootstrap and publication order:

1. Consume and validate authority bytes/digest from supervisor-owned pipes.
2. Through the pinned campaign handle, read exactly
   `.campaign-reservation.json` and require its digest/identity to equal
   authority. Through the pinned staging handle, read exactly
   `campaign-lock.json`, hash
   and validate it against authority; then read exactly
   `staged-capability.json`, hash and validate it against authority+lock.
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
   `verifier-result.json`, then the already validated primary artifact set. It
   writes `report.md`, followed by `report.json` containing the Markdown digest;
   neither report file is a manifest descriptor.
7. Only an externally consumed `report.json` whose entire parent chain and
   `PASS/PASS/promotable:true` verifier tuple validate may be advertised as an
   official comparison. `PASS/MISS` numbers remain visible but nonpromotable.

## Supervisor filesystem and IPC contract

`comparison-supervisor` keeps opaque Rust `OfficialDirectory` and
`CreatedFileToken` values in its own process. No NAPI export, TypeScript object,
scenario child, verifier child, or report child can acquire them. Its internal
API is:

```rust
fn adopt_staging(fd: RawFd, expected: PosixDirectoryIdentity)
  -> Result<OfficialDirectory>;
fn create_campaign_exclusive(
  parent_fd: RawFd,
  candidate: &str,
  campaign_id: &str,
) -> Result<(OfficialDirectory, PosixDirectoryIdentity, CampaignReservation)>;
fn read_file(dir: &OfficialDirectory, components: &[Component], max: u64)
  -> Result<Vec<u8>>;
fn hash_file(dir: &OfficialDirectory, components: &[Component], max: u64)
  -> Result<FileDigest>;
fn ensure_directory(dir: &OfficialDirectory, components: &[Component])
  -> Result<()>;
fn create_file_exclusive(
  dir: &OfficialDirectory,
  components: &[Component],
  bytes: &[u8],
  max: u64,
) -> Result<CreatedFileToken>;
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
- `read_file` fails before allocating beyond its required positive bound and
  detects growth. `hash_file` streams raw files without exposing bytes to JS.
- `create_file_exclusive` is create-new only, mode `0600`, never replaces a
  destination, and returns an opaque token bound to supervisor instance,
  campaign reservation, parent identity, leaf identity, and operation.
- `abort_created_file` accepts only that token and may remove only the still
  matching uncommitted leaf. There is no component-based deletion surface.
- `sync` durably synchronizes created files and pinned parents before success.
- Close is deterministic and idempotent; other operations after close fail
  `OUTPUT_HANDLE_CLOSED`.
- No operation starts the WebTransport Tokio runtimes or permits unbounded
  buffering.
- There is no `readdir`, glob, rename, replace, arbitrary-open, or pathname
  escape. The supervisor reads the manifest, then exactly its components.

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
size, and payload SHA-256. Allowed output kinds are artifact, each of the five
raw kinds, pre/post snapshot, attestation, verifier-result, report-markdown,
and report-envelope. The supervisor supplies input authority/lock/capability,
manifest, and exact descriptor-declared bytes as needed. Unknown kinds,
out-of-order/replayed frames, size/digest/identity mismatch, trailing stdout,
protocol text, timeout, or premature EOF kills the owned child PGID and writes
nothing for that frame.

### Frozen byte and crash limits

The wrapper refuses larger per-file maxima. `readFile` is limited to authority
256 KiB, capability 1 MiB, lock 16 MiB, manifest 64 MiB, artifact 16 MiB,
snapshot 16 MiB, verifier result 16 MiB, and report 32 MiB. Raw files are never
returned to JS; `hashFile` streams at most 256 MiB with a 1 MiB native buffer.
Writes have the same kind-specific limits and a 512 MiB aggregate official-I/O
budget per operation.

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
  exec, verify its `st_dev`, `st_ino`, owner, mode, directory type, and local
  filesystem policy against the authority tuple, then walk each component with
  `openat(..., O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)`.
- Create an intermediate with `mkdirat`, then reopen it with the same no-follow
  directory flags. Capture the created identity with no-follow `fstatat`, then
  require the reopened descriptor to match; treat any replacement,
  cross-device component, non-directory, link, or mount alias as failure.
- For a leaf, use no-follow `fstatat` first to reject a visible link, FIFO,
  socket, or device without opening it. Open reads parent-relative with
  `O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC`, then require descriptor
  `fstat` to be the same regular-file identity observed before open. Root and
  descendant ownership/modes prevent concurrent untrusted replacement; both
  checks and adversarial replacement hooks remain mandatory.
- Publish leaves with parent-relative `openat(..., O_WRONLY | O_CREAT |
  O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600)`.
- Use bounded write loops, `fdatasync`/`fsync`, parent-directory `fsync`, and
  parent-relative `unlinkat` only through a matching native creation token.
- Reject `/dev/fd`-style aliases, procfs-style magic links, cross-device
  descendants, case/normalization aliases that do not match canonical
  components, and any group/world-writable root or intermediate.
- Linux may use `openat2` as an additional defense, but correctness may not
  depend on its availability; the descriptor walk is the POSIX contract.

`secure_fs.rs` routes every OS operation through a sealed internal
`SecureFsSyscalls` trait. Production uses `LibcSyscalls`; tests use
`ScriptedSyscalls` with an exact call queue for `fcntl`, `fstat`, `fstatat`,
`openat`, `mkdirat`, `read`, `write`, `fdatasync`, `fsync`, `unlinkat`, and
`close`. Each scripted call can return a short count, `EINTR`, `ENOSPC`,
permission/quota failure, identity replacement, or sync failure. Tests assert
the next call sequence, byte counters, cleanup token identity, and final error;
an unexpected/missing syscall fails the test. The trait is not exported from
the production crate surface.

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
- `OUTPUT_PLATFORM_UNSUPPORTED`
- `OUTPUT_INTERNAL`
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
| native read/write/sync/cleanup/type/race failure | `OUTPUT_*` except platform/unavailable/exists | 74 |
| boundary/platform unavailable | `OUTPUT_TRUST_BOUNDARY_UNAVAILABLE`, `OUTPUT_PLATFORM_UNSUPPORTED` | 69 |
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
- modify `package.json` comparison scripts to enter through the supervisor
- create `tools/compare/r1-entrypoint-red.test.ts`
- create `tools/compare/r1-physical-path-red.test.ts`
- create `tools/compare/check-official-io.ts`
- create `tools/compare/official-io-allowlist.json`

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
`comparison-official-io-allowlist/v1`, no optional fields, and freezes the
sorted production TypeScript set below. A missing or extra non-test `.ts` file
under `tools/compare` fails until this reviewed artifact is deliberately
updated:

```text
adapters/transport.ts adapters/ws.ts adapters/wt.ts artifact-builder.ts
bounded-queue.ts campaign-lock.ts canonical.ts client.ts compare.ts evidence.ts
host-sidecar.ts manifest-lock.ts netem.ts output-policy.ts pacer.ts
remote-supervisor.ts remote.ts render-report.ts run-campaign.ts
scenario-registry.ts scenarios/ai-token.ts scenarios/bulk.ts
scenarios/connections.ts scenarios/crdt.ts scenarios/fanout.ts scenarios/game.ts
scenarios/tail.ts scenarios/ticker.ts secure-fs.ts server.ts staged-capability.ts
stats.ts supervisor-client.ts supervisor-protocol.ts tls.ts topology.ts types.ts
verify-artifact.ts wire.ts
```

It permits filesystem imports/calls only in the Rust supervisor (outside the
TypeScript set). It forbids `node:fs`, `node:fs/promises`, `node:path`, `Bun.file`,
`Bun.write`, `readdir`, `glob`, legacy official path helpers, dynamic imports,
addon loaders, and `measureCellArm` in the transitive production import graph
rooted at run/verify/report/artifact-builder. `bun
tools/compare/check-official-io.ts` parses imports plus forbidden call tokens,
prints the canonical scanned-file-set SHA-256, and fails on a missing/extra
file or forbidden edge. The tracked allowlist itself is reviewed and hashed by
the authority `reviewedDiffSha256`.

## Execution sequence

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
8. Freeze canonical bytes and every field/order for authority, host submission,
   reservation, lock, capability, attestation, descriptor, manifest, verifier,
   report, supervisor input/output, and supervisor error records. Test the
   exact seven-step bootstrap/publication order and reject a manifest that
   names itself, verifier output, or report output.
9. In `r1-entrypoint-red.test.ts`, add the tracked allowlist checker and
   runtime I/O spies proving all four official entrypoints cannot call
   `node:fs`, `Bun.file`, pathname helpers, enumeration, the legacy official-I/O
   functions, or a synthetic/default `measureCellArm`. Test executors require
   `fixtureOnly: true` and cannot receive an official handle or promote output.
10. In `r1-physical-path-red.test.ts`, require independently supplied Mac route,
   Linux route, server-observed peer, interface, source, MTU, and qdisc facts.
   Reject copied planned facts, localhost/loopback, same-host roles, Tailscale
   measurement addresses/interfaces, missing Linux observations, and any
   scenario that did not use the Linux server.
11. Run the focused RED command, Rust scripted-syscall tests, and the allowlist
   checker; independently verify failures correspond to
   missing production APIs—not broken fixtures or accidental network access.
12. Obtain an unconditional RED approval before Task B. Any requested RED edit
   requires another focused run and fresh review.

### Task B — Implement the native boundary

1. Add the named Rust tests first for component validation, descriptor/handle
   lifetime, leaf type, byte bound, exclusive publication, sync, cleanup, and
   parent-swap behavior.
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

1. Make package scripts invoke `comparison-supervisor`, which in turn launches
   campaign, verifier, report, and artifact-builder children with validated
   input frames. Children receive no filesystem descriptors/paths. Remove
   unbound defaults and trust-marker environment paths.
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
   and inherited pipes with no sockets. Prove the main package-script path,
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
   verification. Only then may the parent recovery plan proceed to real roles,
   staging, diagnostics, and campaign execution.

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
