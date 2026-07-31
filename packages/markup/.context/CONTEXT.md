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

## Image sizes

A picture takes the minimal wire spelling that preserves it, the way a table
does. `width: null` — a picture at the size of its own file — is
`![alt](path)`, byte for byte, and that is nearly every picture. A picture the
writer resized escalates to `<img src alt title width />` and de-escalates the
moment the width is cleared. `markdown/blocks/image-html.ts` owns both
directions; `markdown/html-tag.ts` holds the raw-tag reader and the MDX-strict
attribute escaper that the table escalation shares.

Three shapes reach the parse and mean the same picture: a raw `html` node (pure
Markdown, inline or block), `mdxJsxTextElement`, and `mdxJsxFlowElement` (MDX,
where `img` is a lowercase intrinsic). A tag carrying anything the package would
not write back the same way — an unknown attribute, a percentage or fractional
width, an expression attribute — parses as nothing and stays the inert text it
already was.

Two placements follow from a picture being inline in the schema and a whole
block of the document when it stands on its own line. `parseBlockAst` wraps any
inline answer in a paragraph, for every codec, because an `html` node does not
say which of the two it is. `imageCodec` is hoisted above the JSX codecs in the
MDX block chain for the same reason `tableCodec` is: otherwise the raw tag
reaches `jsx_leaf` as an unregistered component.

MDX ingress preserves `<img>` unescaped alongside PascalCase components
(`escape.ts`); encoding it turns every resized picture into literal text.

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

Tables use the minimal wire spelling that preserves their structure. A table
with one header row, unit spans, single-line cell text, and consistent
per-column alignment stays in GFM pipes. Spans, headerless or mixed-header
rows, literal newlines, ragged rows, and per-cell alignment overrides escalate
to canonical raw HTML. Both spellings parse to the same `table` node. Hard
breaks remain GFM-expressible through the canonical backslash-newline spelling;
pipe-table ingress folds that continuation before remark parsing and restores
the `hard_break` node. Nested block serializers canonicalize remark's interim
`<br />` form back to backslash-newline with the surrounding quote/list prefix,
so container composition does not change the table dialect.

The HTML table path accepts positive `colspan` and `rowspan`, inline marks,
links, images, and `<br>` while declining unknown table structure as inert raw
text. Invalid PM span/alignment attrs and malformed `Layout` column widths
still throw rather than serialize lossily.

`widths` counts GRID columns, and so does `colwidth` (ruling, 2026-07-29). A
cell's index among its row's children stops being its column the moment
anything spans, so both sides walk the grid: `colwidth` holds one entry per
column the cell covers, and **zero means that column has no width**. That is
prosemirror-tables' own spelling — a resize sizes the array to the cell's
colspan and fills only the slot it touched — and what the table view reads
when it sizes the colgroup, so the codec follows it rather than the reverse.
A `colwidth` whose length disagrees with its cell's colspan is malformed and
throws; a zero is not, and neither is a fraction. Sizing a spanned column
divides the cell's box by its colspan, so the document legitimately holds
sub-pixel widths; the wire carries whole pixels and serialization rounds, which
converges the document on the next load. `Layout` keeps an HTML-spelled table
as raw text inside the wrapper instead of parsing and re-stringifying it as
MDX, which preserves entity-encoded literal newlines and braces. `Layout`
wrapping is applied by the runtime block hook even through list and blockquote
child serializers, so alignment on nested paragraphs round-trips.

## Preprocessed source invariant

`parse()` applies the accumulated preprocess chain first, parses that transformed
string, stores it as `runtime.source`, then runs post-parse hooks before PM
conversion. `rawTextForAst()` slices from `runtime.source`, so fallback text and
AST positions stay self-consistent even when preprocessors rewrite input.
MDX ingress asks CommonMark to classify raw-HTML literal ranges, then hides
their punctuation behind character references before the MDX parse. Valid
PascalCase components, supported HTML tables, and the hard-break spelling stay
active markup; syntax-looking text inside other raw HTML stays inert prose.
Whole-source CommonMark-classified enclosed link/image destinations likewise
keep their `<` delimiter active when an MDX syntax probe preserves the same
resource, including multiline titles.
If MDX cannot consume the resource (for example, a link label containing
nested link syntax), ingress keeps the delimiter escaped and the result
deterministic instead of exposing it as a JSX opener.

## Wikilinks

`[[target]]` is a non-GFM inline construct shared by the markdown and MDX
presets. It carries only the target text: `[[target|label]]` is literal text, not
an alternate spelling. A parsed wikilink uses the ordinary ProseMirror `link`
mark, so it needs no schema node or extra mark attributes. Resolution never
occurs in the codec; unresolved targets round-trip unchanged. Outer whitespace
inside the brackets is canonicalized away; whitespace within a target is kept.
Horizontal tabs and line endings are not valid target content.
Recognition belongs to the micromark label-end grammar and opaque mdast
resource nodes; do not normalize wikilink-looking destinations with a
source-wide scanner.
When display text differs from the target, ordinary Markdown link and image
resources may carry the same href, such as `[label]([[target]])` or
`![alt]([[target]])`. Those resource spellings round-trip too; they do not make
`[[target|label]]` valid wikilink syntax.
