# contracts/branches — branch review wire DTOs

This directory owns review wire vocabulary. `branchId` names the Work's pending
file tree, `itemKey` names one document review, and `commandId` names one writer
action. A draft is one document's pending version; addressed metadata supplies its stable
`draftId`, which text Apply captures so it cannot target a replacement room.

- Rows carry `contextLocation: { scheme, path } | null`; preserve the scheme
  and the leading slash in the path.
- `reviewRoomName` is an opaque, stable transport address, not an
  application identity.
- The list contains current reviewable work only; completed review is not a
  durable draft-list receipt.
- The server maps an `itemKey` to its current document draft; text Apply instead
  binds the captured `draftId` to its Work and document and never retargets it.
- Apply is a frozen snapshot click with a command-id outcome, never a revision
  fence. Text groups and attribution come from the diff kernel in the room,
  not a server preview or closure-class contract.
- Apply and discard remain writer commands, not draft-storage operations.

See [`.context/CONTEXT.md`](.context/CONTEXT.md) for identity and command contracts.
