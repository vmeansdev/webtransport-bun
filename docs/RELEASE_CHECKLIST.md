# Release Checklist

Required gates and process for cutting a release (RC or stable).

## Required gates (automated)

The release workflow enforces these; the pipeline fails if any are missing:

| Gate | Job | Evidence artifact |
|------|-----|-------------------|
| Security | security | cargo audit, Trivy (no CRITICAL/HIGH) |
| Code quality | codeql | CodeQL analysis |
| Parity | parity | parity-evidence.json |
| Interop | interop | interop-evidence.json |
| Build | build | prebuilds + SHA256SUMS |

All evidence is attached to the GitHub release for audit. Links: release → Assets → `parity-evidence.json`, `interop-evidence.json`.

## N-consecutive green policy

Before tagging an RC or stable release:

1. **Require** the `test` workflow to have succeeded on the default branch (or release branch) for the commits you are releasing.
2. **Recommended**: Ensure at least 1–3 consecutive green `test` runs before tagging. For stable cuts, prefer a 14-day window of sustained green (no flaky reds, no force-push reverts).
3. **Verify**: Check Actions → test workflow for recent runs on your branch.

No automated enforcement of the 14-day window; this is a release checklist discipline.

## Soak evidence (RC / stable)

GitHub-hosted Actions jobs are capped at ~6 hours. A single 24h/72h soak cannot run as one GitHub-hosted job.

| Stage | Soak requirement | Artifact |
|-------|------------------|----------|
| RC | 1h soak recommended | soak-long workflow → soak-artifacts-1h |
| Stable | 24h soak mandatory (P2.2-A); 72h recommended | segmented soak artifacts (4x6h for 24h; 12x6h for 72h) **or** self-hosted long-run artifact |

Run strategy:

1. For GitHub-hosted runners: execute soak in chained segments (`<=6h` each), preserve artifacts/logs for every segment, and include an aggregate summary proving contiguous coverage.
2. For self-hosted runners: a single 24h/72h run is acceptable if logs/artifacts are retained.

Retain soak artifacts and link them in release notes (or a release-blocking issue) for audit.

## Evidence links (auditable)

Per release:

- **parity-evidence.json** — parity suite passed at release time
- **interop-evidence.json** — Chromium interop passed at release time
- **SHA256SUMS** — prebuild integrity
- **Soak artifacts** (if run) — leak/trend evidence from soak-long

These are linkable from the GitHub release Assets page.
