# Stable draft identity and terminal closes

Run the PostgreSQL/Hocuspocus seam probe:

```sh
pnpm exec tsx tools/qa/probes/draft-generations/run.mts
pnpm exec tsx tools/qa/probes/drafts-lock-free/run.mts cold-load-commit read-only-handshake
```

The first runner creates and drops its scratch database. It checks a live version
restore advances only live authority, reopens the same draft room on a fresh
server instance with its committed text, and runs Discard all while another
connection holds the draft. No close escapes before root commit; afterwards that
connection receives `4205` with `discarded` (`DRAFT_CLOSED`). The other runner
checks missing-prefix `4207` resync plus load and read-only handshake repair.
These are adapter probes, not a browser or an operating-system restart.

Against this checkout's running dev stack, seed an existing-document draft in a
scratch Work, then run (this **discards that Work's entire branch**):

```sh
pnpm exec tsx tools/qa/probes/draft-generations/live.mts <workId> <documentId> --restart
```

It opens an authenticated provider socket like another tab, restarts the actual
dev stack with the mock provider, confirms the same room and text resync, then
sends HTTP Discard all and observes its native WebSocket `4205 discarded`.
Use an existing document, not a hidden creation: Discard of the latter can
remove the document and correctly answers `4208` instead.

## Writer verification

1. In one Work, ask the mock model to edit an existing manuscript document.
2. Open its draft review in two browser tabs. Record its `draft:<draftId>` room.
3. Discard all in the first tab. The other tab receives terminal `4205` with
   `discarded`, leaves the draft, and does not reconnect to it. The action's own
   tab shows no refusal. B2 owns the review navigation and local-cache drop.
4. Repeat with a new draft. Restart the dev server through `pnpm dev:restart`;
   the tab reconnects to the same room and retains acknowledged text. For a
   missing-prefix `4207`, the next SyncStep2 uploads the withheld prefix rather
   than treating it as a terminal refusal.
5. Restore a live checkpoint while the draft remains open. Live authority moves;
   the draft id and room do not.

Removal is different: both live and draft rooms receive `4208 document-deleted`;
the client reads the removal record from availability. Work access changes remain
nonterminal. `4206` no longer exists.
