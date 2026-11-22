# Editor — TODO

## Detached status

An authorized editable session that stays `detached` without adoption failure is
not surfaced by `SyncStatus.tsx`. Add an honest signal without flashing offline
during a healthy cold load.

## Draft review

Preserve cursor and selection across live and review remounts; scroll restoration
is best effort.

## Lists and screen readers

List markers are generated content on flat sibling blocks, with `aria-level` on each listed
block; there is no `role="list"` parent. What VoiceOver and NVDA announce is untested. If
they do not read a list, the fallback is a visually hidden text marker in a widget
decoration (flat model design, section 7).

## Two views of one session

- Concurrent image uploads from two views can overwrite each other's token list.
  Combine contributions at the session boundary if the product requires them.
- Both views share the session's one undo stack (`DocumentSession.history`), so Ctrl+Z in
  either view reverts the writer's last edit in the document, whichever view made it.

## Left for phase 1e (Loro)

- The Loro room socket has no `./mf` wire tap; the old Yjs inspector read Yjs frames.
- Old `meridian:document:` y-indexeddb copies stay in browsers; nothing reads or deletes them.
- `tab-change-counts` has no publisher while drafts are off.
- `RoomError` `server-error` (1b) rejoins.

## Undo of dependent steps

Ctrl+Z twice can bring text back twice. Press Enter in a paragraph, Backspace to join it back,
paste into it (each its own step), then Ctrl+Z twice: the paste goes, then the paragraph's end
shows both still joined and as its own paragraph again. Bold, then unbold, then Ctrl+Z twice
leaves the text bold.

The cause is the Undo rule (design §2, §6, `invertChange`). An inverse is the diff from a
change's `after` back to its `before`, computed on a fork at `after` and imported as concurrent
ops. Text an inverse puts back is new characters, so an earlier step's inverse, which names the
characters its change wrote, no longer finds them (the join's copied tail, which the paste moved
and the paste's inverse rewrote); and two inverses of one range merge as concurrent edits (the
bold). Within one step a doc's consecutive changes are merged (`extend` in
`editor-history.ts`), so a quick burst no longer hits it. A fix inverts against the document as it
is now: positional inverses carried through the edits made since, as Loro's `UndoManager` keeps
them, instead of inverses by character id at the change's own frontier.

The same rule makes Ctrl+Z of a 20-paragraph paste cost about 50 ms at 500 paragraphs: it forks
every doc the step changed (21 here), where the binding's own read of the result is a few
milliseconds.

## What an Enter or a mark toggle costs outside the binding

The binding's part of a structural edit no longer grows with the chapter (under 4 ms at 800
blocks in node). In the dev build an Enter still takes about 20–25 ms to the DOM and a mark toggle
about 18 ms, at 150 and at 500 paragraphs alike. A mark toggle's profile: about 3 ms in
ProseMirror's dispatch, about 16 ms in a synchronous render of `DocumentToolbar`, most of it
React's dev-build component timing (`startProfilerTimer`). An Enter adds about 2 ms in
`fixBlockIds` (`extensions/block-id/`), which maps every block of the old document through the
transaction and so grows with it, and about 7 ms of native layout when ProseMirror puts the
selection into the DOM. Measure a production build before changing any of them; the fixer could
look only at blocks that are not the same node in both documents, as the binding does.

## Composition undo grouping

Delayed IME composition can create separate undo entries for provisional and
committed text: `ni` → `你`, with more than 500ms between updates, undoes first to
`ni`, then to the original text. This occurs in ordinary prose as well as beside
objects. Group the composition as one user action rather than depending on
capture timing.

## Whole-table selection extent

A whole-table CellSelection has two different extents: its cells cover a rectangle, while
its native `$anchor`/`$head` cover only the head cell. A table that ends the document
therefore narrows to its head-cell text on Shift+PageDown or Ctrl+Shift+Right when
the browser makes no move after native range preparation. No text changes. The native range does not describe the selected cell rectangle. Do not add per-key boundary guards. A proposal to
separate whole-table NodeSelection from cell ranges changes what writers select
and what typing replaces; take that design to the product lead for review first.

## Upstream projection hook

The owner will submit the prepared `selectionForDOM` proposal linked from the
[patch contract](CONTEXT.md#interaction-mechanics-and-recovery) to ProseMirror's
replacement tracker. Both GitHub trackers are archived; filing is blocked on a
tracker account. The proposal is not an upstream issue or an endorsement. Keep
this task until the submitted issue is linked from that contract.
