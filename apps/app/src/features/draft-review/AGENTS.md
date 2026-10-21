# features/draft-review — text-derived review

The draft room's `review_base` and `prosemirror` fragments decide the review.
One kernel `ReviewGroup.id` is one change within its projection everywhere:
rows, counts, focus, stepper, chat dock and editor paint. Focus retains the
projection with the id and invalidates when the projection changes. Attribution adds names and membership;
it never partitions the text.

## Ownership

- The room runtime owns projection. The account command owner supplies its
  cached optimistic base and freezes each Apply at the click, one FIFO per
  stable draft id. Never hide ids, translate selections or recut at dispatch.
- Text Discard is one local transaction. Its caller owns history: editor
  Ctrl+Z, or a pool-held surface notice with its own UndoManager. A dock
  Discard never enters editor history. Dock/Work rows and their notice paint
  before the indivisible write-back; the temporary list overlay never changes
  the room's text-derived frame. Ending notice history never flushes a pending
  write into the click handler. Notice history ends on Undo, the next action,
  leaving the surface or retiring the session binding that owns it.
- Room readers retain the rooms on screen, even without an editor. Cached
  text may paint before first sync, but a row is ready only after sync.
- The editor extension is a passive painter. Every frame addresses the actual
  mounted document. A stale frame is mapped while the next projection waits,
  never installed onto unequal prose from another binding.
- The review controller owns selected document, group focus and chrome, not
  room lifetime, command delivery or collaborative history. Empty review means
  no differences, not a server close. Local Discard must not navigate to live.
- Work and chat commands keep their creation-bound Work authority. Sharing a
  projection never borrows Editor command authority. Archived Works remain
  read-only; another draft's command must not lock this one.
- Paint has two colours: removed base text is red, inserted draft text green,
  including writer edits and formatting. Removal widgets are not manuscript
  content. Byline overlays never split a box.
- Unknown attribution is not known-empty membership: show the text without a
  byline until classification arrives. Do not erase the dock while loading it.
- Components own layout, receive command callbacks, and keep attribution and controls
  on one line; locked rows offer no disposition controls. `PaintHold` owns pane
  continuity; feedback never displaces prose.
- A draft's failure shows once per surface: the focused change's bar while it
  shows, else the identity row's notices (`useReviewFailures`); a file's status
  line (`DraftCommandStatus`) in Work Files and the dock, never its rows. The
  in-flow bar puts it in its own row. Archived-Work refusals hold no failure.
  The displacement still left ([#992](https://github.com/haowjy/meridian-flow/issues/992))
  waits for one feedback surface outside the manuscript; don't add per-width fixes.

Read [the runtime reference](.context/draft-review.md) before changing ownership.
Browser verification recipes live in [draft review QA](../../../../../docs/qa/draft-review.md).
