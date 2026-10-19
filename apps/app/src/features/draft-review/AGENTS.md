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
  Discard never enters editor history. Notice history ends on Undo, the next
  action or leaving the surface.
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
- Components own layout, receive command callbacks, and keep chrome and rows
  one line. `PaintHold` owns pane continuity; feedback never displaces prose.

Read [the runtime reference](.context/draft-review.md) before changing ownership.
Browser verification recipes live in [draft review QA](../../../../../docs/qa/draft-review.md).
