# drafts contracts — current branch-review contract

The review wire shape is intentionally JSON-natural and UI-oriented:

- List rows describe reviewable Work draft cards.
- Preview responses include required `draftId`, generation-fenced
  `reviewRoomName`, live markdown, branch markdown, review operations, and
  hunks. Agent operations carry `actorThreadId` and `actorThreadTitle` (the
  chat title at preview time); writer operations carry neither.
- Whole-document Apply and whole-branch Discard requests address only
  `draftId`. Whole Apply settles the whole current Work draft; preview operation
  ids and revision tokens are not part of its request.
- Per-change Apply (`DraftApplyChangesRequest`, the `draft/apply-changes`
  route) sends every operation id of the selected `closureClassId`s plus the
  preview's opaque `liveRevisionToken` and `draftRevisionToken`. It answers
  `applied` with the applied `operationIds` and `closureClassIds`, or `stale`,
  `gone`, `draft_only` (new document) or `incomplete_class`, all as HTTP 200.
  Selective Discard sends operation ids and the same tokens; the server expands
  each id to its class.
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

Incomplete attribution retains an explicit `unclassified: true` hunk; empty
`operationIds` means there is no attributable author, not no difference. Render
its complete removal or insertion (text insertions supply `insertedText` as a
fallback). Do not invent an author. `canApplyOrDiscard: false` disables actions
for every operation of a class touching that hunk; absence means eligible under
the ordinary class rules. Such effects need document-level Apply/Discard.
