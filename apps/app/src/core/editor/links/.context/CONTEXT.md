# Link system contracts

## Gestures

Click follows (external in a new tab with `noopener,noreferrer`, internal in the
same pane through the registered navigator). Middle or Ctrl/Cmd+click follows in a
new tab. Alt+click, Shift+click, or a press that travelled 4px or more places the
caret. A click with no navigator, or on an unclassifiable href, places the caret.
Enter or Alt+Enter on a followable link follows. Ctrl+K opens the form, and the
context-menu key or Shift+F10 opens the link menu without navigating.

Every follow cancels native navigation on `click` and `auxclick` alike (middle click
is the path where a raw href would reach the browser's own resolution) and puts the
selection back where the press found it. A press before the answer arrives still
follows.

`MeridianLink` configures TipTap against the classifier because TipTap's stock
allow-list drops `manuscript://` on parse and its autolink would rewrite
`chapter-213.md` into an external `.md` site.

## Assigning refs

Producers assign a stored link's `ref` without parsing or the network: `@` rows
write `doc:<id>` or a minted ahead ref; Ctrl+K and menu edits assign a picked
document's ref, else assign fresh against the local index (an unchanged destination
keeps its attrs); any paste lacking a ref is assigned once in `transformPasted`,
links and picture sources alike. A missing or incomplete index is safe because an
ahead ref minted for an occupied address settles on its occupant server-side.

A link surface that outlives a keystroke holds a `LinkAnchor` and re-reads the mark
by attributes, so a link replaced or retargeted by a peer closes the surface rather
than re-aiming it.

## Folder links

Following a folder link, by press, Enter or the menu's Open, goes through
`followLinkFrom`: with a navigator registered it sets the surface's `folder` request
instead of navigating, and the app draws the menu there. A folder link with no folder
answer follows like any address.

## Chips for stored files

A dropped file is a plain Markdown link with a `doc:` ref, minted by the client before
the file exists. What the chip says is drawn, never stored (`link-chip.ts`'s
`linkChipDetail`, `link-mark-view.ts`):

- The uploader's own tab reads the upload store (`core/uploads/upload-store.ts`), keyed by
  the id the ref names: progress, and a failure. The store is module-wide, so an upload
  outlives the editor that started it, and it owns the take-back rule for every upload chip
  and picture slot (its header). `file-drop/FileDropExtension.ts` only reports which `doc:`
  ids the text still links to.
- Another tab hears the upload over presence (`upload-presence.ts`), which reports it into
  the same store, and draws "Uploading" from there. The server knows nothing of a send in
  progress: it answers `gone` for a ref that names nothing yet. So the answer cache's `read`
  says nothing for a `doc:` ref while `uploads.of` has an upload for it, and every reader (the
  chip, the hint, the menu, a click) waits on the upload instead of calling the file gone. A chip copied into another document, or seen after
  the sending tab closed, reads gone until the file lands.
- A document answer carries `file` (type, MIME type, size) for a stored file, from the
  resolve route. The local index knows type and MIME but not size, so a stored file's chip
  asks the server once. The detail row is `PDF · 2.4 MB`; a picture's chip carries none.
- A chip named like a host (`notes.zip`, `a.io`) must not be rewritten into a website:
  placement sets `preventAutolink` and no `uiEvent: "drop"` (TipTap's paste rules read that
  as an outside drop and linkify the range).
