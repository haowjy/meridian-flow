# contracts/drafts — Work-draft review wire DTOs

`draftId` is the only product identity for preview, Apply, and Discard. The
server translates it to branch infrastructure inside the Work-draft domain;
wire DTOs must not expose `branchId`. `reviewRoomName` is an opaque,
generation-fenced transport address, not another application identity.

The list is active-only. Do not add lifecycle statuses such as `applying`,
`reactivating`, `applied`, `discarded`, or `closed`; completed review is not
retained as a draft-list receipt.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
