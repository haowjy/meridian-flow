# contracts/drafts — Work-draft review wire DTOs

This directory owns the review wire vocabulary. `draftId` names the active
Work draft, `itemKey` names one document review, `commandId` names one writer
action, and a text branch never crosses the wire.

- Rows carry `contextLocation: { scheme, path } | null`; preserve the scheme
  and the leading slash in the path.
- `reviewRoomName` is an opaque, generation-fenced transport address, not an
  application identity.
- The list contains current reviewable work only; completed review is not a
  durable draft-list receipt.
- Keep storage identities behind the DTOs; the server maps an `itemKey` to its
  branch and owns branch integration.
- Preview and command responses preserve explicit stale, gone, held, and
  incomplete outcomes so clients do not infer closure from operation counts.
- Apply and discard remain writer commands, not branch-storage operations.

See [`.context/CONTEXT.md`](.context/CONTEXT.md) for command, preview, and
closure contracts.
