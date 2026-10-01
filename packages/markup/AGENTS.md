# @meridian/markup

Composable text ↔ ProseMirror codec package. MDX is the canonical Meridian wire
format; pure markdown is the supported subset. This is a leaf package: it must
not import from `@meridian/agent-edit` or any app/server shell.

## Mental model

Consumers use `markdownCodec` and `mdxCodec`. Codec/plugin composition stays
internal to this package; hash-prefixed agent-edit echo/view formatting lives
outside it.

## Invariants

- One codec name per ProseMirror node/mark. Duplicate block or mark
  registrations are build-time errors.
- Every schema mark must have a mark codec and both presets validate block
  schema coverage during construction.
- MDX component registries are closure-captured by MDX block codec factories, not
  threaded through parse/serialize contexts.
- Runtime source is the preprocessed source so AST positions and fallback slicing
  agree.
- Every codec requires an `AssetPathResolver`. A consumer with no project asset
  namespace passes `unresolvedAssetPathResolver` and gets a throw; never supply
  a permissive stand-in. `assetForPath` must decline anything it cannot resolve
  to exactly one asset, because a wrong guess writes a reference into the
  document that can never render.

See [`.context/CONTEXT.md`](.context/CONTEXT.md) for the public API contract.
