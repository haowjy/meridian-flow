# Link system contracts

This page records the link classifier, live resolution, follow decision, and
clipboard seams. It keeps address syntax and resolution state separate.

## Classification and follow

`classifyLinkTarget(href)` returns `scheme`, `relative`, or `external`. Internal
targets are normalized to `{ ref, href }`; external URLs never cross the
resolver port. `linkClickIntent` answers whether a press follows or places the
caret and `followLink` delegates the resulting destination. A missing navigator
returns no follow intent and the menu omits Open.

Editor links have native navigation disabled. The click plugin prevents default
only while allowing ProseMirror's selection behavior. Link chips derive from
the target plus the latest answer: filled means a readable document/address;
dashed means nothing currently exists at that exact address or the named
document is gone. Pending and failed resolution remain distinct states.

Gestures: click follows (external in a new tab with `noopener,noreferrer`;
internal in the same pane through the registered navigator). Middle or
Ctrl/Cmd+click follows in a new tab. Alt+click, Shift+click, or a press that
travelled 4px or more places the caret and never follows. A click with no
navigator, or on an unclassifiable href, places the caret. Enter or Alt+Enter on
a followable link follows. Ctrl+K opens the form (display text and destination,
with Remove link when the caret is in a link), and the context-menu key or
Shift+F10 opens the link menu without navigating. Every follow cancels native
navigation on `click` and `auxclick` alike (middle click is the path where a raw
href would reach the browser's own resolution) and puts the selection back where
the press found it. A press on a link known to be gone places the caret; a
press before the answer arrives still follows.

A gone link draws dashed, with no hover, not followable, and an accessible
"No longer available" state (a missing one reads "Doesn't exist yet"). Pending,
failed, and not-yet-asked links draw filled in their own family, because a link
the editor could not ask about must never look like one that does not exist.
`gone` never falls back to the address. External targets get no chip. Core emits
chip attributes and never an image; the app owns the icon data. `MeridianLink`
must configure TipTap against the classifier, because TipTap's stock allow-list
drops `manuscript://` on parse and its autolink would rewrite `chapter-213.md`
into an external `.md` site.

Producers assign a stored link's `ref` without parsing or the network: `@` rows
write `doc:<id>` or a minted ahead ref; Ctrl+K and menu edits assign a picked
document's ref, else assign fresh against the local index (an unchanged
destination keeps its attrs); any paste lacking a ref is assigned once in
`transformPasted`, links and picture sources alike; a same-project rich paste
keeps the copied ref at its current address. A missing or incomplete index is
safe because an ahead ref minted for an occupied address settles on its occupant
server-side. A link surface that outlives a keystroke holds a `LinkAnchor` and
re-reads the mark by attributes, so a link replaced or retargeted by a peer
closes the surface rather than re-aiming it.

## Resolution generations

The cache is live and keyed by canonical target identity. Each registration
captures the current account, project, scope, and generation. Invalidation
advances the generation before publishing any replacement, aborts pending work,
and rejects late answers. A requester owns its subscription and must unsubscribe
on disposal. No resolution answer, label, or server capability is stored in the
link mark.

Local catalog answers win before network lookup. A cache miss may return
pending; a server not-found answer is absent only for the exact address. Create
is offered only for a missing-at-address outcome and must use that exact address,
then invalidate/re-resolve. It must not infer a folder or turn a failed request
into a create.

## Clipboard and paste

Rich clipboard metadata may keep a same-project document or asset ref only when
the sanitizer proves the ref. Otherwise the destination catalog assigns one
fresh ref/address in a single transform. Plain text remains plain text unless
the Editor's wikilink policy is active. The chat composer receives the complete
address and does not enter stored Markdown.

The Editor wikilink transform handles `[[target]]`, aliases, headings, block
anchors, and folders outside code or nested links. It preserves escaped brackets
and plain/code paste. Matching is case-insensitive and deterministic: holder
folder, holder area, then other areas by area, folder depth, and canonical URI.
Every match becomes a standard link; no match uses the same exact-address
link-ahead rule as `@`, with create refusal in areas that cannot host a document.

Pasted web images remain links until the image import lane successfully uploads
bytes. A failed import must leave the link and must not invent an asset entry.
