# drafts contracts — current branch-review contract

The review wire shape is intentionally JSON-natural and UI-oriented:

- List rows describe reviewable Work draft cards.
- Preview responses include `branchId`, generation-fenced `reviewRoomName`, live
  markdown, branch markdown, review operations, and hunks.
- Accept/reject requests may address `branchId`; branch rooms are the only Yjs
  review rooms.
- Undo/reactivation and overlap/cannot-place protocols are deleted.

The contracts do not expose durable storage names. Server code maps these DTOs
to `document_branches`, `branch_write_journal`, and `push_lineage`.
