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
  side never enters editor history. Only a Discard of some changes is local: a whole draft's
  goes to the server, so Trash lists it, and its notice's Undo is the server's Undo of a
  Discard (`restoreDiscard`). No Discard asks first.
- Cached text may paint before first sync, but a row is ready only after sync.
- The editor extension is a passive painter. A stale frame is mapped while the next
  projection waits, never installed onto unequal prose from another binding.
- Empty review means no differences, not a server close, so a local Discard doesn't
  navigate to live.
- Work and chat commands keep their creation-bound Work authority; sharing a projection
  doesn't borrow Editor command authority.
- Unknown attribution isn't known-empty membership: show the text without a byline, and
  don't erase the side while it loads.
- A press that fails (Apply, Undo, Redo, Discard, Restore) is a brief pill (`notifyFailure`),
  never a line in the row or bar the writer pressed; a click the queue gives up on settles
  `unsent` and the change is pending again. A file's status line shows progress only.

- Suggestion mode (`VITE_FLOW_SUGGESTIONS`) keeps these surfaces and changes their source: a
  review's changes are the Work's suggestions in the host's Live editor (`useSuggestionRead`,
  `features/suggestion-review/`), not a draft room. Apply or Discard on one change is an editor
  transaction (Ctrl+Z); on a document, folder or Work it is a press (`usePressCommands`), whose
  Apply sits in each open editor's history (`ApplyEntries`). Its items never end
  (`askEnd`): a pressed row leaves the list and comes back if the press fails.

Read [the runtime reference](.context/draft-review.md) before changing ownership.
Browser recipes: [draft review QA](.context/qa/draft-review.md).
