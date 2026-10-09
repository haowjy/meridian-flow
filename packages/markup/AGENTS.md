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
- MDX accepts lowercase HTML void elements without JSX closing slashes at the
  token boundary; all other JSX syntax and closure rules stay strict. Literal
  code and prose escaping do not pass through a tag-rewriting preprocessor.
- Runtime source is the preprocessed source so AST positions and fallback slicing
  agree.
- Every serialize call takes a `DocumentLinkScope`. A consumer with no document
  tree passes `UNSCOPED_DOCUMENT_LINKS`, which spells stored hrefs and keeps
  `asset:` refs as refs; never supply a permissive stand-in. A stored link `ref`
  is never read from or written to Markdown, HTML or MDX.
- The transitional `assetForPath` parse option (removed by #729/#730 lane F2)
  must decline anything it cannot resolve to exactly one asset, because a wrong
  guess writes a reference into the document that can never render.

See [`.context/CONTEXT.md`](.context/CONTEXT.md) for the public API contract.
