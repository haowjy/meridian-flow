# contracts/branches — branch review wire DTOs

This directory owns review wire vocabulary. `branchId` names the Work's pending
file tree, `itemKey` names one document review, and `commandId` names one writer
action. A draft is one document's pending version; its storage ID stays behind
the server boundary.

- Rows carry `contextLocation: { scheme, path } | null`; preserve the scheme
  and the leading slash in the path.
- `reviewRoomName` is an opaque, stable transport address, not an
  application identity.
- The list contains current reviewable work only; completed review is not a
  durable draft-list receipt.
- Keep storage identities behind the DTOs; the server maps an `itemKey` to its
  document draft and owns draft integration.
- Apply is a frozen snapshot click with a command-id outcome, never a revision
  fence. Preview and persisted settlement results retain their older vocabulary
  until those paths are retired.
- Apply and discard remain writer commands, not draft-storage operations.

See [`.context/CONTEXT.md`](.context/CONTEXT.md) for command, preview, and
closure contracts.
