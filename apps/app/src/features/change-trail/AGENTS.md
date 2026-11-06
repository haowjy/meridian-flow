# features/change-trail — shared trail evidence reads

Receipt rows and peer-mark popovers read Before/After evidence through this seam,
so the two hosts stay identical; a consumer with its own cache breaks that.
Evidence is read-only: receipt Undo/Redo is the only AI reversal.

- Settled evidence doesn't refetch on reopen; a shell-version bump or lost
  document access invalidates it.
- Prefetch while a mark is visible so disclosure doesn't fill after opening.
