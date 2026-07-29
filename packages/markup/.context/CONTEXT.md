# markup — contracts and invariants

## Public surface

`@meridian/markup` exports:

- `createMarkupCodec({ schema, assetPathResolver })` builder.
- Preset wrappers: `markdownCodec({ schema, assetPathResolver })` and
  `mdxCodec({ schema, components, assetPathResolver })`.
- `AssetPathResolver` adapters: `unresolvedAssetPathResolver` (refuses to
  serialize an asset ref) and `createAssetPathResolver(entries)`.
- Plugin factories: `markdown()` and `mdx({ components })`.
- Both presets include the first-class `[[target]]` wikilink extension. It maps
  to the existing link mark with `href: "[[target]]"` and `title: null`; labels
  are deliberately not part of the syntax.
- Codec author helpers for converting between ProseMirror nodes and mdast/MDX
  AST nodes.
- Codec and AST types, `CodecParseError`, and MDX component registry types.
- `builtInComponents` (reserved wire components handled by dedicated codecs) and
  `documentComponentRegistry` (the product component set every document surface
  shares).

Preset-internal codec lists (`markdownBlockCodecs`, `markdownMarkCodecs`,
`mdxBlockCodecs`, and required-block-name lists) are not exported from the
package root. Tests or preset internals that need them import from sibling
`markdown/index.js` / `mdx/index.js` modules instead.

`MarkupCodec` exposes only `parse`, `serialize`, `serializeBlock`, and
`serializeBlocks`. `serializeBlock`/`serializeBlocks` return normalized block
bodies without hash prefixes. Agent-edit owns any hash-prefixed adapter layer.

## Builder semantics

`MarkupPlugin` can provide `blocks`, `marks`, `remarkPlugins`, `preprocess`,
`postParse`, and `postSerializeBlock` hooks. Markdown autolink demotion is intentionally owned by the
markdown/mdx plugins via `postParse`, not the builder; non-markdown format
plugins do not inherit markdown-specific autolink behavior by default.

Merge order:

- Blocks are LIFO by plugin: later `.use()` blocks are prepended and get first
  parse priority.
- Marks and remark plugins accumulate in `.use()` order.
- `preprocess` hooks run LIFO.
- `postParse` hooks run FIFO.
- `postSerializeBlock` hooks run FIFO, wrapping a block's ordinary codec output.

Build validation always rejects duplicate block names, duplicate mark names, and
missing schema mark codecs. Required block validation is opt-in through
`requiredBlockNames` or `requireSchemaBlockCoverage`; schema coverage excludes
`doc`, `text`, and `hard_break`.

## MDX components

`ParseContext` and `SerializeContext` carry the schema and the asset-path
resolver. The MDX plugin
creates fresh `createJsxLeafCodec(components)` and
`createJsxContainerCodec(components)` instances so component lookup is captured
in closures. `registeredComponent(components, name)` remains a helper with an
explicit registry parameter.

## Asset paths

Images hold a stable `asset:<documentId>` src inside ProseMirror; markdown holds
a project-relative path. `AssetPathResolver` is the only translation seam, and
it is required — a consumer with no project asset namespace passes
`unresolvedAssetPathResolver` and gets a throw rather than a silently wrong URL.
`assetForPath` returns null for anything the project does not know, so external
and unknown paths stay literal.

## Reserved wire components

`Figure` and `Layout` are reserved names: `registeredComponent()` refuses them so
a product registry can never shadow their dedicated codecs.

`Layout` is a wire-only wrapper with no schema node behind it. It carries block
alignment (`align`) and table column widths (`widths`) that live as attrs on
`paragraph`, `heading`, and `table`. Serialization runs through the MDX plugin's
`postSerializeBlock` hook, so an unstyled document stays byte-identical plain
markdown; only a styled block gains a wrapper. Parsing goes through
`createLayoutCodec()`, which re-parses its single child through
`parseRecognizedBlockAst()` and falls back to inert raw text when the wrapper is
malformed. `layout` is therefore excluded from `mdxRequiredBlockNames`.

Table serialization rejects what GFM cannot represent rather than dropping it:
cell `colspan`/`rowspan` other than 1, and `colwidth` values that are not a
single positive integer, throw.

## Preprocessed source invariant

`parse()` applies the accumulated preprocess chain first, parses that transformed
string, stores it as `runtime.source`, then runs post-parse hooks before PM
conversion. `rawTextForAst()` slices from `runtime.source`, so fallback text and
AST positions stay self-consistent even when preprocessors rewrite input.

## Wikilinks

`[[target]]` is a non-GFM inline construct shared by the markdown and MDX
presets. It carries only the target text: `[[target|label]]` is literal text, not
an alternate spelling. A parsed wikilink uses the ordinary ProseMirror `link`
mark, so it needs no schema node or extra mark attributes. Resolution never
occurs in the codec; unresolved targets round-trip unchanged.
