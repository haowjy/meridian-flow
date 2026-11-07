# Stable draft identity and terminal closes

Run the PostgreSQL/Hocuspocus seam probes:

```sh
pnpm exec tsx tools/qa/probes/draft-generations/run.mts
pnpm exec tsx tools/qa/probes/drafts-lock-free/run.mts cold-load-commit read-only-handshake
```

The first runner creates and drops its scratch database. It checks that live
restore changes only live authority, a fresh server reopens the same draft room
with committed text, and Discard all sends `4205 discarded` only after its root
transaction commits. The second runner checks missing-prefix `4207` resync and
load/read-only handshake repair.

Against a running dev stack, seed an existing-document draft in a scratch Work,
then run this probe. It discards that Work's entire branch:

```sh
pnpm exec tsx tools/qa/probes/draft-generations/live.mts <workId> <documentId> --restart
```

The probe opens an authenticated provider socket, restarts the mock stack,
confirms the same room and text resync, then sends Discard all and observes
native WebSocket `4205 discarded`. Use an existing document: a hidden creation
can be removed and correctly closes with `4208 document-deleted`.

## Writer verification

1. In one Work, ask the mock model to edit an existing manuscript document.
2. Open its draft review in two browser tabs and record its `draft:<draftId>`
   room.
3. Discard all in the first tab. The other tab receives terminal `4205
   discarded`, leaves the draft, and does not reconnect. The initiating tab
   shows no refusal.
4. Restart the dev server through `pnpm dev:restart`. The tab reconnects to the
   same room and retains acknowledged text. For missing-prefix `4207`, the next
   SyncStep2 uploads the withheld prefix instead of treating it as terminal.
5. Restore a live checkpoint while the draft remains open. Live authority moves;
   the draft id and room do not.

Removal is different: both live and draft rooms receive `4208 document-deleted`
and the client reads the removal record from availability. Work access changes
remain nonterminal.
