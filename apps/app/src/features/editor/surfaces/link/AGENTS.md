# surfaces/link

The app-facing link UI: completion, approach hint, form and follow outcomes. Link meaning
lives in `core/editor/links`, and following in `features/links`.

- A form target is identity-held, not a remembered DOM node or position.
- The link mark stores an address and ref. Resolution is live cache state and is never
  written into the document.
- The link menu acts on the range the pointer hit, not the caret's link: a writer
  right-clicks links paragraphs away from the caret. Only the clipboard rows may act on a
  passage already swept around the link.
- A verb that can't work is absent, not greyed. Copy is the exception: a withheld
  clipboard has to reach the writer, so it keeps the menu open until the write settles.
- Unresolved is a sentence, never a warning, and its look is the shared link chip, not a
  rule in this surface's stylesheet.
- There is one link form; the toolbar and formatting menu open it.

Catalog, follow and store contracts: [`.context/CONTEXT.md`](.context/CONTEXT.md).
