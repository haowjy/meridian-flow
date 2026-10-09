# markup — contracts and invariants

## Public surface

The root `@meridian/markup` exports:

- Presets: `markdownCodec({ schema })` and `mdxCodec({ schema, components })`.
- `DocumentLinkScope` and `UNSCOPED_DOCUMENT_LINKS` (no tree: every stored
  href and src spells as written, `asset:` refs stay refs). The fixed-table
  `createAssetFixture(entries)` is a test helper in `src/codec-test-support.ts`,
  not a package export.
- `formatMarkdownLink(label, href)`: a plain-text `[label](destination)` for
  surfaces that spell a link without serializing a document (a chat
  reference, a clipboard fallback). It shares the link mark's destination rule.
- Codec author helpers for converting between ProseMirror nodes and mdast/MDX
  AST nodes.
- Codec and AST types, `CodecParseError`, and MDX component registry types.
- `builtInComponents` (reserved wire components handled by dedicated codecs) and
  `documentComponentRegistry` (the product component set every document surface
  shares).

Two subpath entries carry the link rules, so a consumer loads only what it
uses (the client's assignment path loads neither codecs nor Yjs; the root
loads neither Yjs nor the schema builder):

- `@meridian/markup/links` (`links.ts`): the rules every host shares
  (`holder-link-scope.ts`, see Shared link rules): `createHolderLinkScope(holder,
  catalog)` over a `HolderCatalog`, `assignFreshLink` (pass 3),
  `classifyWrittenHref`, `writtenAddresses` and `writtenSourceUri`; and
  `walkLinkOccurrences(blocks)` / `spelledLinks(blocks, links)`
  (`link-occurrences.ts`), see Link occurrences.
- `@meridian/markup/stored-links` (`stored-links.ts`): `extractStoredLinks(fragment)`
  and `storedLinkKeys(...)`, the Yjs twin of the occurrence walk. It takes the
  fragment name from `@meridian/prosemirror-schema/protocol`, never the schema
  builder.

Preset-internal codec lists (`markdownBlockCodecs`, `markdownMarkCodecs`,
`mdxBlockCodecs`, and required-block-name lists) are not exported from the
package root. Tests or preset internals that need them import from sibling
`markdown/index.js` / `mdx/index.js` modules instead.

`MarkupCodec` exposes only `parse`, `parseWithSpans`, `serialize`,
`serializeBlock`, and `serializeBlocks`. Every serialize call takes the
`DocumentLinkScope` explicitly; nothing is captured at construction.
`serializeBlock`/`serializeBlocks` return normalized block bodies without hash
prefixes. Agent-edit owns any hash-prefixed adapter layer.

## Round-trip guarantees

These concern wire semantics: what Markdown/MDX can say. A stored link's
`ref` is deliberately not in the wire, so `parse(serialize(blocks))` returns
every link with `ref: null` and the destination the scope spelled; restoring a
ref is ref assignment's job, never the codec's. They also exclude CRDT
identity and history.
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
`doc`, `text`, and the table's row and cell nodes. `hard_break` is a registered
codec like any other block (see Hard breaks and emphasis).

## MDX components

`ParseContext` carries only the schema;
`SerializeContext` carries the schema and the call's `DocumentLinkScope`. The
MDX plugin
creates fresh `createJsxLeafCodec(components)` and
`createJsxContainerCodec(components)` instances so component lookup is captured
in closures. `registeredComponent(components, name)` remains a helper with an
explicit registry parameter.

## Link scope

Stored links, images and figures may carry a `ref` (`doc:<uuid>`, `ahead:<uuid>`,
see `@meridian/contracts` `document-ref.ts`). The codec never reads or writes
it: serialization asks the call's `DocumentLinkScope` for every destination
(`spellLink` for link marks and HTML-table anchors, `spellSource` for `image`
and `figure` sources) and writes only the spelled `href`. A scope spells a
resolvable ref as its target's current path, anything else as stored
(`spellStoredLink` in contracts), and an `asset:` source as the path the
project knows it by, else the ref itself: a picture never fails its document.

Parse is pure syntax: every parsed link has `ref: null` and its destination
as written, and every image and figure `src` is the source as written. The
shipped image rule (a known manuscript path becomes `asset:<id>`) runs after
parse, in the host's ref assignment over a prepared scope (agent-edit
`assignSources`), which is what lets a host load only what the text names.

## Shared link rules

Server, agent-edit and client resolve and assign through this package, so
none of them can disagree; the rules themselves are contracts'
`resolveStoredLink`, `spellStoredLink` and `classifyWrittenLink`. Each host
implements `HolderCatalog` over its own data (the server's prepared snapshot,
agent-edit's static catalog, the client's document index plus its settlement
memo). `undefined` from a catalog lookup is "not held": the server records a
snapshot miss, the client asks the server. `assignFreshLink` is pass 3 of ref
assignment for a written href or source: classify, then the document
`documentFor` finds (exact, then unique extension-omitted) spelled with
`storedHref`, else a minted ahead ref at `aheadAddress`; agent-edit's
`assignOccurrences` and the client's `assignWrittenHref` both call it. Only the
`stored-links` entry reads Yjs (`yjs`, plus the fragment name from the
side-effect-free `@meridian/prosemirror-schema/protocol`); markup stays a leaf
below agent-edit.

## Link occurrences

`walkLinkOccurrences(blocks)` is the one traversal of stored link occurrences:
document order, table cells row-major, one entry per maximal run of text
sharing one link mark (marks of a different kind do not split it), one per
`image` and `figure` (`src` reported as `href`). `parseWithSpans` returns one
source span per occurrence in that order: the AST position of the link run,
image or figure, or the enclosing top-level block when the AST cannot place it
(raw-HTML table anchors, a link wrapping an image), or the whole text when the
ingress preprocessor rewrote it. A span always encloses its occurrence.
`spelledLinks(blocks, links)` reports `{ ref, address }` for each ref-bearing
occurrence, spelled by the given scope; a serialization itself never records
what it showed. Its Yjs twin, `extractStoredLinks` (`stored-links.ts`), reads
the live fragment for derive, scope loading
and the revision digest; a parity row in agent-edit pins both walks to the same
`(kind, ref, href)` sequence.

## Image wire format

Image serialization, accepted ingress shapes, placement, and raw-HTML entity
handling live in [image-wire-format.md](image-wire-format.md). The image
contract is separate from the link scope above because
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
PascalCase components, images, supported HTML tables, and the hard-break spelling stay
active markup; syntax-looking text inside other raw HTML stays inert prose.
Whole-source CommonMark-classified enclosed link/image destinations likewise
keep their `<` delimiter active when an MDX syntax probe preserves the same
resource, including multiline titles.
If MDX cannot consume the resource (for example, a link label containing
nested link syntax), ingress keeps the delimiter escaped and the result
deterministic instead of exposing it as a JSX opener.

Both the codec and the enclosed-destination probe use
`remarkMdxWithHtmlVoidElements` (`mdx/syntax.ts`). Its JSX tag-exit adapter closes
lowercase HTML void names implicitly, leaving syntax/attributes and other closing
tags to remark-mdx. It does not rewrite source or positions. Registering stock
remark-mdx afterward would override these handlers. Ingress escaping still owns
which tags reach this parser: ordinary prose `<br>` and `<hr>` remain literal;
`<img>` and the canonical `<br/>` spelling remain active.

## Hard breaks and emphasis

A hard break between words is `\` and a newline. A break ending a paragraph
has no Markdown spelling (CommonMark reads a trailing `\` as a backslash), so it
and every break directly before it escalate to `<br/>`, the way a sized picture escalates to `<img>`.
`hardBreakCodec` (`markdown/blocks/hard-break.ts`) owns that tag in both
dialects and is hoisted above the JSX codecs in MDX; inline parsing asks it and
the image codec in turn, and a lone break wraps back into a paragraph. MDX
parses one element per `<br/>`, so its `postParse` (`joinBreakLines`) regroups
the tags on one source line into one paragraph; a paragraph of only breaks
round-trips.

Overlapping bold and italic split into adjacent sibling runs whose delimiters
would fuse (`****`). `markdown/attention.ts` overrides the stringify handlers:
along a chain of adjacent bold or italic runs the marker alternates, `_` after
an odd count (`*a*__b__*c*`), and `peek` reports the same marker. Strike gets
the edge encoding remark gives `*`, so a strike starting or ending on a space
or punctuation writes that character, or the letter outside it, as a character
reference (`Li&#x6E;~~&#x20;Feng~~`). The encoding is
copied from `mdast-util-to-markdown`'s private `encodeInfo`; recheck it when
that dependency moves.

## Links

A link is a standard Markdown link, `[text](destination "title")`, in both
presets; there is no wikilink syntax. `[[anything]]` is literal text on parse
and serializes with its openers escaped (`\[\[name]]`), so it reads back as the
same text. Images are `![alt](src)`; uploaded pictures keep their
`asset:<id>` identity inside the editor and travel as scope-spelled paths.

The link mark spells its destination so the parser reads it back exactly
(`markdownLinkDestination`): bare when it can be, else enclosed in `<…>` with
backslashes and angle brackets escaped. Neither form may span lines, so a line
ending travels percent-encoded, which the document href resolver
(`@meridian/contracts` `resolveDocumentHref`) decodes back. The final bytes are
the Markdown stringifier's: a destination with spaces goes out enclosed
(`[x](<chapter 1.md>)`). Resolution never occurs in the codec: the scope
it is handed spells the destination, and a no-ref destination round-trips
unchanged.

Wire recognition does not authorize creating a Context file at a destination.
The app's shared Context entry-name validator owns filename policy separately.
