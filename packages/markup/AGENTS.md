# @meridian/markup

The text ↔ ProseMirror codecs, and the one home of the link rules the server
and client share: holder scope, fresh-link resolution (`assignFreshLink`, the
third pass of ref assignment) and stored-link walks. MDX is the canonical wire
format; plain Markdown is a supported subset. This is a leaf package: it never
imports `@meridian/agent-edit` or an app or server shell. The link rules ship at
`@meridian/markup/links` and the Yjs walks at `@meridian/markup/stored-links`;
keep both out of the root barrel so neither pulls in codecs, Yjs or the schema
builder.

## Mental model

Consumers use `markdownCodec` and `mdxCodec`. Codec and plugin composition
stays internal; agent-edit's hash-prefixed echo and view formatting lives
outside this package.

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
  `asset:` refs as refs, so only stored-bytes comparisons and tests use it;
  anything a reader sees spells through a holder scope, which never shows an
  id. Never supply a permissive stand-in. A stored link `ref`
  is never read from or written to Markdown, HTML or MDX.
- Parse never resolves anything. A host's ref assignment that claims a source as
  `asset:<id>` must decline anything it cannot resolve to exactly one asset,
  because a wrong guess writes a reference that can never render.

Public API contract: [`.context/CONTEXT.md`](.context/CONTEXT.md). Image wire
format: [`.context/image-wire-format.md`](.context/image-wire-format.md).
