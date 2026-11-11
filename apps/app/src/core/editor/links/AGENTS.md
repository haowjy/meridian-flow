# core/editor/links — headless link policy

Classifies, follows, renders and assigns standard Markdown links
([link identity][link-identity], [following a link][link-following],
[link chips][link-chips]). It doesn't render React or own navigation.

- `classifyLinkTarget` is the one answer for Context URI, relative path and external
  URL. A new spelling goes there and nowhere else. It is also the security fence: an
  href outside both families is `null`, meaning no hint, follow, Open verb or rendered
  destination. `MeridianLink` asks on parse, command and render, because the Markdown
  parser is a third door into the document.
- Don't navigate from a browser event or let TipTap's link extension do so. The
  editor click seam prevents native navigation and places the caret when follow isn't
  chosen.
- Link and picture views are the only resolution askers: each mounted view watches
  its key and releases it on destruction, so a page of links is one batch. No document
  scan and no answer-only transaction.
- Every href is spelled through `storedHref` with the address's `kind`, so a folder
  keeps its trailing `/`.

Gestures, ref assignment and folder follow:
[`.context/CONTEXT.md`](.context/CONTEXT.md).

[link-identity]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/documents/links.md#stored-identity-and-spelling
[link-following]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/documents/links.md#following-a-link-is-one-procedure
[link-chips]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/documents/links.md
