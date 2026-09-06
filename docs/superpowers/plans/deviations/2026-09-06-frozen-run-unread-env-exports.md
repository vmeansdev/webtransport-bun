# Deviation — the frozen run command exports only variables production reads

**Date:** 2026-09-06
**Plan:** `2026-08-30-busyMs-attested-fanout.md` — unchanged
**Plan lines:** 2874-2875

## Plan text

```
export COMPARISON_SSH_IDENTITY="$SSH_KEY"
export COMPARISON_SSH_TARGET="$RIG"
```

## Deviation

Both exports are deleted from `buildFrozenRunCommand`
(`tools/compare/bin/stage-live-campaign.ts`). `export COMPARISON_RIG_ROLE_ROOT`,
which was not in the plan at all, is deleted with them.

## Reason

No production code reads any of the three. The controller's ssh identity is the
module constant `DEFAULT_SSH_IDENTITY` (`tools/compare/bin/compare-controller.ts:1282`,
`"~/.ssh/ubuntu-vm-hermes"`) and its ssh target is composed from `linux.user` and
`linux.address`; the rig role root is taken from the stage receipt
(`compare-controller.ts:3036`, `path: material.value.receipt.rigRoleRootPath`).
A frozen command that exports an identity nothing reads reads as a receipt-pinned
ssh identity and pins nothing — the placeholder-evidence shape: a field that
looks like evidence, has a name, and has no consumer.

Making the production ssh path read the exports is the better fix and is what
the finding preferred, but `compare-controller.ts` and `remote-supervisor.ts`
are owned by other slices in this amendment. **Residual, for the controller's
owner:** the identity a live run actually uses is a hardcoded default, not the
identity the stage receipt pinned. Deleting the exports removes the false claim;
it does not make the identity receipt-pinned.

## Proof

`tools/compare/bin/stage-live-campaign.test.ts`,
`exports_no_variable_that_no_production_code_reads`, derives every namespaced
environment name production reads from the sources themselves (TypeScript
`process.env.X` / `process.env[CONST]` / `env.X`, plus string literals in
`crates/**/*.rs`) and asserts the generated command exports nothing outside that
set. Re-adding any of the three exports turns it red. Nothing changes at run
time: the deleted variables had no reader.
