# drafts contracts — current branch-review contract

The review wire shape is intentionally JSON-natural and UI-oriented:

- List rows describe reviewable Work draft cards.
- Preview responses include required `draftId`, generation-fenced
  `reviewRoomName`, live markdown, branch markdown, review operations, and
  hunks.
- Apply and whole-branch Discard requests address only `draftId`. Apply settles
  the whole current Work draft; preview operation ids and revision tokens are
  not part of the Apply request. Selective Discard adds operation ids, and the
  server maps them through its required `closureClassId`.
- Trail evidence and peer marks are read-only; reversal lives in turn-receipt
  Undo/Redo.

The contracts do not expose durable storage identities or names. The Work-draft
domain maps `draftId` to `document_branches` and owns
`branch_write_journal`/`push_lineage` integration.
