# Publish Verification Checklist

Before publishing to npm, ensure all items pass.

## 1. Build outputs exist

- [ ] `dist/index.js` exists
- [ ] `dist/index.d.ts` exists
- [ ] All referenced dist files exist (errors.js, streams.js, etc.)

```bash
npm run clean && npm run build
ls dist/
```

## 2. Tarball contains required files

```bash
npm run pack:check
```

Verify output includes:

- `package/dist/index.js`
- `package/dist/index.d.ts`
- `package/prebuilds/webtransport-native.*.node` (darwin-arm64, darwin-x64, linux-x64 as built)
- `package/README.md`
- `package/LICENSE`

## 3. Install + import smoke test

```bash
cd /tmp
rm -rf wt-pub-test && mkdir wt-pub-test && cd wt-pub-test
bun init -y
# From repo: bun add file:/path/to/packages/webtransport
# Or after pack: bun add /path/to/webtransport-bun-webtransport-0.1.0.tgz

bun -e "import('@webtransport-bun/webtransport').then(m=>console.log('OK', Object.keys(m).length))"
```

Confirm native addon loads on your OS/arch.

## 4. Platform constraints

- Package has `"os": ["darwin","linux"]` and `"cpu": ["arm64","x64"]`
- On unsupported platforms, `bun add` may succeed but import will throw ("requires Bun" or "Native addon not loaded")

## 5. Version and access

- Bump version with semver before publish
- Scoped package: `publishConfig.access: "public"` is set

## Publish command

```bash
cd packages/webtransport
npm version patch  # or minor/major
npm publish
```
