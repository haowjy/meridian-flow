# markup — contracts and invariants

## Public surface

`@meridian/markup` exports:

- `createMarkupCodec({ schema })` builder.
- Preset wrappers: `markdownCodec({ schema })` and
  `mdxCodec({ schema, components })`.
- Plugin factories: `markdown()` and `mdx({ components })`.
- Codec author helpers for converting between ProseMirror nodes and mdast/MDX
  AST nodes.
- Codec and AST types, `CodecParseError`, and MDX component registry types.

Preset-internal codec lists (`markdownBlockCodecs`, `markdownMarkCodecs`,
`mdxBlockCodecs`, and required-block-name lists) are not exported from the
package root. Tests or preset internals that need them import from sibling
`markdown/index.js` / `mdx/index.js` modules instead.

`MarkupCodec` exposes only `parse`, `serialize`, `serializeBlock`, and
`serializeBlocks`. `serializeBlock`/`serializeBlocks` return normalized block
bodies without hash prefixes. Agent-edit owns any hash-prefixed adapter layer.

## Builder semantics

`MarkupPlugin` can provide `blocks`, `marks`, `remarkPlugins`, `preprocess`, and
`postParse` hooks. Markdown autolink demotion is intentionally owned by the
markdown/mdx plugins via `postParse`, not the builder; non-markdown format
plugins do not inherit markdown-specific autolink behavior by default.

Merge order:

- Blocks are LIFO by plugin: later `.use()` blocks are prepended and get first
  parse priority.
- Marks and remark plugins accumulate in `.use()` order.
- `preprocess` hooks run LIFO.
- `postParse` hooks run FIFO.

Build validation always rejects duplicate block names, duplicate mark names, and
missing schema mark codecs. Required block validation is opt-in through
`requiredBlockNames` or `requireSchemaBlockCoverage`; schema coverage excludes
`doc`, `text`, and `hard_break`.

## MDX components

`ParseContext` and `SerializeContext` contain only `schema`. The MDX plugin
creates fresh `createJsxLeafCodec(components)` and
`createJsxContainerCodec(components)` instances so component lookup is captured
in closures. `registeredComponent(components, name)` remains a helper with an
explicit registry parameter.

## Preprocessed source invariant

`parse()` applies the accumulated preprocess chain first, parses that transformed
string, stores it as `runtime.source`, then runs post-parse hooks before PM
conversion. `rawTextForAst()` slices from `runtime.source`, so fallback text and
AST positions stay self-consistent even when preprocessors rewrite input.
