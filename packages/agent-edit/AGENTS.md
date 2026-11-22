# @meridian/agent-edit

Editing core for the model's document `read` and `write`,
write handles and the receipts their Undo reads. Two cores live side by side while the
Loro move lands: the Yjs core (`createWriteCore`, what the server and browser run today) and
the Loro core (`createLoroEditCore`, design §5), which replaces it when the server's host moves
onto `DocumentRooms`. A change to shared code (`apply/`, `content-merge/`, the ports) must keep
both building; don't extend the Yjs-only files (`frontier.ts`, `yjs-mutation.ts`, `undo/`) with
anything the Loro core would need: see [the Loro core](.context/CONTEXT.md#the-loro-core). A write commits at its tool call; the host
runs it as one command. Hosts supply
the journal, coordinator, lifecycle, link and model ports; this package owns no
Postgres, routes, auth or Project/Work concepts.

- Hold no document, cache or LRU between calls. Every call reads the room fresh
  through `DocumentCoordinator.readRoom`, and a reply's accepted mutations live
  in the `ReplyMutations` the host's reply owns.
- Every write lands through `prepareSave`, inside the host's command. Durability
  comes from the host's commit, never from what reached a room: a live room hears
  of a save only after it.
- Reporting is best-effort and never changes what a save keeps.
- Attribution comes from the host per interaction, never from session-lifetime
  snapshots.
- `./diff` and `./yjs-mutation` load in the browser and import no host code;
  `./yjs-mutation` imports only Yjs, not the package barrel or the undo engine.

Contracts and architecture: [.context/CONTEXT.md](.context/CONTEXT.md).
