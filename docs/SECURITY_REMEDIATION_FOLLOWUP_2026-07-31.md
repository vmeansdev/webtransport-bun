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
