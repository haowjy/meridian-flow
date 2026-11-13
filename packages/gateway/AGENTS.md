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
  It installs with `--ignore-scripts` and `@types/node` at the catalog range, and typechecks `.`
  and `./shapes` a second time without `@types/node` so a Node type in them fails.

## Releasing

Bump `version` in `package.json` in a PR; merging it to `main` runs
[`publish-gateway.yml`](../../.github/workflows/publish-gateway.yml). Its `verify` job packs the
tarball and runs `pnpm check:gateway-package` on it; its `publish` job (GitHub environment `npm`,
limited to `main`, the only job with `id-token`) publishes that same tarball with provenance when
the version isn't on the registry. A pre-release version (`0.2.0-rc.1`) goes to the `next` tag,
any other to `latest`. There is no token: npm trusted publishing names `haowjy/meridian-flow`,
workflow file `publish-gateway.yml` and environment `npm`.

Merges that bump the version faster than a run finishes can skip a middle version: GitHub keeps
one pending run, so only the latest bump publishes. Bump again to publish a skipped one.

### First publish (once)

npm can only attach a trusted publisher to a package that already exists (`npm trust` lists
"Package must exist" as a prerequisite), so the first version is published by hand:

1. `npm login` (2FA on), then from this directory `pnpm pack` and `npm publish <tgz> --access public`.
   That version has no provenance.
2. On npmjs.com, package Settings, Trusted publishing, GitHub Actions: repository
   `haowjy/meridian-flow`, workflow `publish-gateway.yml`, environment `npm` (or
   `npm trust github @meridian-flow/gateway --file publish-gateway.yml --repo haowjy/meridian-flow --env npm`).
3. Every later version is published by CI. The `npm` environment and its `main`-only deployment
   branch policy already exist in the repository's settings.

Until step 2 is done, the run on the merge of the PR that added this fails at `npm publish`.
