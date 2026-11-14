# features/import

Upload first: the browser lists paths, sizes and modified times, uploads bytes, then a
durable server job organizes and reveals everything atomically. Nothing but one pending
folder root exists in the tree before reveal; documents are born complete.

- `ImportsProvider` at the authenticated root owns one account-lifetime coordinator;
  project `ImportProvider` owns only pick/drop doors. Navigation never stops an upload.
- The open list is server truth. BroadcastChannel only nudges a refresh. No import state
  enters the tree list.
- File handles are private and ephemeral. Starting an upload never hashes or sniffs files.
- "This tab is working" is one predicate, `UploadPresence.working`, backed by the Web Lock
  `import-upload:<id>`. It drives the lock and `beforeunload` alike. Don't use a timer
  heartbeat: background tabs throttle timers.
- The browser mints the import id before reading, and every create replay uses it. Creation
  knowledge (`local`, `uncertain`, `created`), not the displayed phase, decides what
  dismissal can do; Stop replays an uncertain create before cancelling.
- Response revisions and upload attempts fence late answers. Polling never overwrites an
  in-flight command or clears its error, and progress never regresses on an old response.
- Pending roots have no URI or document capabilities: activating one opens its popup, never
  an editor. The tree's identity wins over `root.created` for liveness.
- Copy goes through Lingui and `reason-copy.ts`; server codes are not sentences.

Mechanisms (attempts, Continue matching, hash reports, Stop and finish rules, pending-root
projection): [`.context/CONTEXT.md`](.context/CONTEXT.md). Deferred coverage:
[TODO](.context/TODO.md). Runtime recipe: [QA](../../../../../docs/qa/README.md#import).
