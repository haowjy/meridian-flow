# @meridian/agent-edit

Editing core for the model's document `read` and `write`, write handles and the receipts their
Undo reads: `createEditCore` (design §5) on the host's `DocumentRooms`. A write commits at its
tool call; the host runs it as one command. Hosts supply the rooms, write ordinals, document
edits and link ports; this package owns no Postgres, routes, auth or Project/Work concepts.

- Hold no document, cache or LRU between calls. Every call reads the room fresh through
  `AgentEditRooms.readRoom` and frees that copy at the call's end; a reply's accepted mutations
  live in the `ReplyMutations` the host's reply owns.
- Every write lands through `AgentEditRooms.save`, inside the host's command: the batch and its
  `AgentWriteRecord` commit together. Durability comes from the host's commit, never from what
  reached a room.
- Reporting is best-effort and never changes what a save keeps.
- Attribution comes from the host per interaction, never from session-lifetime snapshots.
- `./diff` loads in the browser and imports no host code.

Contracts and architecture: [.context/CONTEXT.md](.context/CONTEXT.md).
