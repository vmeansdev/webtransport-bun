# Branches, channels and tags

```
feature/*, fix/* ──(PR)──► development ──(each green push)──► canary    npm @canary
                          │        ──(daily, newest green)──► nightly   npm @nightly
                          └──(release PR, merge commit)──► main ◄── v1.0.0-rc.N (npm @next)
                                                             ◄── v1.0.0     (npm @latest)
```

## Branches

| Branch | What it is | Who moves it |
|---|---|---|
| `development` | Integration branch and the repository's default branch. All work lands here. | Pull requests only, merged when the required checks are green |
| `canary` | The newest development commit that passed `test` and was built by `channels.yml`. | `channels.yml` only, fast-forward |
| `nightly` | Development's newest green commit as of the daily build. | `channels.yml` only, fast-forward |
| `main` | Stable line. Only release merges from development and hotfixes land here; every release and release candidate is tagged here. | Release and hotfix pull requests only, merged with a merge commit (by convention; see Releases) |
| `feature/*`, `fix/*`, `chore/*`, `release/*` | Short-lived work branches off development; deleted after merge. | Anyone |
| `hotfix/*` | Off `main` (the released tag) for a fix to a shipped version; merged into `main` by pull request, then a `main` → `development` pull request brings it back. | Maintainer |

`canary` and `nightly` are never committed to directly: they only ever point at
commits already on `development`, so `git log development..canary` is always
empty. A channel that diverges from development fails `channels.yml` instead of
being rewritten.

## Channels

| Channel | Version | npm dist-tag | GitHub pre-release |
|---|---|---|---|
| canary | `<base>-canary.<commit count>.g<sha7>` | `canary` | `channel-canary` (rolling) |
| nightly | `<base>-nightly.<YYYYMMDD>.g<sha7>` | `nightly` | `channel-nightly` (rolling) |
| release candidate | `<base>-rc.N` from tag `v<base>-rc.N` | `next` | `v<base>-rc.N` |
| stable | `<base>` from tag `v<base>` | `latest` | `v<base>` |

`<base>` is the version committed in `packages/webtransport/package.json`. To
try unreleased work:

```bash
bun add @webtransport-bun/webtransport@canary
```

Canary and nightly builds come from `development` and carry none of the release
gates (soak, coverage, fuzz campaign, evidence). They are for trying changes
early, not for production.

`channels.yml` ships exactly what a release ships: the same
`build-prebuilds.yml` prebuilds for every target, and the same tarball build and
Bun/Node/Deno smoke as `release.yml`. It publishes to npm first and only then
fast-forwards the channel branch and replaces the rolling pre-release, so the
branch always names the commit its channel serves.

### npm setup (once)

Channel publishing uses its own npm trusted publisher, separate from the
stage-only one that `publish.yml` uses for releases:

1. On npmjs.com, package `@webtransport-bun/webtransport` → Settings → Trusted
   publishers → add GitHub Actions: repository `vmeansdev/webtransport-bun`,
   workflow `channels.yml`, environment `npm-channels`, and allow direct
   publishing (`npm publish`).
2. In the repository settings, create the `npm-channels` environment and limit
   its deployment branches to `development` (the branch `channels.yml` runs on).
3. Set the repository variable `CHANNELS_NPM_PUBLISH` to `true`.

Until step 3, each channel build warns that it skipped npm and still moves the
branch and the GitHub pre-release.

npm lists a new trusted publisher as "Pending validation" and expires it unless
it publishes within about 48 hours. An expired publisher makes `npm publish`
fail with `ENEEDAUTH` (this is what failed the rc.5 publish). Create a publisher
only when a publish will follow inside that window, and replace an expired one
by deleting it and creating it again. The channels publisher stays valid as
long as canary keeps publishing.

This publisher can publish without a 2FA approval, which is what makes the
channels automatic. npm cannot restrict a publisher to one dist-tag; the
workflow refuses any version that is not `-canary.` / `-nightly.` and always
passes `--tag <channel>`, and the environment's branch limit keeps other
branches' workflows from using it.

## Releases

1. Open a pull request from `development` to `main` and merge it with a merge
   commit (not squash or rebase) once the required checks are green. This is
   a maintainer convention, not an enforced rule:
   `.github/rulesets/integration-branches.json` allows all three merge methods
   on both branches, so avoid squash and rebase by hand: `main` has to contain
   development's own commits for the next release pull request to merge
   cleanly.
2. Tag the merge commit `v<base>-rc.N` and push the tag. `release.yml` runs the
   gates, creates the pre-release and attaches the evidence; `publish.yml`
   stages the version on npm under `next` for 2FA approval.
3. When the GA gates pass on that candidate (docs/RELEASE_CHECKLIST.md), tag
   the same commit `v<base>`.
4. Right after a stable release, bump the committed base on `development` to the
   next version (for example `1.0.1` or `1.1.0`) so channel builds sort above
   the release.

## Tags

| Pattern | Meaning | Mutable |
|---|---|---|
| `v<semver>` | Releases and release candidates, on `main` | No (ruleset) |
| `channel-canary`, `channel-nightly` | Rolling pre-releases, recreated per channel build | Yes, by `channels.yml` |

No other tags are created.

## Protection

The rulesets in `.github/rulesets/` are applied to the repository:

- `development`, `main`: no direct pushes. Changes land through pull requests
  (no approval count, since there is one maintainer; review threads must be
  resolved) whose required checks are green: the three `test` OS jobs, parity,
  WASM + Chromium interop, the UDP fault matrix, load, soak, matrix release
  evidence, coverage, both Trivy scans and both CodeQL analyses
  (`integration-branches.json`). No one bypasses it; a check that must change
  is changed in the ruleset file and re-applied.
- `development`, `main`, `canary`, `nightly`: no deletion, no force-push
  (`protected-branches.json`).
- `v*` tags: no deletion, no update (`release-tags.json`).

When a required job is renamed, update `integration-branches.json` in the same
pull request and re-apply it, or every later pull request waits on a check
that never reports.

Apply one as a repository admin (a ruleset with the same name must be updated
with `PUT .../rulesets/<id>` instead of created again):

```bash
gh api --method POST repos/vmeansdev/webtransport-bun/rulesets --input .github/rulesets/protected-branches.json
```
