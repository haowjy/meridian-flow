# Thread notes folders

Verify that chat-scoped notes remain ordinary, editable Scratch documents, with
stable addresses and title labels. `./mf` proves server/shared-client behavior;
the final browser steps prove the writer's experience.

## Setup

Use an owned checkout/database on the feature commit. Start `MODEL_PROVIDER=mock
pnpm dev`, then discover its HTTPS URLs with `pnpm portless:list`. Never borrow
another lane's mock queue. Keep command output and screenshots outside this repo.
Record the commit, provider, command, expected/actual outcome and evidence path
in the work item's verification log.

```bash
./mf project list --json
./mf api POST /api/projects/$PROJECT/works --data '{"name":"Notes probe"}' --json
./mf api POST /api/agents --data '{"slug":"notes-probe","content":"---\nname: Notes Probe\nmode: primary\nmodel: mock-llm-v1\n---\nFollow the writer."}' --json
./mf thread create --agent notes-probe --work @notes-probe --title 'Arc planning' --json
```

Save the project, Work, thread id and handle. In the following scripts substitute
only fixture identities; leave `$THREAD` and `$PARENT` literal (single-quote shell
arguments or use JSON files).

## Address and storage checks

1. **First model write.** Send with `--mock` a script whose first step calls
   `write` with `args: {command:"create",path:"scratch://$THREAD/plan",content:"Notes"}`,
   second step calls `ls` with `args: {path:"scratch://$THREAD/"}`, and final step
   says Done. Tool results must use `scratch://@notes-probe/@/cN/plan`, not the
   variable or the stored `@cN` basename. Read it through a fresh client:
   `./mf doc read 'scratch://$THREAD/plan' --chat cN --json`. Canonical and
   variable reads must have the same document identity and text.
2. **Read is non-mutating.** Read/list a valid, unused chat qualifier before its
   first write. Compare source/folder counts before and after: no allocation.
   Reject a foreign project, a thread without membership in the named Work,
   and a thread outside the named lineage; rejected input creates nothing.
3. **Allocation and rollback.** Race two first creates into different files in
   one chat folder; both succeed under one live associated root. Repeat with
   the same filename (one success and an ordinary conflict). Inject a failure
   after folder allocation inside the create transaction: neither new root
   nor file/catalog arrival survives. Retry succeeds. Also exercise first
   allocation by mkdir and by moving a document into the absent notes root.
4. **Fixed root, editable contents.** Through the HTTP move route, attempt to
   rename and move the associated root: `invalid_operation`, no changed path.
   Rename/move a child, move it out to owner-wide Scratch or manuscript and
   back; its document id and content remain unchanged. Delete the root by its
   folder identity, then write under the qualifier: a new live root appears.
5. **Lineage and rebind.** Create a No Work chat and fork it at a settled turn.
   Each writes `scratch://$THREAD/plan`: one lineage source, two associated
   folders and two document ids. `scratch://@/cN/x` remains owner-wide lineage
   syntax. Rebind a named-Work chat through `PUT /api/threads/$THREAD_ID/work`
   with `{workId:$OTHER_WORK}`: its next `$THREAD` uses the new Work, old
   canonical addresses remain readable, and no bytes move.
6. **Parent and artifacts.** Queue a child script matched to its spawn prompt:
   read `scratch://$PARENT/plan`, create `scratch://$THREAD/report`, and call
   `return_result` with `artifacts:["scratch://$THREAD/report"]`. Spawn it
   foreground with `overrides:{model:"mock-llm-v1"}`. The report and parent
   chip must contain the canonical p-handle address. Check a fork/handoff's
   `$PARENT` read against the acted-on source chat, not the owner of an
   inherited cutoff turn or its inherited spawn parent. Thread snapshots must
   not carry a notes location map. A root `$PARENT` fails naming the variable.
7. **Literal and invalid syntax.** `$5 bills` and an inner literal `$THREAD`
   folder round-trip. Unknown `$FOO` in the first URI segment, a variable
   without chat scope, extra qualifier chains, `@cN` writer names and
   `scratch://@notes-probe/@cN/x` fail. Wrong-scheme substitution also fails.
   Compare scoped parse results with parsing their canonical substitution.
8. **Links and history.** Give sibling chat folders the same filename with
   different text. Resolve both canonical links and a chat `$THREAD` syntax
   link through `/api/projects/$PROJECT/links/resolve`; identities must not
   alias. AI-written links in notes read back canonically even when the
   destination does not exist yet. Relative `x` stays inside the thread
   folder; explicit `scratch://x` stays owner-wide. An Editor holder with raw
   `$THREAD` gets no resolution, even if its request supplies a chat id.
9. **Retention and upgrade.** On an owned fixture, remove a chat identity while
   retaining its other Work's associated folder: canonical read/edit remains
   available and a fresh catalog uses the untitled-chat fallback. Confirm
   nullable `folders.thread_id`, no thread FK, validated root-only CHECK, and
   valid live partial indexes. Upgrade populated ordinary/deleted folders and
   documents without resets; compare counts, text and addresses before/after.
   Exercise interrupted concurrent-index migration recovery with the real runner.

## Review regression schedules

- **A root is never a file.** On a fresh chat, issue model
  `write create scratch://$THREAD/` and writer HTTP
  `POST context/scratch/create` with `{"type":"file","path":"@cN"}`.
  Both refuse a missing filename. Repeat through tracked ensure and binary
  dispatch. No document or root allocation occurs. Creating `@cN/plan` next
  succeeds. Folder mkdir, list, delete and move destinations still accept
  `@cN`.
- **Client identity and routing.** Put `plan` in owner-wide Scratch and two
  chat folders. In Editor, Ctrl+K to the second chat's canonical address,
  save, reload and read back: the stored link keeps that document identity.
  Paste `[[plan]]` beside it; it chooses the sibling, not the first catalog
  match. Recent-document navigation reopens that same source path.
- **Browser move into notes.** Make an owner-wide Scratch file. In Work Files,
  choose its Actions, Move, a title-labelled chat folder, then Move to that
  folder. The move must settle without an availability-location error.
  Read back under the canonical qualified URI; content and document id stay
  unchanged. Opening the moved note and reloading retains its route.
- **Move-refusal name.** Start moving an owner-root file into a title-labelled
  chat folder. Hold the outgoing real move request, create a same-named file at
  that destination from another client, then release. The real server must
  refuse the collision and leave the source unchanged. Reopen Move: both the
  destination heading and "Couldn't move to …" name the catalog folder title,
  never its reserved `@cN` basename.
- **Other folder-name surfaces.** Check the move-success note, move-picker trail,
  Files subtitles, Editor/dock ancestry, mobile Scratch breadcrumb and chat `ls`
  title/listing against the catalog display name. A masked Scratch destination
  omits unproved ancestry until its catalog-backed surface mounts. A listing
  root with no loaded catalog label names the Scratch area, never its handle.
- **Variable continuity after path reuse.** Show an AI a link to A at
  `scratch://@notes/@/c12/plan`; move A and create B at that path. Rewriting
  the link with either that canonical spelling or
  `scratch://$THREAD/plan#part` retains A and the written suffix. Stored
  occurrences and shown-address evidence contain no variable.
- **Click-time scope, including remote rebind.** Leave only a fork mounted.
  Rebind its unmounted parent from `./mf`, then click `$PARENT` once. The
  request sends the raw variable href and fork id, and opens the current
  owner's note without reload or a parent snapshot request. Rebind the parent
  back and click again: no cached variable answer may open the old note.
  Repeat own and parent rebind through the same browser. Hold a link resolve
  response: the click shows checking, then opens when released without another
  click; holding a snapshot must not hold the variable click. A root with no
  parent cannot resolve `$PARENT`; an Editor holder still cannot resolve it.
  Check `./mf doc read 'scratch://$PARENT/plan' --chat cN` follows the same
  raw-href server path, not a snapshot map. Check tool chips use canonical typed
  result paths after completion, and filename labels plus raw click-time
  resolution before a result exists.

- **CLI requested-address parity after a move.** Create A at a chat note,
  move A to an archive name, and compare canonical and `$THREAD` spellings
  of its vacated address with explicit `--chat`. `doc put`, with and without
  `--overwrite`, creates at the requested address, never at A’s new location.
  At an occupied requested address, plain put conflicts and overwrite replaces
  only that occupant. `doc rm` at the vacated address returns not found; after
  reuse it deletes only the new occupant. A remains intact at its moved address.
  Chat navigation still follows the vacated address to A.

- **Variable clicks across catalog generations.** Hold a variable resolve response,
  then replace its catalog generation while the click waits. The new generation
  must re-ask and open its replacement document; releasing the old answer must
  never open the retired document. Repeat with the follower unmounted while the
  request is held: release opens nothing. A later click always sends a new request;
  transcript scans send none. Compare with the same canonical-link schedule.

## Labels and targeted publication

Take a Work catalog snapshot and save its cursor. Rename a chat with
`PATCH /api/threads/$THREAD_ID/title`, then request catalog changes from the
cursor. Only that chat's and its direct subagents' associated roots get upserts;
there is no subtree invalidation or descendant re-publication. Stored `name`,
`path`, URI and document identities do not change. Rename the parent while a
subagent folder is mounted and verify both labels update. A missing/empty title
uses `Untitled chat`; a subagent uses its spawning parent's title plus `(subagent)`.

## Fork and handoff copies (Phase 3)

Creation commits the conversation and registers a tracked detached best-effort
copy. Creation, replay, the handoff brief and first turns never wait for copying. There is no notes-copy job, status UI or Retry.
An idempotent creation replay does not retry copying, even after failure.

Capture the source assistant turn id from
`./mf api GET /api/threads/$SOURCE/snapshot --json`. Use client-minted destination
UUIDs and retain each request body unchanged for replay:

```bash
./mf api POST /api/threads/$SOURCE/fork --data \
  '{"id":"<destination-uuid>","originTurnId":"<settled-assistant-turn>"}' --json
./mf api GET /api/agents --json # retain the selected primary Agent's full selection
./mf api POST /api/threads/$SOURCE/handoff --data \
  '{"id":"<destination-uuid>","originTurnId":"<settled-turn>","agentSelection":{"catalogEntryId":"<catalog-id>","definitionRevisionId":"<revision-id>"}}' --json
./mf doc read 'scratch://$THREAD/plan.md' --chat '<destination-id>' --json
./mf doc read 'scratch://$PARENT/plan.md' --chat '<destination-id>' --json
```

1. **Named Work.** Seed `plan.md`, `nested/scene.md` through model writes. Add
   an empty descendant with the ordinary context folder-create route, using
   `?workId=<work-id>` and `{type:"folder",path:"/@cN/empty"}`. This is a
   source-relative transport path, not a public URI. Fork and hand off. Each
   destination returns before copying finishes, then reads its own copy. Folder
   shape, empty descendants and persisted text filetypes survive. The seed
   names the canonical source folder where originals remain.
2. **No Work.** Repeat on a No Work source. A fork keeps the lineage source
   with a different associated root; a handoff owns a new lineage source.
   `$PARENT` names the old owner/chat and `$THREAD` the destination. The locked
   No Work row owns no Scratch source.
3. **Inherited cutoff.** Give a fork a unique note, then fork and hand it off
   at an inherited ancestor assistant turn. Both copy the acted-on fork's
   unique note, not only its ancestor's notes. Snapshot `notesScope.parent`
   and `derivationSourceThreadId` name the acted-on fork; transcript cutoff
   and inherited uploads still use their existing owner rules.
4. **Absent and empty roots.** Derive from a chat that has no notes root:
   no target root (or new No Work handoff source) is allocated. Write source
   notes later and replay the same creation body: still no copy. Separately
   create a present root containing only an empty child folder and derive it:
   the root and empty child are copied despite having no documents.
5. **Independent identity/history.** Compare source/destination document ids,
   authority clients and checkpoints in the owned database. Copies have new
   ids, a fresh initial checkpoint, no source journal updates, no source undo
   receipts or frontiers. `metadata.copiedFrom` names the source URI/live
   revision. `read` with `format:"edits"` starts empty. Read then overwrite
   a copied note through the model; the original stays unchanged. Edit the
   source and confirm the copy stays unchanged. Ordinary document `write copy`
   still stages/saves and reports its own receipt normally.
6. **Binary descendants.** Upload a binary, move it into the source notes
   using the ordinary identity move, then derive. It has a new document id
   and object key with the same bytes. Removing source bytes must not remove
   the copied object's bytes. Nested binary provenance uses the original
   canonical address, not a storage basename.
7. **No subagent copy.** Queue a child mock matched to its spawn prompt. Its
   first read of `scratch://$THREAD/plan.md` is not found; its `$PARENT` read
   succeeds. Its first own report write succeeds, without a copied plan.
8. **Atomic failure isolation.** On an owned disposable database, install a
   temporary document-insert trigger that raises for the nested `scene`
   document. Derive and remove the trigger in a `finally` cleanup. Creation
   succeeds, no target root/document/catalog tree survives, and `copy.failed`
   logs source and destination ids. The seed still names original notes.
   Send a real first message with a mock read of `$PARENT`: it succeeds.
   Replay creation after removing the fault: copying is not retried. For
   binary cleanup, repeat with a catalog-commit failure after preparation:
   uncommitted copied objects are released and no tree is published.
9. **Create-only and publication.** Replaying successful creation preserves
   all destination identities and independent notes. Calling the copy
   primitive against an existing destination root does no preparation or
   installation. For a preparation/install race, let the destination create
   its own root before installation; that root and its bytes win unchanged.
   Observe one committed destination catalog publication for the complete
   tree, not one per file. Reconnect and reload see the same tree and title
   labels. No source document is moved or relabelled.
10. **Copy lifecycle and replay.** In a separate SQL session, hold
    `document_yjs_checkpoints` with `ACCESS EXCLUSIVE`. Create and replay a
    client UUID: both return while the lock remains held. A first fork send
    completes immediately, using originals or creating its own notes root.
    Release before the 12-second deadline: the copy lands, or skips and logs
    if the model created a root first. Replaying never copies twice. Hold past
    the deadline: no partial root survives, copying never resumes on unlock,
    and replay never retries. Handoff briefs and subsequent turns complete
    while the copy remains blocked; its deadline does not fail the brief.
    Stop the server mid-copy and confirm no partial tree after restart.
    Under Nitro dev, exercise the API worker's registered shutdown handler
    (not only the supervisor process) to prove prompt abort before the copy
    deadline; verify that no copy transaction remains active.
    Repeat with a 40-second INSERT delay and a deferred COMMIT trigger:
    native cancellation drains rollback before the detached task settles.
    Exercise tracked/binary reads and failed-object cleanup with the same
    signal. Compare `copy.copied` elapsed times only when all fixture notes
    were installed; count notes and check errors, not only response latency.
11. **Populated migration.** Apply migrations 0079–0080 to populated derivation
    fixtures exceeding the 500-row page size. Every historical fork/handoff
    gets its origin turn's owner, organic rows stay null, explicit recorded
    provenance is preserved, and replay changes no settled row. New creates
    must supply the acted-on source. Regenerate schema expecting no drift.

Record every scenario's exact command, expected outcome, actual outcome and
raw evidence path in the work item's Phase 3 verification log. Keep fixtures,
SQL fault triggers and scripts disposable; never reset another stack's DB.

## Final browser run (separate prober)

1. Open the fixture Work's Files and the chat's Scratch. Capture title-labelled
   c-folder and p-folder roots. Verify no internal `@cN`/`@pN` basename leaks in
   folder labels, breadcrumbs, menus, completion labels or tooltips.
2. Root menus offer Delete but neither Rename nor Move. Child menus retain
   their ordinary actions. Chat Scratch still offers no New note control.
3. Open and edit an AI note in Editor, reload, and confirm the edit from a fresh
   `./mf doc read`. Follow a chat variable syntax link and the child's canonical
   artifact chip. Labels remain filenames, not addresses.
4. Rename the chat in another client while Files stays mounted. Confirm its
   root label (and subagent root label) changes without losing the open note.
5. Follow an unresolved Scratch link: no Create offer. In an Editor document,
   author a raw `$THREAD` link; it must remain unasked, not missing-creatable.
6. Fork and hand off the visible source in both named Work and No Work. Check
   immediate navigation, copied notes after creation/reload, independent edits,
   canonical source pointers, and title labels. On an injected copy failure,
   the conversation still works and there is no notes status/Retry control.
   Save copied/failure screenshots separately from CLI debugging evidence.
7. Save screenshots with the fixture ids and compare the chat with
   `./mf thread view $THREAD_ID --json`.

Cleanup: remove queued scripts, close only your browser session, remove temporary
probe code, and stop only this checkout's stack with `pnpm dev --stop`.
