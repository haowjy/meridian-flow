# features/draft-review — text-derived review

The draft room's `review_base` and `prosemirror` fragments decide the review. One
kernel `ReviewGroup.id` is one change within its projection everywhere: rows, counts,
focus, stepper, side and paint. Attribution adds names and membership; it never
partitions the text.

- The room runtime owns projection. The account command owner supplies its cached
  optimistic base and freezes each Apply at the click. Hiding ids, translating
  selections or recutting at dispatch breaks that frozen click.
- Text Discard is one local transaction, one stack item. Its Undo belongs to the owner's
  notice (`DraftNotices`, one per draft owner, outliving surfaces); a band Discard's item is
  also on the reviewing editor's history, and either handle ends the other. A Discard in the
  side never enters editor history. Only a Discard with no Undo asks first (`canUndoDiscard`).
- Cached text may paint before first sync, but a row is ready only after sync.
- The editor extension is a passive painter. A stale frame is mapped while the next
  projection waits, never installed onto unequal prose from another binding.
- Empty review means no differences, not a server close, so a local Discard doesn't
  navigate to live.
- Work and chat commands keep their creation-bound Work authority; sharing a projection
  doesn't borrow Editor command authority.
- Unknown attribution isn't known-empty membership: show the text without a byline, and
  don't erase the side while it loads.
- A draft's failure shows once per surface: the focused change's bar while it shows, else
  the identity row's notices; a file's status line in Work Files and the side. Fix
  displacement with one feedback surface outside the manuscript, not per-width fixes
  ([TODO](.context/TODO.md)).

Read [the runtime reference](.context/draft-review.md) before changing ownership.
Browser recipes: [draft review QA](.context/qa/draft-review.md).
