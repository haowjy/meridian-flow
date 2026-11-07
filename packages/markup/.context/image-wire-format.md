# Image wire format

## Minimal serialization

A picture takes the minimal spelling that preserves it. `width: null` is
`![alt](path)`, byte for byte, and that is nearly every picture. A resized picture
escalates to `<img src alt title width />` and de-escalates when the width is cleared.
Tables serialize as HTML unconditionally; images keep this rule. The tag carries exactly
`src`, `alt`, `title`, `width` in a fixed order.

## Recognized ingress forms

A tag carrying anything the package would not write back the same way (an unknown
attribute, a percentage or fractional width, an expression attribute) parses as nothing and
stays the inert text it already was.

## Raw HTML entity boundary

Raw HTML image attributes cross one entity-decoding boundary in
`parseRawImageHtmlAttributes()` before the asset rule claims a known path. MDX JSX attributes
skip it because the MDX parser has already decoded them. Images inside raw HTML tables use the
same boundary, then pass the decoded facts directly to `imageNodeFromAttributes()`; they are
never escaped into a synthetic tag and parsed a second time.

Decoding is one pass, not recursive: a value that still looks like `&amp;` afterward is literal
document data, and regression coverage must keep zero, one and two decodes observably different.

## Block placement and MDX ingress

`parseBlockAst` wraps any inline answer in a paragraph, for every codec, because an `html` node
does not say whether a picture is inline or a whole block. `imageCodec` is hoisted above the JSX
codecs in the MDX block chain for the same reason `tableCodec` is: otherwise the raw tag reaches
`jsx_leaf` as an unregistered component. MDX ingress preserves `<img>` unescaped alongside
PascalCase components (`escape.ts`); encoding it turns every resized picture into literal text.
