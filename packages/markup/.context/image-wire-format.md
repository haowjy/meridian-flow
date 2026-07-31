# Image wire format

Images preserve their asset identity in ProseMirror while selecting the smallest
Markdown or MDX spelling that retains the writer's image attributes. This page
owns the image codec's accepted syntax and its raw-HTML entity boundary; see
[CONTEXT.md](CONTEXT.md) for the package's public API and the generic asset-path
resolver contract.

## Minimal serialization

A picture takes the minimal wire spelling that preserves it, the way a table
does. `width: null` — a picture at the size of its own file — is
`![alt](path)`, byte for byte, and that is nearly every picture. A picture the
writer resized escalates to `<img src alt title width />` and de-escalates the
moment the width is cleared. `markdown/blocks/image-html.ts` owns both
directions; `markdown/html-tag.ts` holds the raw-tag reader and the MDX-strict
attribute escaper that the table escalation shares.

## Recognized ingress forms

Three shapes reach the parse and mean the same picture: a raw `html` node (pure
Markdown, inline or block), `mdxJsxTextElement`, and `mdxJsxFlowElement` (MDX,
where `img` is a lowercase intrinsic). A tag carrying anything the package would
not write back the same way — an unknown attribute, a percentage or fractional
width, an expression attribute — parses as nothing and stays the inert text it
already was.

## Raw HTML entity boundary

Raw HTML image attributes cross one entity-decoding boundary in
`parseRawImageHtmlAttributes()` before asset-path resolution. MDX JSX attributes
skip that boundary because the MDX parser has already decoded them. Images
inside raw HTML tables use the same raw boundary, then pass the decoded image
facts directly to `imageNodeFromAttributes()`; they are never
escaped into a synthetic tag and parsed a second time.

The raw boundary uses `parse-entities` with HTML attribute-context semantics;
raw table text uses its text-context semantics. Decoding is one pass, not
recursive: a value that still looks like `&amp;` or `&quot;` afterward is
literal document data, and regression coverage must keep zero, one, and two
decodes observably different.

## Block placement and MDX ingress

Two placements follow from a picture being inline in the schema and a whole
block of the document when it stands on its own line. `parseBlockAst` wraps any
inline answer in a paragraph, for every codec, because an `html` node does not
say which of the two it is. `imageCodec` is hoisted above the JSX codecs in the
MDX block chain for the same reason `tableCodec` is: otherwise the raw tag
reaches `jsx_leaf` as an unregistered component.

MDX ingress preserves `<img>` unescaped alongside PascalCase components
(`escape.ts`); encoding it turns every resized picture into literal text.
