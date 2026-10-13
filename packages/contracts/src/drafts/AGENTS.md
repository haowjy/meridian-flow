# contracts/drafts — Work-draft review wire DTOs

`draftId` is the only product identity for preview, Apply, and Discard. The
server translates it to branch infrastructure inside the Work-draft domain;
wire DTOs must not expose `branchId`. `reviewRoomName` is an opaque,
generation-fenced transport address, not another application identity.

Each row carries its document URI's `contextLocation: { scheme, path } | null`
(with a leading slash on the path), not a manuscript-only path.

The list contains current reviewable work only; completed review is not retained
as a draft-list receipt.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
