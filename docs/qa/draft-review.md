# QA: draft-review runtime probes

Repeatable browser probes for the draft-review surface: the Editor and dock review, the
chat's draft dock, the Work page's Changes to review, and the reply receipt. Run them whenever a
change touches review projection, Discard, Apply, the draft command records, the draft dock, the
Work page, or the review launcher. They catch what unit tests around React Query and Yjs
state miss: stale-row windows, silent no-ops, stuck pending states, lost undo history and
dead addresses.

Ownership and command contracts: [draft-review reference](../../apps/app/src/features/draft-review/.context/draft-review.md)
and [ownership map](../../apps/app/src/features/draft-review/AGENTS.md). In short, a change is a group of the
text diff between a draft's `review_base` and `prosemirror` fragments, computed in the
browser. Discard is a local edit of the draft room (one Ctrl+Z step in the Editor and the right-side dock, Undo on the row elsewhere); Apply sends the
snapshot of the projection the writer clicked. `client/query/draft-command-executor.ts`
admits Apply and item Discard, and `draft-command-record.ts` owns their claims.
`EditorView` owns paint readiness, not `useReviewRoomOwner`. `PresentedReviewScope` and
`usePresentedDraftReview` share the one presented-document review across the Editor and
dock hosts.

## Environment

- Start a dev stack from the branch under test: `pnpm dev` in a tmux session (portless
  HTTPS; get URLs from `pnpm portless:list`, never probe raw ports).
- With no provider keys (or `MODEL_PROVIDER=mock`) the gateway runs an in-process mock. Its
  write directives make the assistant write to documents; syntax lives in
  `apps/server/server/domains/runtime/gateway/adapters/mock/write-directive.ts`.
- Drive the UI with `agent-browser` (snapshot, click by ref, re-snapshot). Browsing live with
  no `?work=`, there is no Live chip for another Work's draft; the open document's draft hint
  (last section) says so instead. Use `?work=<the drafting Work>` for the chip.

Capture `agent-browser console` and `errors` at the end of every scenario. A clean console
is part of every pass criterion below.

### Controlled failures and evidence

Create fixtures and read fresh live, draft and list state with `./mf`; use the browser for
interaction, focus and layout. Every held or error step needs an owned browser-page request
interceptor or a supported fault-injection seam installed **before** the action. Filter by
the run's exact Work, document and request; record the observed request before releasing or
rejecting it deterministically. A delay alone does not establish a pending window. Record the
mechanism and response order. If no suitable seam is available, mark the step blocked, not
passed. Never tamper with the shared dev DB or another run's mock queues.

The recipes below replace presentation test matrices. They are instructions, not executed
passes. Run them on the merge candidate at desktop (1440x1000) and phone (390x844, touch)
before calling those substitutions verified. Evidence includes commit, viewport, run-owned
identities, request scope and order, screenshots, clean console and fresh manuscript and
draft readback. Read-only API success does not prove writer interaction. Never cite
`./mf thread send` or `thread tail` output as evidence of what the writer saw.

### Identities and endpoints

- A draft is the Work's whole draft (`draftId`). Its documents are **items**; the client's
  identity for one reviewed document is `itemKey` = `draftId:documentId`, never a branch-row
  id. The Work's draft list (`GET /api/projects/<p>/works/<w>/drafts`) answers `items`, each
  with `origin`, `isNew`, `wholeItem`, `contextLocation { scheme, path }` and
  `actorThreads`. A chat's draft dock list is `GET /api/threads/<t>/draft-files`.
- Review addresses are `/editor/<scheme>/<path>?work=<workId>&item=<draftId>:<documentId>`.
  `?work=` empty means No Work.
- Routes under `/api/projects/<p>/works/<w>/`: `documents/<d>/draft/apply-changes` (one or
  more changes, `changeIds`), `documents/<d>/draft/apply` (the item), `documents/<d>/draft/discard`
  (item Discard: a created, binary or live-deleted item), `drafts/apply` (Apply all, one
  batch over the Work's items), `drafts/discard` (Discard all, closes the draft),
  `documents/<d>/draft/attribution` (the chat-name hint) and `drafts/commands/<commandId>`.
  There is no per-change Discard route: a change's Discard is a local edit.
- Only red and green exist. Chat names on a change are a best-effort hint; nothing gates on
  them. Surfaces show no numeric per-file badges: agreement between the draft dock, the Work page
  and the Editor is checked by named rows and excerpts.

### What the surfaces say

Verify these against the screen before judging a probe; they are the strings the steps use.

- Editor and dock review (identity row): the Draft chip (menu "Versions of this document"
  with Live version and Draft; Close review replaces Live version on a draft-only document), a
  change-list button (tooltip "Show the N changes"), the stepper ("N changes", then "k of N";
  absent for a one-change review), Show changes, Discard draft and Apply draft. A change's own
  bar (named "Change") has Discard and Apply. On a phone the version menu carries Apply draft,
  Discard draft and Show or Hide changes.
- State line: Applying, Discarding, No changes left, then Next draft, Close review or Back to
  live. An Apply that replaced newer live words says "Applied over a newer edit in live:" and
  names them, with Dismiss.
- Live document with a pending draft: a "Live" chip with the same version menu; Draft opens
  the review. A failed launch says so on the chip and Draft retries.
- draft dock: the document name (one document) or "N documents" (several), Collapse changes or
  Expand changes, Discard and Apply. Several documents ask "Discard this chat's changes?"
  with Keep and Discard.
- Work page, Files tab: the group "Changes to review" with an "All changes" menu holding Apply
  all changes and Discard all changes. Discard all asks "Discard all changes?" and "This
  removes pending changes from every document in this Work." with Keep and Discard.
- Local Discard off the editor (draft dock or Work row) leaves "Discarding" with Cancel, then
  "Discarded" with Undo.
- Reply receipt: "Edited 1 document" or "Edited N documents".

## Probe A: review from a reply and from the Work page

Regression guard for #152 (the server sent no document location, so a row's Review was a
silent no-op) and the new-document tab (#153).

Setup (`./mf`): a named draft-mode Work, a thread bound to it (`aiWriteMode: "draft"` in the
create body) and one scripted reply that edits several documents at once. Seed an
eight-paragraph Chapter A, a Chapter B with a "spear" and a "lantern" paragraph, and a blank
live document. In the reply, replace red with blue and Three with Four in A, spear with pike
in B, insert a paragraph into Blank, and create a new document. Verify with `./mf thread view`
that the writes are durably `phase: committed` and that the new file is absent from the live
tree before any Apply.

1. Expand the draft dock. PASS: it says "4 documents" and names them on expansion; Chapter A
   shows two red and green changes, B one, Blank one, and the new file a single whole-item row
   (its name, with Discard and Apply). No numeric badge appears on any surface.
2. Open the Work's Files tab. PASS: Changes to review lists the same four files in stable
   name or id order, whatever the journal recency. Expand Chapter A: its two changes load from
   the room (a failed read shows Retry on that file, never an empty list).
3. Click Chapter A's name on the Work page. PASS: the Editor opens it at `?work=…&item=…`, the
   row shows the real document title (not a placeholder), and the review marks appear. FAIL:
   nothing happens.
4. Open the new file the same way. PASS: the tab opens and review renders before Apply even
   though the document has no context-tree entry; the file tree does NOT show it until Apply.
5. Create a document with empty content in a second Work. PASS: the empty created item appears
   in the draft dock, opens in an editable review, and offers item Apply and item Discard.
6. Dispose of the new-document draft both ways, in fresh Works:
   - Discard (the row's Discard or Discard all changes): the tab closes, the route repairs to
     a live destination (the URL must not keep the dead `work` and `item`, and must not read
     "This destination is unavailable."), a reload does not restore it, and a later Apply of a
     different draft in the same Work never makes the discarded document reappear in the tree.
   - Apply (Apply draft or Apply all changes): the SAME tab stays open on live content, no
     "Access lost" toast, no second tab, and the document appears in the tree within about 5s
     without a reload.

K2 (build `eba4314d7`) failed step 6's Discard repair: the tab closed but the route kept the
discarded item's `work` and `item` on another document's path and read "This destination is
unavailable.", and a reload kept it. Server logs showed a 404 on the document's draft read.
Re-run before certifying.

## Probe B: Discard everywhere

Discard is a local edit of the draft room, so the text changes at the click and the receipt
follows it. Use a Work with two changes in Chapter A and one in Chapter B.

1. In the Editor, click Discard draft on a reviewed document. PASS: the base text renders at
   once, the state line reads No changes left, live is unchanged (`./mf doc read`), and the durable
   draft fragment (an independent Postgres or Yjs read once the socket has synced, as K2 did)
   equals the base.
   Ctrl+Z restores the whole proposal as one step. Repeat with one change's own Discard: one
   Ctrl+Z restores that change.
2. On the Work page, expand Chapter A and click one change's Discard. PASS: the row reads
   "Discarded" with Undo only after the draft already holds the discarded text; Undo restores
   the change. Repeat from the draft dock's expanded row.
3. Prove ordering offline: set the browser offline, click Discard on a Work row, then on a
   draft dock row. Record a browser-side `Y.Doc` transaction observer (its origin is the room
   discard origin) and a MutationObserver on the receipt. PASS: the fragment change is
   observed no later than the "Discarded" row (K2: 8078.6 ms vs 8085.0 ms), Undo restores the
   text, and after reconnect the durable draft agrees. Do not take screenshots through a new
   CDP target during the offline window (see the offline-emulation note in [README.md](README.md)).
4. Discard on a collapsed chat file through the draft dock's own Discard: PASS: the row reads
   "Discarding" with Cancel until the room is acquired, then "Discarded" with Undo.
5. Work page, All changes, Discard all changes, Keep: no request. Repeat and confirm, holding
   the exact `/works/<W>/drafts/discard` request: PASS: the files read Discarding while held,
   the group disappears when the answer settles, and no navigation occurs. Live is unchanged.
6. A new document's Discard (row, draft dock or Work page) is an item Discard: the server closes the
   item and its tab. Verify the draft list no longer has it and the file never reaches the tree.

## Probe C: moves, Ctrl+Z and view handoff

1. In an Editor review, select the first paragraph including its break with a native DOM
   range, Ctrl+X, select the start of another paragraph, Ctrl+V, type " X", then Ctrl+Z twice.
   PASS: the exact earlier ProseMirror document, review mark ids and classes, and the durable
   draft blocks come back at each step.
2. Have a chat create a paragraph with an alignment attribute and a bold span. Change its
   alignment as the writer, Ctrl+Z; delete the whole paragraph, Ctrl+Z. After each, reload the
   review and check exact text, formatting and alignment.
3. Handoff between hosts (the Editor and the chat's document dock hold the same room). In the
   Editor type " VIEW_A" in an unchanged paragraph and Discard one change; switch to Chat with
   the same review in the dock, type " VIEW_B" in another paragraph and Discard another
   change; return to the Editor and press Ctrl+Z twice, then return to the dock and press it
   twice. PASS: each view undoes only its own typing and Discards. Exclude the retained
   `[inert]` and `aria-hidden` editor DOM from the typing target. Control: type " CONTROL",
   Ctrl+Z (it disappears); type " SURVIVE_SWAP", switch hosts and Ctrl+Z (it must also undo).

K2 failed step 3: after the transfer neither view undid anything and the toolbar Undo was
disabled, with no console error. Re-run before certifying.

## Probe D: Apply

All Apply requests carry the snapshot of the projection the writer clicked.

1. A delayed scripted reply changes blue gate to silver gate, and later Two sleeping oxen to
   Two alert oxen. Apply the gate change while the reply is still writing. PASS: live has
   silver but not the later oxen; the oxen change stays pending.
2. In the river paragraph type " My immediate heron stays." and at once click Apply draft.
   PASS: live holds the complete typed sentence (the open editor's projection is flushed at the
   click, not read from a debounce).
3. Override race. Stage halberd to lance in Chapter B. Hold the exact `/draft/apply-changes`
   request; the shown proposal is captured. A direct peer changes live halberd to staff
   (`./mf doc read` confirms). Release the clicked request. PASS: live becomes the lance text,
   and the screen says "Applied over a newer edit in live:" with the replaced word in quotes
   ("staff"). The same notice appears, with Dismiss, on the draft dock row and the Work row.
   This exercises a live edit after the click but before the server ran it, not a stale screen
   clicked after the edit was received.
4. Whole-Work batch. With Chapter A and B collapsed on Work Files, hold the exact
   `/works/<W>/drafts/apply` request and click All changes, Apply all changes. PASS: ONE request
   (not one per document); every file row reads Applying together. Release: both settle, the
   group empties, and live holds the proposals. Stage another proposal on the same document:
   it reappears without a reload.
5. One change at a time: Apply a single change from a row, the change bar and the stepper's
   focused change. PASS: the change leaves the screen at the click, only its text reaches live,
   the other changes stay, and a failure restores the row with the reason on it.
6. A second command on an item whose Apply is out sends no request (the claim is held until the
   first settles). Offline: Apply fails on the file with "Couldn't apply. Check your connection
   and try again." and does not dispatch on reconnect. Log `navigator.onLine` and
   `onlineManager.isOnline()` before each click (see [README.md](README.md)).
7. Apply a change from an unopened Chapter B while Chapter A is in review. PASS: no review room
   or navigation is opened for B, the command acts on B alone, and A stays where it was.

Scope: failure and rollback batch cases (a refusal in one file while later files run) need a
held-failure seam; mark them blocked without one.

## Probe E: tab lifecycle and addresses

A draft-only tab is the document's one tab and is never persisted; the address (document and
item key) reopens it. Only a command's own outcome closes or promotes it; a list change, a
metadata read or a 404 never does.

1. Open the new file from the draft dock, reload, and open the exact review URL in a fresh browser
   page, at desktop width and as a phone (390px, coarse pointer). PASS: the same review opens
   each time with `?item=` kept, and no other document shows at any time. Record history writes
   with a `history.replaceState` wrapper installed before first load: none beyond the router's
   startup write. FAIL: the address ends on another open document with `?item=` dropped.
2. Apply draft on it. PASS: the same tab remains, no duplicate, the live tree gains the file
   and an independent live read returns its text. The review keeps its Draft chip and No changes
   left until navigation; it does not turn into a Live chip by itself.
3. Copied No Work address. Leave a pending new-document draft in No Work, copy its address
   (`…?work=&item=…`), select a named Work in this browser, and open the copy cold at both
   widths. PASS: the same draft opens in review, `?item=` kept, one startup history write.
   On a live No Work document opened from a copied URL (no `?work=`), choose Draft in the Live
   chip's menu: one `replaceState`, no `pushState`. Rename the document from the manuscript
   tree with a review open: exactly one history write for the new address.
4. Unlisted draft in the dock. Open an unlisted (new-document) review in the Editor, click Chat
   so the same review sits in the dock, reload. PASS: the review returns on truth. Repeat with
   a second, independently created item. FAIL: "Couldn't open this document" with a Retry while
   the server still lists the item and holds its text. K2 failed this on both items with no
   console error and no 404.
5. Two sessions, one draft-only document. Apply it from the Work page in one session. PASS: the
   other session's tab stays and shows the live document within about a second (the account
   replica shows the document). Then, from a fresh draft, Discard all changes in one session:
   the other session must not close or promote its tab from the list alone. Record what it
   shows, that nothing stays pending, and that both consoles are clean.
6. Same new document in two Works (Alpha and Beta). Open the review in both. PASS: each tab
   keeps its own Work and draft identity; Discard in Alpha removes only Alpha's tab, Beta keeps
   its review, and discarding or closing in Beta then removes it. Apply Beta while Alpha stays
   pending: Beta's Work shows the live document, Alpha still shows its own review. Rename the
   visible representation: the other Work's tab is not selected or closed by the metadata update.
   Reload a dock review with several same-document draft-list rows: only the saved Work and
   draft restore.

## Probe F: offline and reconnect

1. Disconnect the browser context while reviewing Chapter A and append " My offline crane
   stays." From a direct-mode peer rewrite the two existing river sentences in place (no delete
   and recreate). Reconnect and leave the page idle.
2. PASS: the draft reads the peer's rewrite followed by the writer's typing, and the offline
   sentence occurs ONCE at 10 s and in a later idle read. The draft stays editable and native
   typing and Ctrl+Z still work. No refusal and no 1008 close appear in the client trace or
   server diagnostics. Offline network errors and 1006 reconnect attempts are induced transport
   failures, not product refusals.
3. Stale typing on rewritten text (D33). Offline again, in one paragraph type a new sentence,
   type a second one and delete it, and delete one existing word. From the direct-mode peer,
   rewrite that paragraph so the rebase replaces its words (retype it, move it, or cut it and type
   an unrelated paragraph in its place). Type with native per-key typing: the browser resends each
   keystroke as its own frame. Reconnect.
   PASS: the surviving offline sentence appears once, green, as ONE paragraph with its spaces
   (never a column of letters) beside the paragraph's last neighbour. The deleted offline sentence
   does not appear when the reconnect arrives as one frame; resent per keystroke, its typing lands
   before its deletion and stays, green (D35: a stale frame never deletes; delete it again). The
   rewritten paragraph keeps every word including the one deleted offline (delete it again). A
   second reconnect changes nothing, and neither does one after the browser has caught up: the
   recovered sentence stays. No refusal. Automated: `late-peer-admission.test.ts` (also a writer
   formatting a recovered paragraph between stale frames, which a browser can't stage).
4. Open the live room's WebSocket frames while idle. Known issue
   ([#838](https://github.com/haowjy/meridian-flow/issues/838)): the `yjs:live:<documentId>`
   socket closes cleanly with 1005 about every 32 seconds and reconnects after about a second,
   with no text loss. Record the interval; it is not caused by this surface.

## Probe G: a reply writing into text the writer discarded

An AI write that is already staged commits when it reaches the server; the writer gets a notice
rather than a refusal.

1. A normal reply inserts a standalone "A hidden raven perched here." paragraph into Chapter B's
   draft.
2. Start one model response with 150 chained `replace` tool calls on `raven` (each `find` is the
   previous `content`), sent with `./mf thread send --no-wait`. A reply saves once per response,
   after all its tools have run, so the mock's `delayMs` (which delays the model, not the tools)
   cannot hold it. Read `/api/threads/<T>/snapshot` while it runs: it shows the turn streaming
   with successful replace results at `phase: staged`.
3. In the browser, Discard the whole added raven paragraph before the response commits.
4. Let the response finish and expand "Edited 1 document". PASS: the staged writes commit
   (`phase: committed`) without any Discard refusal, the paragraph stays absent, the live-lineage
   result for the turn has `invisibleWrites: true`, the receipt says "Some of this reply's words
   went into text you discarded.", and the next model call receives the matching system notice.
   Tool calls attempted after the paragraph stopped being addressable return an ordinary
   `not_found`; those are new failed selections, not refusals of staged writes. The mock's
   continuation after the notice may echo the `<system_update>` text; that is mock output.

The DB witness is `draft-write-visibility.db.test.ts`
(`DB_TEST_WORKERS=1 pnpm test:db apps/server/server/domains/collab/draft-write-visibility.db.test.ts`).

## Probe H: the chat-scoped draft dock

Use real chat writes, not synthetic database rows: the chat names on a change come from the
pending AI edit parts the server lists. Run at desktop width and on the phone (390px, coarse
pointer), recreating the fixture before each disposition. Set it up with [`./mf`](../debugging.md),
then use the browser only to exercise and inspect the surfaces.

### Setup

1. Create a named Work in Draft mode and four chats bound to it: Pacing pass, Lore pass,
   Dialogue pass and Untouched. Seed two live manuscript files with `./mf doc put`: Chapter A
   with separate paragraphs "Alpha sword waits at dawn.", "Beta shield gleams at noon." and
   "Gamma waits at dusk."; Chapter B with "The spear rests by the door.". Use unique filenames
   per run.
2. Send a scripted mock turn from Pacing pass that reads Chapter A, then replaces `sword` with
   `blade`. Wait for completion. From Lore pass, read the draft and replace `blade` with `sabre`,
   then in another turn replace `shield` with `buckler`. From Lore pass, read Chapter B and
   replace `spear` with `pike`. Use `./mf thread send <thread> <message> --mock '<script>'`: each
   script has `steps` containing separate `read` and `write` tool calls with `args.path`, and the
   replacement's `command`, `find` and `content`.
3. From Dialogue pass, create a new manuscript document in a mock `write` turn (`command:
   "create"`, a fresh `path` and `content`). Send no writes from Untouched. Verify the Work's
   draft list through `./mf api`: Chapter A's `actorThreads` include Pacing pass and Lore pass,
   Chapter B's Lore pass alone. A fixture without a change both chats wrote cannot prove the tie
   behavior: the sword change reads `sword` to `sabre` and names both chats.

### Checks

1. Open Pacing pass. PASS: the draft dock shows Chapter A and only the change this chat's writes
   overlap (sword to sabre), not Lore pass's shield change and not Chapter B. Summary and
   controls share one line.
2. Click the single-document draft dock's document name (Tab and Enter also work). PASS: the name
   opens review without toggling expansion, and there is no summary Review button. A failed
   review launch keeps the name available to retry and shows its error beside it. The chevron and the remaining summary area toggle expansion. On the phone the
   name has a 44px touch target and commands are visible without hover. The Editor opens on the
   shared change, while its marks, stepper and change list still show the whole document's
   changes. The change bar names both chats (overflow names are in "+N", with the "More chats"
   menu); each name opens that chat beside the review without acting on the change (the chat
   sheet on the phone), without changing destination.
3. From a fresh fixture, Apply on Pacing pass's draft dock. PASS: the shared change reaches live
   (`sabre`), while `shield` and Chapter B's `spear` stay unchanged on live and Lore pass's
   remaining changes stay pending. The draft dock never navigates. Recreate and repeat with Discard:
   the shared change leaves both draft docks (the Discard is a local edit; the row reads "Discarded"
   with Undo), live keeps `sword`, and Lore pass's separate changes remain.
4. Open Lore pass before disposition. PASS: the draft dock shows "2 documents"; expanding groups
   this chat's changes under one-line file headers. Each file name opens its own review, never an
   arbitrary first document. A new document (one whole-item change) has ONE named review row
   with Discard and Apply, not a header followed by the same name; the Work page's expanded file
   follows the same rule and its chevron still collapses it. A real single per-change edit keeps
   its file header and excerpt. The document change list popover and the phone sheet have no file
   header. Discard asks "Discard this chat's changes?" with Keep and Discard; Keep sends nothing;
   confirming takes only Lore pass's changes, including the shared one.
5. Open Dialogue pass. Its new document is one change with Apply, Discard and Review (the name).
   Apply publishes it; Discard removes it (item Discard on the server). Review opens it without
   publishing.
6. Open Untouched. PASS: no draft dock, although the Work has pending changes. After Pacing pass's
   last change is handled, its draft dock also disappears, even while Lore pass's other changes remain.
7. No draft dock or change list offers a Work-page footer. Ordinary Work navigation reaches Files and
   its Work-wide commands.
8. While a scripted mock turn is actively generating (use the 150-call recipe in Probe G), the
   draft dock's Apply and Discard are disabled and click sends no request; the page states no reason.
   After the reply finishes they enable. Hold one preview or list read for a new-document-only
   chat: commands stay unavailable until the list arrives.
9. Fail one owned read: a file shows Retry on that file, not an empty list; retry restores it.
   With two files, Keep in the draft dock's Discard confirmation sends nothing; confirming handles
   both files. With one remaining file, Discard sends at once and affects only that file and chat.
   Verify the foreign chat's live and draft content.

### Narrow draft dock failures and confirmation

With one existing document, retain a failed Review launch or whole-item command: the automatic
expansion leaves exactly one visible error owner. Whole-item rows carry their own failures.
With several documents, Discard replaces the summary with its question and Keep and Discard
rather than overlapping the filename. Probe 390px touch and a 320px dock (256px inner draft dock),
including a long translated question: all controls stay inside the row with disjoint bounds and
44px touch targets. Hold a whole-item Apply or Discard request: the row shows Applying or
Discarding on the file and returns the failure on refusal, with no navigation change.

## Probe I: the change list on both shells

Use Probe H's two-document, two-chat fixture. This is a visual probe: desktop 1280x900 and phone
390x844. Record screenshots and the fresh reads per action.

1. Open Chapter A live. Open its change-list button (the phone opens a sheet). PASS: only this
   document's changes appear, never Chapter B, and no Work-wide commands. Expand the version
   menu: only Live version and this Work's Draft. Repeat with a new document: no Live version is
   offered.
2. Open its review, then hide marks. PASS: the list stays reachable by keyboard (Tab and Enter);
   focusing a row closes it and focuses that change. Step Previous and Next change both ways,
   including wrap. On desktop shrink the pane until the bar moves below the text, then widen;
   commands stay keyboard reachable and do not cover prose. On the phone open the keyboard: the
   bar clears it and the home indicator. Measure 44px command and stepper touch targets. Check
   chat-name width and untitled chats still have a usable link. A one-change review has a list
   button but no stepper.
3. Apply one row, recreate and Discard one row. PASS: the list stays open, the chosen change
   disappears immediately, live changes only on Apply. Apply sends `changeIds` and the snapshot
   of the clicked frame to `apply-changes`; Discard sends nothing (a local edit). A refused
   Apply restores that row with the server reason, not a false connection warning. Switch offline
   and click: the row returns with a connection refusal and never dispatches on reconnect.
4. Handle the last change with the list open. PASS: the list closes; the identity row reads
   Applying or Discarding, then No changes left, with Next draft (sorted-file position kept),
   Close review on a draft-only document, or Back to live when alone.
5. The phone sheet title says Changes without a count. No Work-page link or success toast appears
   in either list. The list button stays usable while review enters, leaves and marks hide.
6. Send a new AI change while watching: the count grows, the new row pulses once, the pulse
   expires; type a writer edit and confirm it gets no arrival pulse. Reopen the list during
   loading, applying and finished states: the button stays reachable.
7. Refusal language. Cause a typed known refusal on a row or the bar (for example a held Apply
   answered `stale` or `path_taken`); it is a refusal, not connection loss. Keep that stored
   refusal and switch language without another request. PASS: its code renders in the current
   locale, using the catalog translation where present and English where the entry is empty (most
   of the Chinese catalog is untranslated). To verify an empty entry, break in `RefusalReason` in
   `ReviewMessageText.tsx`: switching locale must re-render the same stored code and call
   `i18n._(known)` with the new `i18n.locale`. For an intercepted unknown refusal, preserve the
   server's reason verbatim. Dismiss the failure and check it leaves; success has no toast.
8. Versions and held failure navigation. With another file and Work present, the Live and Draft
   menus offer only this document's versions. Whole Apply immediately moves to the next sorted
   file; reject its answer after moving: the failure identifies the original file and never pulls
   navigation back; Open goes to the failed file. Finish a middle file and use Next draft: it
   follows the removed file's former sorted position, wrapping; alone, Back to live. Repeat in
   No Work.
9. Rename and phone lifetime. Desktop Rename closes the version menu before opening the rename
   field. On a draft-only review no Live version exists and Close review does not open a live
   room. On the phone, enter and leave review and another document while watching editor
   identity, scroll and selection: no unrelated document header and no remount-induced loss.
   Discard with the sheet open: the row leaves immediately without a success toast; the sheet
   closes when no changes remain. The version menu's Discard draft acts without an approval
   dialog and moves on; the manuscript editor survives both and the keyboard does not
   intercept controls.
10. Bar placement and tones. At desktop wide, narrow and scrolled pane sizes, resize repeatedly:
    the bar moves between margin and block, never covers or clips prose, and keyboard activation
    reaches the commands. Inspect a shared change, a writer-only edit and an unattributed removal:
    only red and green appear, a writer's edit is an ordinary green change with no chat name, and
    a neutral removal stays visible without an invented author. Use a screenshot plus a fresh
    list read, not guessed geometry.

## Probe J: Work page commands and held failures

Continue with Probe H's fixture (recreate proposals between actions).

1. Open the Work's Files tab. PASS: Changes to review lists files in stable name or id order;
   journal recency never reorders them. A new document expands to one change with Apply and
   Discard acting on the item. Finished files leave the group without a duplicate completion
   message.
2. Filter search so one file is hidden. The All changes menu still says Apply all changes and
   Discard all changes (no counts) and handles EVERY document of that Work, new documents
   included. Recreate and Discard all changes: the inline question appears; Keep cancels without
   a request; confirming handles all with no navigation.
3. For a Work owned by neither the current chat nor the Editor, commands act in that Work with no
   cross-Work request. Inspect fresh live and draft reads through `./mf`; cached DOM cannot
   certify persistence.
4. While a batch waits, navigate to another Work, then archive the original Work through its
   ordinary menu. PASS: the request already owned by the original batch finishes in the original
   Work, controls lock (`dispositionLocked`), no new Work gets an old request, and no answer
   navigates back. An archived Work shows "This Work is archived. Unarchive it to apply or discard
   its changes." on a refused command.
5. From a finished review, send a fresh proposal to the same document. PASS: the review re-enters
   in place with the new change and no stale completion, even if the previous answer or list read
   lands late. Leave for another document and repeat: a late answer cannot reopen the previous
   review. Capture request and response order.
6. Failures and offline batch. Fail an expanded read, Retry successfully, then verify commands
   work. From a Work with several files go offline and attempt Apply all changes and Discard all
   changes: each affected file reports its own offline failure, with no successful completion or
   navigation. Reconnect and verify no queued command fires. Log both online signals before every
   click.
7. Two tabs, held writing. Open one draft's review in tabs A and B. In A, hold outgoing Yjs frames
   and incoming acknowledgements at the native WebSocket (HTTP stays open), then type in surviving
   prose and inside an AI-added change. In B, Discard all changes from the Work page. Release A
   without navigating and recheck after 30 s. The Work's draft is closed, so record what A shows
   (its room is superseded and the tab asks the server again). PASS: live is unchanged, the
   console is clean, and nothing stays pending. Control with no held writing: record the same.

## Probe K: chat links from change rows

Use a change two chats wrote. Run both shells.

1. From the Work page's expanded row, the document change list and the draft dock's review bar, click
   each chat name. PASS: that chat opens beside the screen (the phone's chat sheet), no review
   opens and no change command runs.
2. Rename one writing chat and refresh. PASS: shared changes name each current chat and each name
   opens its own chat; an untitled chat still has a usable link; writer-only edits name no chat (they say "You").
   Inspect `GET …/draft/attribution` and the transcript with `./mf` for the attribution.
3. With a chat that made two `write` calls, click its link on the change the second call made.
   PASS: the chat opens scrolled to that second `write` tool call (not the chat's usual position),
   and the first call is not the target.
4. Edit a paragraph the AI already changed and applied (type a word elsewhere in it, or a letter
   inside an AI word). PASS: the card says "You" with no chat link, and the draft dock does not
   list it under the chat. Type next to a pending AI change: PASS: one card with "You" first, then
   the chat link.

## Review across document schemes

In a named draft-mode Work, use the mock model to create `kb://Place`, edit an existing
`kb://Hero`, and edit `manuscript://Chapter`. Check the durable transcript with `./mf thread
view` and the Work's draft list: every item has `contextLocation: { scheme, path }` with its own
scheme.

Open each kb draft from the draft dock, the document's change list, and the Work page. The
Editor stays in Knowledge Base, shows the new draft as draft-only (no live-file error), and
admits inline review. Apply the new document and read it back from `kb://`; Discard the
existing-document edit and verify its live text is unchanged. Review the Manuscript chapter too.
File policy alone chooses where drafts can exist. The review path imposes no scheme whitelist;
each item opens its own location.

## Rich-only paragraph changes

With this worktree's mock stack running, seed `## Scene` followed by `The red gate opens.`.
Create a named Work and a thread bound to it with `aiWriteMode: "draft"` in the create body.
Through `./mf thread send --mock`, read the document, then replace its two blocks with `###
Scene` and `The **red** gate opens.`. Use tool `path` arguments, not the agent-edit core's
internal `file` name.

Read the Work's draft list and the document through `./mf api` and open the Editor with that
Work and item. PASS: two changes (a heading-level change and a bold change), each with the
affected text struck and rewritten in its row, both blocks tinted red and green, and no
duplicate struck-through copy of unchanged text. Apply each change separately with its row's
Apply, reading live after each: only its exact rich effect reaches live and the other change
remains. Stage the reverse formatting proposal and Discard each change separately: live stays
exactly unchanged and the other change survives until its own Discard. Capture the list, the
change rows and browser errors. Stop only this worktree's stack.

## Reply commands against a replying model (browser, mock stack)

The draft dock is disabled while a reply is still writing. Discard draft in the Editor and the
Work page's Apply all and Discard all keep working. Use a draft-mode chat in a Work (`aiWriteMode:
"draft"` at thread creation) and an owned project, and drive both pages in `agent-browser`
(desktop 1440x900). `./mf` sets up the Work, the thread and the scripted turns, and reads durable
state (`doc read`, the drafts list, `thread view`) after each click.

**Holding a reply mid-write.** Send one response with 120 to 300 chained `replace` calls on one
document (each `find` is the previous `content`) with `./mf thread send --no-wait`, and click
about one second later. An earlier turn must already have saved a draft edit to the document so
it is listed.

1. **Draft dock disabled during the reply.** Open the Work's chat. While the reply runs, the draft dock's
   Apply and Discard are disabled. PASS: clicking sends no request. After the reply finishes
   they enable.
2. **Draft dock commands after the reply.** Click Apply on the draft dock. PASS: only this chat's changes
   apply; other chats' and the writer's changes stay pending.
3. **Discard draft during the reply.** In the Editor, click Discard draft while the reply is
   still writing. PASS: the base renders at once as one Ctrl+Z step; the reply keeps writing and
   its later edits show as NEW changes; words it wrote into the discarded text vanish and the
   receipt says "Some of this reply's words went into text you discarded." (Probe G).
4. **Work page Apply all during the reply.** The page sends no snapshot for a collapsed file, so
   the server freezes the file's text when it stages the command (staging is the consent), after
   its catch-up rebase and before it reads live. Hold the request at that point to time the
   reply's writes exactly: pause the Apply all request in the browser (`agent-browser` network
   route or a devtools breakpoint) after the click, and read the draft with `./mf doc read` while
   it is held. PASS, by when each write became durable in the draft. Writes saved before the
   server froze the text are in live, so a reply write that lands while the request is still
   held is in live with the text the click saw. Writes saved after the freeze are not in live
   and the document stays under Changes to review with them. Check both sides with two replies
   (one saved before releasing the hold, one after the batch completes). Do not expect live to
   equal "the text saved before the click". Separately, Apply from an open editor flushes its
   own frame at the click: its snapshot is that click-time frame, so a later reply write is
   always left in review.
5. **Work page Discard all during the reply.** The same menu, Discard all changes, confirm (at
   390x844 too: the question and both buttons stay on screen). PASS: the list is empty, live is
   unchanged, the in-flight writes fail with "You discarded this draft, so the change wasn't
   kept. The AI will read it again.", and a later write lands in a new draft.
6. **Live-edit staleness.** Not covered here: an Apply with a stale tree token refuses as `stale`,
   tested by the DB suite (`draft-tree.apply-staleness.db.test.ts`). Live text moving never
   refuses an Apply.

Capture `agent-browser console` and `errors` at the end of each: clean is part of the pass. The
API-level answers (`commandId` resend, conflict, unknown, `whole_item`) are covered by tests, not
by this recipe.

## Whole Discard isolation across Works

In two draft-mode Works, create drafts of the same manuscript chapter. Stage an independent edit
to that chapter in each chat while their replies are still open. Run item Discard (a new document)
or Discard all changes in Work A. Work B's reply must finish and its edit must appear in B's
draft, not in live. A's staged chapter edit must not reappear; a later edit in A starts a new
draft. A reply's staged edits to other documents must still finish.

The repeatable service-seam checks are
`DB_TEST_WORKERS=1 pnpm test:db apps/server/server/domains/collab/draft-tree.discard.db.test.ts`
(only the discarding draft's peers retire; another Work's staged reply on the shared document
saves) and `apps/server/server/domains/collab/reply-save-refusals.db.test.ts`. These are DB
integration evidence, not a browser or live-runtime probe.

## Rollback and revert

A failed response rolls back its staged writes through the inverse writer, and the model's
`revert` writes into the thread's current destination. Neither is a writer-facing Undo: the
receipt has no Undo or Redo. Run the DB matrices
`apps/server/server/domains/collab/model-inverse.db.test.ts`,
`inverse-integration.db.test.ts`, `inverse-rollback.db.test.ts`, `response-rollback.db.test.ts`
and `response-transaction-atomicity.db.test.ts` with `DB_TEST_WORKERS=1 pnpm test:db <file>`. A
checkpoint failure is post-commit maintenance, not a failed response: the save still returns
committed and its text remains.

## Terminal trail recovery

Use an owned thread and Work draft. Let its producing assistant turn finish, then wait for the
empty trail to settle while the edit remains unapplied. Apply the draft, repeat with another edit
and run Discard all (or an item Discard), and read the trail through `./mf api GET
/api/threads/<thread-id>/change-trails`. Each late disposition must reopen the producing trail
and settle at a higher version. Unapplied drafts must not publish themselves. An empty or failed
assistant turn must also settle.

For the commit-to-worker crash window, use the PostgreSQL lifecycle suite:

```bash
DB_TEST_WORKERS=1 pnpm test:db -- apps/server/server/domains/collab/change-trail-lifecycle.db.test.ts apps/server/server/domains/collab/adapters/drizzle-trail-signals.db.test.ts
```

Its restart checks commit before constructing a fresh aggregate adapter on a separate connection.
Receipt and placement rollback must leave the signal log unchanged; committed invalidation must
survive destroying warm state. These are DB integration checks, not a claim that this manual writer
workflow passed.

## Pane paint continuity

Observe `[data-paint-hold]`, `[data-paint-page][inert]`, the destination URL, visible prose and
review marks with a MutationObserver and animation-frame samples. Use exact request interception
for controlled pending and error windows, never sleeps. Exercise cold and warm Next draft, another
document's draft dock Review, Apply draft and Discard draft moving on, room-read failure on desktop and
phone, leaving to Chat mid-hold, and ordinary document switches on both shells. Navigation must
change outside the hold immediately; no sampled frame may show uncovered blank prose or live prose
under review chrome, and the cover must never show a loading status ("Opening document…"); phone
Discard draft moving on is the case that caught it. Failure releases to the destination's card.
Verify the status line announces the destination, focus returns to the pane, copied ids are absent
and the 10-second bound does not restart on another move. Scope the pane by screen visibility:
route and session acquisition temporarily deactivates input but must not withdraw the painted
frame from capture.

## Review follows its document (desktop)

From this worktree's mock stack, seed one new-document draft and one draft over an existing
manuscript with `./mf`. For each, review in the Editor, switch to Chat and back: the dock retains
marks, change bar and commands, and returning opens the review's Work and item address. Only the
presenting host renders review.

On Chat close the retained Editor tab, reload, and verify a dock-only review returns without a
live-body or error frame. Apply from a second tab twice in fresh Works: the dock's draft-only
review is released to the live document and reload preserves that result. Check no project
boundary or maximum-depth console error occurs. Check dock Next draft and auto-advance stay on
Chat, Back to live survives reload, Close only closes the dock, and collapse and expand retains
review. For each Close variant, start with the same review in an Editor tab, carry it to Chat,
close the dock document (X) or use Close review on a new-document draft or Live version on a
manuscript, then return immediately to Editor. Its tab, `item` URL and marks survive; reload on
Editor restores that review. Reload on Chat after closing the dock instead restores the native
occupant (a draft-only review never persists; the URL's `item=` rebuilds it). Capture screenshots
with `page.screenshot()`, fresh API readback and console errors.

Also check three fences. On a Work screen, open a manuscript in the dock through its path menu,
open its review from the Live chip's Draft choice, and reload on the same Work: the review returns;
leaving the Work closes it. In the Editor, keep a draft-only review whose row has left the list
open while a list refresh runs: the review and its error destination stay (no Apply, no exit). After
a remote Apply, the dock's draft-only review is released to live.

## Compact review checks

- A one-change review has a list button but no stepper.
- Work rows retain whole chat names at wide widths and hide attribution at narrow container
  widths.
- The change bar never abbreviates a chat name. "+N" opens the remaining chat links. Check desktop
  and phone.
- With the 320px dock open, and at narrower editor widths, the bar and both commands stay within
  the manuscript pane (under-change placement when needed).
- Before screenshot capture, assert the intended surface is visible, no Loading project text or
  Saved locally (offline) pill, and `navigator.onLine`.

## Cold-open waterfall and the ahead-link chip (browser)

Open a drafted document's review cold: a fresh `agent-browser` session with the auth state loaded,
then `open` the review URL (`/editor/<scheme>/<name>?work=<workId>&item=<draftId>:<documentId>`).
Wrap `fetch` and `WebSocket` in an init script, enlarge the Resource Timing buffer (Vite loads
hundreds of modules), and watch for the first appearance of the draft's text in
`document.body.innerText`. Record, ordered by start time: the address admission request
(`reviewWorkId` and `itemKey` in its query), the draft item request (`documents/<d>/draft`), the
`/ws/yjs` connect and open, and the first text. There is no server preview request; the review is
computed in the browser once the room has synced. PASS is the request order and the total from the
address request to first text, not a threshold: say whether the three run as a serial chain.

For the link chip, record every change of `data-link-chip` and `aria-description` on
`a[data-meridian-link]` with `performance.now()` from the chip's first insertion, on a cold load,
a load with `?work=`, in-app navigation, and with the `links/resolve` response held by an owned
fetch seam. A live chapter holding an `ahead:` link to a document that exists only in a draft must
settle on the "in a draft" state without reading "Doesn't exist yet" on the way.

## A writer's New file joins the draft's document (browser)

A draft's new document is a real document with a draft, hidden live only because it is a draft.
Making it live (New file, a link's Create, the AI) unhides it, and it stays one document with an
ordinary draft over it. The device's instant create carries its destination, so the server joins
the document waiting there. The only device work is identity: the reservation's id becomes the
joined id, and what the writer typed is kept. No draft text is merged; the draft's text stays in
the draft for review.

Setup (own stack, `MODEL_PROVIDER=mock pnpm dev`): `./mf api` to create a Work with `aiWriteMode:
"draft"` and a thread bound to it. `./mf thread send <thread> go --mock @script` with one scripted
`write create` of `manuscript://Chapter 2` (give it text). Desktop 1440x900, then the phone
390x844 with touch emulation.

1. **Online.** Open the project. Sidebar, Manuscript, New file, `Chapter 2`, Enter, and type a line
   at once. PASS: one `Chapter 2` row and one tab, on the draft's document (same id as the Work's
   draft item, read with `./mf api`); the typed line is kept; the Work's review item is an edit, not
   new. As soon as the create's answer lands, with no reload or navigation, the open document shows
   the "Live" chip with the version menu, and Draft opens that draft's review. Measure from the
   `create-untitled` response to the chip appearing. Check it inside the drafting Work's chat and
   browsing live with no Work. Database: one `documents` row at that path (`psql`, `hidden =
   false`).
2. **Offline.** `agent-browser set offline on` before New file; New file `Chapter 2`, type a line,
   set offline off. PASS: the same as step 1 once the connection returns; before it, the row sits at
   `Chapter 2` in the Manuscript, not under Unfiled.
3. **A rename while the create is out.** Offline, New file `Chapter 2`, rename it `Chapter 2b`,
   reconnect. PASS: one row `Chapter 2b` on the draft's document; the rename is not offered for
   repair.
4. **A link's Create.** The Create button exists only on a link that reads "doesn't exist yet", and
   following an "In a draft" link opens the review instead. So make the link in the editor (select
   text, Link, destination `manuscript://Chapter 10`), open it so its Create dialog is up, have the
   AI draft `Chapter 10` in the Work, then press Create. PASS: the same as step 1.
5. **No regression.** New file at a free name, and at a name a visible document holds (the second
   takes the free name, `Chapter 2 (2)`).
6. **A draft-only tab open before the join.** Open the draft's `Chapter 2` first (the chat's Edited
   line, the draft dock, or the Work page's Changes to review), then New file `Chapter 2` from
   the sidebar. Repeat with that tab open but another tab selected, and reload afterwards. PASS: no
   "Couldn't open this draft." card; the open tab becomes the document's ordinary tab with the
   draft's review over it (the view the chip's Draft choice gives; an unselected tab simply becomes
   ordinary). A hand-typed address whose draft is gone shows "This destination is unavailable.". Wrap
   `fetch` in an init script and log the bodies of `working-set`, `context/availability` and
   `recent-documents`: none answers 400 or 404, and neither `meridian:working-set` nor
   `meridian:account-recents` keeps the device's minted id.

With no `?work=` the document shows the draft hint instead of the Live chip (next section).

Capture `agent-browser console` and `errors` at the end of each: clean is part of the pass.

## An open document says when a draft has changes to it (browser)

`GET /api/projects/:p/documents/:d/drafts` answers `items`, the active drafts in the project with
changes to the document (`draftId`, `itemKey`, `label`, `originWorkId`), the same membership as the
Work page's Changes to review. The editor shows a line (`[data-document-draft-hint]`) under the
identity row for every draft other than the one the view works in: "A draft has changes to this
(Northern Arc)" with Review, or "2 drafts have changes to this" with a Review menu. A draft with no
name reads "Unnamed draft" in the menu. Setup as in the join recipe, plus a second named Work in
draft mode. Desktop 1440x900, check 1 also at 390x844.

1. **The owner's flow, in No Work.** The AI drafts `manuscript://Chapter 2` in Work A. With no Work
   open, New file `Chapter 2`. PASS: one row, and the hint naming Work A appears with no reload;
   Review opens Work A's review of Chapter 2. Time the `create-untitled` response to the hint (a
   `fetch` wrapper and a `MutationObserver` on `[data-document-draft-hint]`); note `uptime`.
2. **A live document a draft edits.** Open it with no Work and from Work B: the hint. Open it in Work
   A: the Live chip only, no hint.
3. **After Discard** of Work A's draft (Work page, Discard all changes): the hint goes on this device
   at once, and on another device on focus or the catalog wake.
4. **A document no draft touches** shows no hint.
5. **Two drafts** edit one document: "2 drafts have changes to this", and Review lists both by label.

## Rename and cut while a review is open (browser)

1. **Rename a reviewed document** (#845). With a document's review routed, rename it from the
   sidebar. PASS: no "Maximum update depth" in the console, the sidebar stays open, and the review
   (its changes and the change bar) is intact under the new name.
2. **Cut a whole paragraph in a draft.** Select a paragraph's text and cut it. PASS: the red removal
   stays readable with no "Start writing..." placeholder over it, with the cursor in it and after a
   reload. A paragraph that is genuinely empty still shows the placeholder.

## History

- 2026-07-07: #151 combined quality-fixes probe (disposition lock, journey smoke) and
  h/quality-followups probe. Reports under the draft-simplify work item's quality-phase ledger in
  the docs repo.
- 2026-07-09: #151 draft-lifecycle wave: two independent probers found the ghost-tab blocker, the
  apply-side "Access lost" session cache and the mode-switch phantom count; re-probes verified all
  fixed. Probe A step 6 and the hint section came from those runs.
- 2026-10-14: K2 live run on the integrated diff-based-review train (build `eba4314d7`): review from
  a reply, Discard everywhere, Apply (immediate typing, override, one Work batch), offline reconnect
  and the late invisible write passed. Probe C step 3 (view handoff undo), Probe A step 6 and Probe E
  step 4 (route repair and unlisted dock reload) failed; the #838 idle 1005 closes reproduced. Evidence
  in the diff-based-review work item's `k2/` directory in the docs repo.
