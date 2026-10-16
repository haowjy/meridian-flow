# contracts/drafts — Work-draft review wire DTOs

This directory owns the review wire vocabulary. `draftId` names the active
Work draft, `itemKey` names one document review, `commandId` names one writer
action, and a text branch never crosses the wire.

- Rows carry `contextLocation: { scheme, path } | null`; preserve the scheme
  and the leading slash in the path.
- `roomName` is the opaque transport address of an item's text branch, returned
  by the server; clients never build or parse it.
- The list contains listed items only (created nodes, and edited items that have
  changes); completed review is not a durable draft-list receipt.
- Keep storage identities behind the DTOs; the server maps an `itemKey` to its
  branch and owns branch integration.
- There is no server preview: the browser projects the review from the draft
  room. Command responses preserve explicit stale, gone, held, and failed
  outcomes so clients do not infer closure from change counts.
- Apply and item or whole Discard remain writer commands. Discarding a change is
  a local edit, not a wire operation.

See [`.context/CONTEXT.md`](.context/CONTEXT.md) for command and item
contracts.
