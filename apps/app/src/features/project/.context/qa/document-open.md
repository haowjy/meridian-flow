# Document open: commit first

This browser recipe checks that a document door commits its destination before
content acquisition, and that the installed destination owns the one content
open. Run it on an owned mock stack with a fresh database and a named
`agent-browser` session.

## Setup

1. Seed a project with short, long, and very long chapters, more than 100 tree
   entries, and a chat with a long transcript. Open a chapter once when a mounted
   document is needed.
2. For phone runs, use CDP touch emulation as well as a 390 by 844 viewport.
   Assert `matchMedia(PHONE_SHELL_QUERY).matches`, the **Open navigation** phone
   control, and the phone's `DocumentHost` after opening a document.

## Destinations and ownership

1. Open a chapter this browser has never opened, a chapter made later in another
   tab, and a mounted document (main's, the side's or kept). The URL and main's header change on acceptance. A door that
   already renders the row commits without waiting; an id-only door waits for the
   project's list only while it has not been read, then paints the document's room. No
   separate availability request or POST is made.
2. From a chat in main, open a document door and a Recent row. Main goes to
   the document at once, the chat moves to the side and stays mounted, then
   content paints. Repeat during a long paced mock reply with reasoning: the
   reply keeps streaming in the side.
3. From the phone drawer, open a chapter. The drawer closes on commitment.
   Block live sync and confirm the phone destination shows the failure and
   Retry. Unblock it and Retry; the chapter opens.
4. Block live sync on desktop, in main and in the side. The destination
   stays committed and shows **Couldn't open this document.** Retry starts a new
   open. Revoke access instead: the access sentence appears with no Retry.
5. Load a row, delete its document before the list delivers the removal, then
   click the stale row. In main, in the side, and on the
   phone, it ends the presentation and reports the removal exactly as a document
   deleted while already painted.

## Ordering and identity

1. Click five rows within one second. Main shows the last, and Back visits
   the accepted ones in order. Delay an unknown chat-link lookup,
   then click a known row; only the known row commits. Repeat with two clicks in
   a dirty leave guard and with Back during the delayed lookup.
2. With a dirty rename field, click another row. The prompt appears from that
   click. Cancel leaves the address and main unchanged. Discard commits the
   requested destination.
3. Open a search passage for documents the list holds, including while offline. When the
   document is mounted in the side or kept, the door opens it in main without
   remounting it. Rapid A then B land only B.
4. Follow an unknown-ID link created by the current mock reply before the
   project's list holds it. Cancel prevents commitment. Opening the same document
   again once the list has it shows it, and shows it once. Replace the side's
   document before its first host renders and confirm the replacement cannot
   consume the old answer.
5. Reload offline with a route to a document this tab has opened before. It waits for
   the project's list and paints from the browser's local copy. A row click during cold hydration
   commits without waiting again. A chat link to a document the list holds
   during hydration admits it once.

## Keystrokes

Delay destination binding enough to see the paint hold. Type immediately after
(a) a tree-row click, (b) an in-editor link click, and (c) New. Repeat with IME
composition and with a dirty leave guard that is cancelled. Record the focused
node and both documents after every key. No character may reach the document
being left. The held pane deliberately blocks input, so keys during its hold do
not land in either document; a cancelled guard keeps typing in the current
editor.

## Download naming

Download prose documents named `Ending`, `part.one`, and `龙脉终章`, plus a non-prose
document. The prose downloads are `Ending.md`, `part.one.md`, and `龙脉终章.md`;
the non-prose download keeps its stored name. Inspect `Content-Disposition` for
the ASCII fallback and UTF-8 filename, and confirm binary downloads return the
stored bytes.
