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
   `$PARENT` read against the source turn's thread, not its inherited spawn
   parent. Thread snapshots must not carry a notes location map. A root `$PARENT` fails naming the variable.
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

## Labels and targeted publication

Take a Work catalog snapshot and save its cursor. Rename a chat with
`PATCH /api/threads/$THREAD_ID/title`, then request catalog changes from the
cursor. Only that chat's and its direct subagents' associated roots get upserts;
there is no subtree invalidation or descendant re-publication. Stored `name`,
`path`, URI and document identities do not change. Rename the parent while a
subagent folder is mounted and verify both labels update. A missing/empty title
uses `Untitled chat`; a subagent uses its spawning parent's title plus `(subagent)`.

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
6. Save screenshots with the fixture ids and compare the chat with
   `./mf thread view $THREAD_ID --json`.

Cleanup: remove queued scripts, close only your browser session, remove temporary
probe code, and stop only this checkout's stack with `pnpm dev --stop`.
