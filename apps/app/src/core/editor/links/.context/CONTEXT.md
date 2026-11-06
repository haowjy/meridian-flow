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
