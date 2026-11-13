# @meridian-flow/gateway

The model gateway, published to npm for other products. Rationale and policy:
[`.context/CONTEXT.md`](.context/CONTEXT.md).

- Import no workspace package and nothing under `apps/`, and never read `process.env`:
  `pnpm check:architecture` fails the first, and keys come in through `ProviderConfig`.
  What Meridian Flow offers, charges and wires from `FLOW_` variables lives in
  `apps/server/server/lib/gateway/`. The SDKs read the environment for any option left unset
  (`*_BASE_URL`, `*_AUTH_TOKEN`, ...): `providerClientOptions` passes each explicitly, so a new
  SDK option that defaults from `process.env` needs the same (`*_CUSTOM_HEADERS` has no opt-out).
- `./shapes` must stay free of Node built-ins and SDKs: the browser bundle imports it through
  `@meridian/contracts`. The mock server (`node:http`) is only reachable from `./mock`.
- `exports` point at source for the workspace; `publishConfig.exports` points at `dist/` for the
  tarball. A new entry goes in both.
- `pnpm check:gateway-package` (part of `pnpm check`) packs the tarball, installs it with plain
  npm outside the workspace, imports each entry and typechecks it with `skipLibCheck: false`. It
  catches a type-only import of a workspace package, which ships `.d.ts` files nobody can resolve.

## Releasing

Bump `version` in `package.json` in a PR; merging it to `main` runs
[`publish-gateway.yml`](../../.github/workflows/publish-gateway.yml), which publishes the packed
tarball to npm with provenance when that version isn't on the registry. A pre-release version
(`0.2.0-rc.1`) goes to the `next` tag, any other to `latest`. There is no token: npm trusted
publishing needs `haowjy/meridian-flow` and the workflow file name set as the package's trusted
publisher on npmjs.com, once, before the first publish succeeds.
