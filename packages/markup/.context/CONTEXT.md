# markup — contracts and invariants

## Public surface

`@meridian/markup` exports:

- Presets: `markdownCodec({ schema, assetPathResolver })` and
  `mdxCodec({ schema, components, assetPathResolver })`.
- `AssetPathResolver` adapters: `unresolvedAssetPathResolver` (knows no assets:
  refs stay refs, paths stay literal) and `createAssetPathResolver(entries)`.
- `formatMarkdownLink(label, href)`: a plain-text `[label](destination)` for
  surfaces that spell a link without serializing a document (a chat
  reference, a clipboard fallback). It shares the link mark's destination rule.
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

## Round-trip guarantees

These concern supported durable document semantics, not CRDT identity or history.
A newly parsed document cannot replace an existing Yjs replica without losing
that replica's identities and merge lineage. Arbitrary accepted Markdown may
normalize on first parse; canonical wire spelling then stabilizes.

- **Structural stability:** parsing serialized document blocks produces the same
  ProseMirror document semantics.
- **Canonical bytes:** `serialize(parse(canonicalWire))` reproduces the canonical
  wire spelling with the codec's trailing newline.
- **Deterministic serialization:** the same valid block input produces the same
  wire string.
- **Prose safety:** literal `<` and `{` in prose round-trip (escaped on ingress,
  no double-escape).

## Internal preset composition

`MarkupPlugin` can provide `blocks`, `marks`, `remarkPlugins`, `preprocess`,
`postParse`, and `postSerializeBlock` hooks. Markdown autolink demotion is intentionally owned by the
markdown/mdx plugins via `postParse`, not the builder; non-markdown format
plugins do not inherit markdown-specific autolink behavior by default.
Hooks receive the preprocessed source matching AST positions and run on internal
reparses too. Only bare GFM autolink literals are demoted to prose; links whose
source opens with `[` remain links even when their words equal their
destination. Angle autolinks (`<kb://a.md>`) remain links in Markdown only;
MDX ingress escapes them to literal text. Links without usable source positions
are retained, not guessed.
The GFM legacy text transform is disabled: it invents positionless links from
escaped URL prose after tokenization. Positioned GFM literal tokens still parse
and are demoted. The serializer always writes resource links (`[x](x)`),
never angle autolinks, so generated links survive MDX and Layout wrappers.

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
`unresolvedAssetPathResolver`. A picture never fails its document:
`pathForAsset` returns null for an id with no document, and the codec spells it
as the `asset:` ref itself, which parses back to the same reference.
`assetForPath` returns null for anything the project does not know, so external
and unknown paths stay literal.

## Image wire format

Image serialization, accepted ingress shapes, placement, and raw-HTML entity
handling live in [image-wire-format.md](image-wire-format.md). The image
contract is separate from the generic asset-path translation seam above because
it owns the markdown/MDX spelling and the exact-once HTML decoding boundary.

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

Tables serialize as canonical raw HTML unconditionally. GFM pipes remain
liberal ingress and normalize to HTML in one parse-serialize pass, including
the backslash-newline hard-break spelling. HTML cells carry paragraphs,
headings, lists, blockquotes, fenced-code content, horizontal rules, and nested
tables; inline marks, links, images, and `<br>` remain legal inside their text
blocks. Block kinds without a native cell HTML spelling use one
`<meridian-block>` envelope carrying their ordinary top-level wire form. A
nested table's visible body is the source of truth, so it still renders as a
table; non-HTML MDX blocks use the carrier's entity-escaped `source` attribute
instead. Neither form duplicates its source. Parsing re-enters the complete
block codec with a fresh source context, so Figure, registered JSX, nested
table Layout metadata, and future block codecs do not need a second table-only
implementation. The carrier declares the expected ProseMirror block kind and
the parser rejects the whole table as inert source when the delegated spelling
parses as anything else. Positive `colspan` and `rowspan` round-trip. Unknown
table structure is inert raw text, while invalid PM span/alignment attrs and
malformed `Layout` column widths still throw rather than serialize lossily.

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

## Links

A link is a standard Markdown link, `[text](destination "title")`, in both
presets; there is no wikilink syntax. `[[anything]]` is literal text on parse
and serializes with its openers escaped (`\[\[name]]`), so it reads back as the
same text. Images are `![alt](src)`; uploaded pictures keep their
`asset:<id>` identity inside the editor and travel as resolver paths.

The link mark spells its destination so the parser reads it back exactly
(`markdownLinkDestination`): bare when it can be, else enclosed in `<…>` with
backslashes and angle brackets escaped. Neither form may span lines, so a line
ending travels percent-encoded, which the document href resolver
(`@meridian/contracts` `resolveDocumentHref`) decodes back. The final bytes are
the Markdown stringifier's: a destination with spaces goes out enclosed
(`[x](<chapter 1.md>)`). Resolution never occurs in the codec; an unresolved destination
round-trips unchanged.

Wire recognition does not authorize creating a Context file at a destination.
The app's shared Context entry-name validator owns filename policy separately.
