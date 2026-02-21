webtransport-bun/
  AGENTS.md
  SPEC.md
  ARCHITECTURE.md
  SECURITY.md
  TESTPLAN.md
  OPERATIONS.md
  CI.md
  CONTRIBUTING.md
  package.json
  bunfig.toml
  tsconfig.json
  crates/
    native/               # Rust napi-rs addon
      Cargo.toml
      src/lib.rs
    reference/            # Rust reference server/client used for interop + debugging (optional but recommended)
      Cargo.toml
      src/main.rs
  packages/
    webtransport/         # JS/TS wrapper + types + tests for Bun
      package.json
      src/index.ts
      src/errors.ts
      src/streams.ts
      test/
        server.test.ts
        client.test.ts
  tools/
    interop/              # Chromium interop harness (Playwright)
      package.json
      playwright.config.ts
      tests/
        chromium-client.spec.ts
    load/                 # load/soak scripts
      README.md
