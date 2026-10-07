# drafts contracts — current branch-review contract

The review wire shape is intentionally JSON-natural and UI-oriented:

- List rows describe reviewable Work draft cards.
- Preview responses include required `draftId`, generation-fenced
  `reviewRoomName`, live markdown, branch markdown, review operations, and
  hunks. Agent operations carry `actorThreadId` and `actorThreadTitle` (the
  chat title at preview time); writer operations carry neither.
- Apply and whole-branch Discard requests address only `draftId`. Apply settles
  the whole current Work draft; preview operation ids and revision tokens are
  not part of the Apply request. Selective Discard adds operation ids, and the
  server maps them through its required `closureClassId`.
- Successful per-change Apply and Discard responses add `draftClosed`. When
  true, `draftDisposition` names the settled review (`applied` if any content
  reached live, otherwise `discarded`). No client-side operation-count guess
  is needed to decide whether the server closed the review. Whole Apply remains
  unfenced and unchanged.
- Trail evidence and peer marks are read-only; reversal lives in turn-receipt
  Undo/Redo.

The contracts do not expose durable storage identities or names. The Work-draft
domain maps `draftId` to `document_branches` and owns
`branch_write_journal`/`push_lineage` integration.

Selective Discard must send `liveRevisionToken` and `draftRevisionToken` from the
preview alongside `operationIds`. Missing/changed tokens return `stale`; refresh
instead of reporting success or closing the review. Whole-document Discard omits
these tokens and remains unfenced.
