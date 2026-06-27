# @meridian/markup

Composable text ↔ ProseMirror codec package. MDX is the canonical Meridian wire
format; pure markdown is the supported subset. This is a leaf package: it must
not import from `@meridian/agent-edit` or any app/server shell.

## Mental model

`createMarkupCodec({ schema })` returns a builder. Plugins register block and
mark codecs plus optional remark and parse hooks. Built codecs parse text into
ProseMirror blocks and serialize ProseMirror blocks back to text; hash-prefixed
agent-edit echo/view formatting lives outside this package.

## Invariants

- One codec name per ProseMirror node/mark. Duplicate block or mark
  registrations are build-time errors.
- Every schema mark must have a mark codec. Block schema coverage is opt-in via
  `requiredBlockNames` or `requireSchemaBlockCoverage`.
- Block parse priority is LIFO by plugin: later `.use()` calls are tried first.
- MDX component registries are closure-captured by MDX block codec factories, not
  threaded through parse/serialize contexts.
- Runtime source is the preprocessed source so AST positions and fallback slicing
  agree.

See [`.context/CONTEXT.md`](.context/CONTEXT.md) for the public API and builder
contract.
