# Security remediation operational follow-up

Owner: `vmeansdev` repository owner / release maintainer
Status: pending external credential and history administration
Recorded: 2026-07-31

The interop evidence artifact from the security scan contained inherited local
environment data, including a credential-shaped value. The repository-side
serialization and release-upload boundaries are now sanitized and validated,
but two actions require access that is intentionally unavailable from this
checkout:

1. Review and rotate the exposed `LOKALISE_API_TOKEN` with the secret owner and
   review the associated `OLLAMA_API_KEY` and any other credentials present in
   the affected release artifact.
2. Purge the affected release-evidence object and the disclosed artifact from
   published release storage and repository history according to the release
   retention policy. Revoke or invalidate any cached copies where the hosting
   provider supports it.

Do not treat the checked-in artifact deletion as a history purge. The next
release owner must confirm rotation and purge completion before declaring the
incident fully closed.

## Repository-side status (2026-08-03)

Evidence privacy validation no longer stops at `config.webServer.env`.
`tools/interop/verify-evidence.ts` walks the whole document and rejects
credential-shaped keys and values plus absolute, UNC, home, and temporary host
paths at any depth, reporting a JSON pointer and never the rejected value.
Playwright interop reports are now redacted at generation time by
`tools/interop/evidence-sanitizer.ts`, with the validator as the backstop. Every
tracked and generated interop JSON file passes.

Still outstanding on the repository side, and not covered by this task: tracked
coverage exports (`*-coverage.json`), `coverage-gates-floor-results.json`, and
`iwa-direct-sockets.json` under `docs/release-evidence/` still embed absolute
host source paths. These are non-interop artifacts whose consumers expect
absolute paths; redacting them needs its own scoped change.

Neither item above changes the external state. Credential rotation and the
published-artifact/history purge remain **pending operator action** with no
evidence supplied to this checkout.
