# Document open: commit first

This browser recipe checks that a document door commits its destination before
content acquisition, and that the installed destination owns the one content
open. Run it on an owned mock stack with a fresh database and a named
`agent-browser` session.

## Setup and measurements

1. Seed a project with 250-word, 5,000-word, and 30,000-word chapters, more than
   100 catalog entries, and a chat with a long transcript. Open every chapter
   once when an exact-local case is needed.
2. Before each click, install uncapped browser probes for `fetch`,
   `IDBDatabase.transaction`, `longtask`, and `long-animation-frame`. Record the
   transaction stack. Record click to URL, destination host, and visible content
   separately. Run every timed case at least three times and report host load.
3. For phone runs, use CDP touch emulation as well as a 390 by 844 viewport.
   Assert `matchMedia(PHONE_SHELL_QUERY).matches`, the **Open navigation** phone
   control, and `MobileDocumentHost` after opening a document.

## Destinations and ownership

1. Open an unmounted exact-local chapter, a cold server-only chapter, and a
   mounted tab. The URL, tab, or dock header changes on acceptance. Exact-local
   paint makes no availability request. A cold open makes one availability
   POST. Attribute every metadata transaction to its caller.
2. From Chat, open a document door and a Recent row into the dock. The chat
   stays visible while the dock header commits, then content paints. Repeat
   during a long paced mock reply with reasoning and keep the transaction probe
   uncapped.
3. From the phone drawer, open a chapter. The drawer closes on commitment.
   Block availability and confirm the phone destination shows the failure and
   Retry. Unblock it and Retry; a new POST opens the chapter.
4. Block availability or live sync on desktop and in the dock. The destination
   stays committed and shows **Couldn't open this document.** Retry starts a new
   request. Revoke access instead: the access sentence appears with no Retry.
5. Load a row, delete its document without delivering the catalog wake, then
   click the stale row. In the Editor with and without a neighbouring tab, the
   dock, and the phone, it closes and reports the removal exactly as a document
   deleted while already painted.

## Ordering and identity

1. Click five rows within one second. The last is visible, all accepted Editor
   tabs remain, and Back visits them in order. Delay an unknown chat-link lookup,
   then click a known row; only the known row commits. Repeat with two clicks in
   a dirty leave guard and with Back during the delayed lookup.
2. With a dirty rename field, click another row. The prompt appears from that
   click. Cancel leaves the address and tabs unchanged. Discard commits the
   requested destination.
3. Open a search passage and a change-trail receipt for server-only and
   exact-local documents, including exact-local while offline. When the same
   document is mounted in Editor and dock, each door lands in the container it
   committed. Rapid A then B land only B.
4. Follow an unknown-ID link created by the current mock reply before the
   catalog wake. Cancel prevents commitment. A later open makes a fresh POST.
   An accepted open makes one POST total, including during focus or online
   rechecks. If local probing wins after the lookup, opening the same document
   in another container makes its own request. Replace a dock slot before its
   first host renders and confirm the replacement cannot consume the old answer.
5. Reload offline with an exact-local route. It waits for the initial resource
   projection and paints locally. A catalog-row click during cold hydration
   commits without availability. A chat link to a never-opened catalog document
   during hydration makes one POST and one admission.

## Keystrokes

Delay destination binding enough to see the paint hold. Type immediately after
(a) a tree-row click, (b) an in-editor link click, and (c) New. Repeat with IME
composition and with a dirty leave guard that is cancelled. Record the focused
node and both documents after every key. No character may reach the document
being left. The held pane deliberately blocks input, so keys during its hold do
not land in either document; a cancelled guard keeps typing in the current
editor.
