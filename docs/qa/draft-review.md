# QA: draft-review runtime probes

Repeatable browser probes for the AI draft-review surface (DraftDock, bulk
dispositions, review from the Work page). Run them whenever a change touches draft
disposition state, the composer strip, the Work page's Changes to review, or
the review launcher. They catch bugs that unit tests around React Query state
miss: stale-row windows, silent
no-op verbs, stuck pending states.

Ownership and command contracts: [draft-review reference](../../apps/app/src/features/draft-review/.context/draft-review.md). The shared
`draft-command-executor.ts` admits commands; `EditorView` owns paint readiness,
not `useReviewRoomOwner`. `PresentedReviewScope` and
`usePresentedDraftReview` share the one presented-document review across Editor
and dock hosts.

## Environment

- Start a dev stack from the branch under test: `pnpm dev` in a tmux session
  (portless HTTPS — get URLs from `pnpm portless:list`, never probe raw ports).
- With no provider keys (or `MODEL_PROVIDER=mock`) the gateway runs an
  in-process mock. Its write directives make the assistant write to documents;
  syntax lives in
  `apps/server/server/domains/runtime/gateway/adapters/mock/write-directive.ts`.
- Drive the UI with `agent-browser` (snapshot → click by ref → re-snapshot).
  Browsing live with no `?work=`, there is no Version chip for another Work's draft; the open
  document's draft hint (below) says so instead. Use `?work=<the drafting Work>` for the chip.

Capture `agent-browser console` and `errors` at the end of every scenario —
  a clean console is part of every pass criterion below.

### Controlled failures and evidence

Create fixtures and read fresh live, draft and preview state with `./mf`; use the
browser for interaction, focus and layout. Every held/error step needs an owned
browser-page request interceptor or a supported fault-injection seam installed
**before** the action. Filter by the run's exact Work, document and request;
record the observed request before releasing or rejecting it deterministically.
A delay alone does not establish a pending window. Record the mechanism and
response order. If no suitable seam is available, mark the step blocked, not passed.
Never tamper with the shared dev DB or another run's mock queues.

The G8–9, H6–10 and I6–7 recipes replace presentation test matrices. They are
instructions, not executed passes. Record A–J on the merge candidate at both
specified shells before calling those substitutions verified. Evidence includes
commit, viewport, run-owned identities, request scope/order, screenshots, clean
console and fresh manuscript/draft readback. Read-only API success does not prove
writer interaction.

## Whole Apply observation/projection (mock stack)

Stage an existing-document proposal in an owned named Work. On the Work Files
page, intercept that Work's whole-Apply request before clicking Apply all
changes; hold its response. PASS: the file disappears immediately while the
server response is pending. Release the response, then read live with `./mf`:
the proposed text is present, with no file resurrection. Stage another proposal
on the same document and Work; it must reappear without reload, even when Apply
kept the same room generation.
Record exact request identity/order and browser errors, and stop only the stack
started for this run. The command-record regression complements this runtime
check by returning a generation-5 server row after Apply confirmation: the raw
list remains identical, the projected list is empty, and generation 6 reappears.

## Continued typing through per-change Discard

Stage two independent changes in an owned draft Work. Intercept its exact
per-change `/draft/discard` POST before clicking Discard. In the same browser
callback, focus another paragraph, move the native DOM selection there, and
insert text using native browser input. Do not set a ProseMirror selection to
hide a native-input race. While the request is held, check that both the DOM and
PM selection are at the end of the typed text, and read the draft with `./mf`.
Release the request; wait for its accepted response and the distinct successor
editor to be visible (not the inert paint copy), then wait 700 ms and insert
again without clicking or focusing. PASS: both insertions are contiguous in the
chosen paragraph, focus and selection remain there, the discarded change is
gone, the other proposal remains, and the live manuscript is unchanged.
Capture request/click/input/response times, pre/post selection and block text,
a screenshot and independent draft/live readbacks. An insertion sent while a
paint cover still holds the page is not evidence about the successor's caret.

## Review across document schemes

In a named draft-mode Work, use the mock model to create `kb://Place`,
edit an existing `kb://Hero`, and edit `manuscript://Chapter`. Check
the durable transcript with `./mf thread view` and the Work draft list:
every row has `contextLocation: { scheme, path }` with its own scheme.

Open each kb draft from the chat strip, the document's change list, and the
Work page. The Editor stays in Knowledge Base, shows the new draft as
draft-only (no live-file error), and admits inline review. Apply the new
document and read it back from `kb://`; Discard the existing-document edit
and verify its live text is unchanged. Review the Manuscript chapter too.
Repeat with two Works drafting the same new document: each transient tab
must retain its own Work and draft identity. Open A before B, then Discard B:
only B's tab closes. Reopen B and close its visible tab: A must remain. Apply B
while A stays pending: B's Work shows the live document, while A still shows its
own review. Rename the visible B representation and verify A is not selected or
closed by the metadata update. Reload a dock review with multiple same-document
draft-list rows: only the saved Work and draft may restore.

File policy alone chooses where drafts can exist. The review path imposes
no scheme whitelist; each row opens its own location.

## Rich-only paragraph changes (CLI and visual)

With this worktree's mock stack running, seed `## Scene` followed by
`The red gate opens.`. Create a named Work and a thread bound to it with
`aiWriteMode: "draft"` in the create body. Through `./mf thread send --mock`, read the document,
then replace its two blocks with `### Scene` and `The **red** gate opens.`.
Use tool `path` arguments, not the agent-edit core's internal `file` name.

Read the Work's drafts and the document preview through `./mf api`. PASS:
two selectable classes, one heading-level change and one bold change. Open the
Editor with that Work ID and draft ID; its change list uses the usual rows,
with localized `Heading 2 → 3` and `Bold on “red”` descriptions. Both blocks
are tinted, with no duplicate struck-through copy of their unchanged text.

Apply each class separately using fresh preview revision tokens, reading live
after each command. Only its exact rich effect reaches live; the other class
remains selectable. Stage the reverse formatting proposal, then Discard each
class separately. Live remains exactly unchanged and the other class survives
until its own Discard. Capture the previews, dispositions and readbacks, plus
the change-list screenshot and browser errors. Stop only this worktree's stack.

The per-change recipes below (tokens, closure classes, admission) belong to the review as it stands today; the
diff-based review rework (work item `diff-based-review`) replaces per-change review and these with it.

## Coherent review reads (CLI)

Stage two independent paragraph edits in a named Work. Save a preview and its
revision tokens with `./mf api`. Append another draft edit, then try a per-change
Apply using the saved tokens: PASS is `stale`, with no disposition of
the requested rows. Discard sends the saved `closureClassIds`, `admissionTokens`, `memberPartKeys` and revision
tokens (not operation IDs): an independent paragraph admission must not refuse it,
while changed evidence for the same class must return `stale`. A grown class
with surviving immutable members also returns `stale`, including after a re-fork;
a disappeared class or absent fallback-only class returns `gone`. Refresh
the preview after a refused command: the selected closed class alone settles. Repeat after another per-change Discard re-forks the
draft and after a row's status changes through Apply. A concurrent preview may
show either complete observation, never one generation's hunks with another's
rows/token. An unknown or closed draft returns `gone` without provisioning a
replacement. A corrupt preview never repairs or publishes document content.

The DB concurrency contract injects append, re-fork and status commits after
every awaited snapshot query and at read-port entry/return. Run it with
`DB_TEST_WORKERS=1 pnpm test:db apps/server/server/domains/collab/partial-apply.db.test.ts`.
It covers preview, Apply selection and Discard selection separately; the CLI
recipe remains a runtime check, not a claim that a DB suite drove the product.

## Probe A — review from the Work page

Regression guard for #152 (server sent no document location, making a draft
row's Review a silent no-op).

1. Get the mock assistant to produce a draft on an existing document. Open the
   Work page's Files tab ("Changes to review").
2. The row must show the real document title, not a placeholder.
3. Click the file's name. PASS: the app navigates to the Editor for that document
   (`/editor/manuscript/<path>?work=…&item=…` under the project URL) and the
   inline review UI appears in the editor. FAIL: nothing happens.
4. Repeat with a draft that creates a **new** document (write directive
   targeting a filename that doesn't exist). PASS: the Work page row shows the
   one change with Apply/Discard when expanded; the editor tab opens and inline review renders before Apply
   even though the document has no context-tree entry — the launcher
   synthesizes the tab from draft metadata ([#153]). The file tree must NOT
   show the new document until Apply (draft-only documents stay out of the
   live tree by design).
5. Dispose of the new-document draft both ways:
   - **Discard all changes** from the Changes to review `…` menu: the tab closes,
     the route repairs (URL must not keep pointing at the dead path), a reload must not restore it, and — the
     resurrection regression — after a LATER Apply of a different draft in
     the same work, the discarded document must never reappear in the tree.
   - **Apply all changes** from the same menu: the tab stays open on live content with no
     "Access lost" toast, and the document appears in the tree within ~5s
     without a reload.

[#153]: https://github.com/haowjy/meridian-flow/issues/153

## Probe B — no verb re-enable window during dispositions

Regression guard for the pump-tail window (mutations dropped `isPending`
before the workDrafts refetch settled, re-enabling verbs against stale rows
for ~200ms).

1. Stage 2–3 drafts across documents. Open the Work page's Files tab and the
   Changes to review `…` menu.
2. Before clicking a bulk verb, install a watcher via `agent-browser eval`: a
   MutationObserver on `document.body` (the menu is portalled), recording
   timestamped `disabled`, `aria-disabled` and `data-disabled` changes on review
   verbs, plus their state on insertion, into `window.__verbLog`. Reopen the menu
   during the command to
   inspect its verbs; a closed menu is not evidence of a lock. Snapshot polling
   misses sub-second flickers; the observer doesn't.
3. Run Discard all from that menu, then (with fresh drafts) Apply all. PASS:
   disposition verbs remain disabled through the command and its cache refresh,
   with no mid-command enabled blip. Repeat on the composer strip with its
   chat-scoped Apply and Discard: only that chat's changes disappear, and other
   pending changes in the same document remain (see Probe G).
4. Per-change Apply and Discard sit on every actionable row; a row's verbs stay
   disabled until its draft's command settles. Check both an expanded Work page
   file and the document's change list. Pending rows may disappear optimistically;
   surviving or refused rows must not re-enable while the command is running.

## Probe C — active-only disposition and recovery journey

1. Apply a draft on an existing document. PASS: its active row disappears,
   live content matches the whole current branch (including writer edits made
   after the last preview), and no closed draft receipt or per-card Undo
   appears.
2. Open a surviving peer mark and confirm it offers evidence/navigation only.
   Then run Undo and Redo from the producing turn's receipt. PASS: receipt
   reversal updates live content and its recovery state after a reload; the
   peer mark exposes no competing Restore command.
3. Create another draft and Discard it. PASS: its active row disappears,
   live content is unchanged, and no draft-level Undo receipt appears.
4. From two browser sessions, select the same draft-created document for
   review, then dispose it remotely:
   - remote Apply keeps the other session's tab and graduates it to live
     manuscript content;
   - remote Discard closes the other session's draft-only tab and repairs its
     route.
   PASS: neither case guesses from draft-list disappearance alone, nothing is
   stuck pending, and both consoles remain clean.

## Probe D — review chip and tree freshness

1. On a live document with a pending overwrite draft, opened from the tree:
   PASS: the `DraftReviewChip` renders in the identity bar ("Review draft").
   It and the in-review Draft chip are one control in two states and never
   render simultaneously; the chip opens review mode (the same row now carries
   the Draft chip, list button, stepper, Show changes, Discard and Apply, with
   the toolbar and prose not moving), Live version in its menu swaps back. A document with
   no pending draft shows no chip. On the phone shell (touch, 390px) the same
   chip sits in a row under the top bar.
2. With the Manuscript tree mounted, have the agent write a new document in
   auto-apply mode. PASS: the tree shows the document within ~5s of turn end
   with no navigation or reload.
3. With drafts pending, switch the chat to auto-apply through its controls
   queue (`./mf api POST /api/threads/$T/controls --data
   '{"id":"<uuid>","control":{"kind":"write_mode","mode":"direct"}}'`).
   PASS: the answer has a `turnId`, the Work's drafts list is unchanged, and
   the chat's next write lands live.

## Probe E — cold load and reload of a draft-only review

1. Leave a pending new-document draft unapplied. Open its review, copy the
   address (`/editor/manuscript/<name>.md?work=…&item=…`), and open it in a
   fresh tab, then reload. Run it at desktop width and as a phone (390px wide,
   coarse pointer).
   PASS: the document opens in review at the same URL with `?item=` kept,
   and no other document shows at any point. Record the history writes with a
   `history.replaceState` wrapper installed before first load: there must be
   none beyond the router's own startup write. FAIL: the address ends on
   another open document with `?item=` dropped (a tab at a path spelling the
   route does not match, or a phone host rejecting the route before the
   address admitted it).

## Probe F — copied No Work review address, remote disposition, history writes

1. Leave a pending new-document draft in No Work. Copy its review address
   (`…/editor/manuscript/<name>.md?work=&item=…`: the draft states its Work).
   Select a named Work in this browser, then open the copied address cold, at
   desktop width and as a phone.
   PASS: the same draft opens in review, `?item=` kept, no history write beyond the
   router's startup one. FAIL: `?item=` dropped or another document shown.
2. Open a draft-only review in two pages in a named Work. From the Work page
   Changes to review `…` menu, Apply all in one.
   PASS: the other page leaves review in place within about a second and shows the
   document live. Repeat with Discard all: the other page closes the draft-only tab.
3. On a live No Work document opened from a copied URL (no `?work=`), click Review
   draft. PASS: one `replaceState`, no `pushState`.
4. With a review open, rename the document from the manuscript tree.
   PASS: exactly one history write for the new address.

## Probe G — the chat-scoped composer strip

Use real chat writes, not synthetic database branches: selective Discard needs
individually addressable branch journal rows. Run at desktop width and on the
phone (390px, coarse pointer), recreating the fixture before each disposition.
Set it up with [`./mf`](../debugging.md), then use the browser only to exercise
and inspect the surfaces.

### Setup

1. Create a named Work in Draft mode and four chats bound to it: Pacing pass,
   Lore pass, Dialogue pass and Untouched. Seed two live manuscript files with
   `./mf doc put`: Chapter A with separate paragraphs "Alpha sword waits at
   dawn.", "Beta shield gleams at noon." and "Gamma waits at dusk."; Chapter B
   with "The spear rests by the door.". Use unique filenames per run.
2. Send a scripted mock turn from Pacing pass that reads Chapter A, then
   replaces `sword` with `blade`. Wait for completion. From Lore pass, read the
   same draft and replace `blade` with `sabre`, then in another turn read it and
   replace `shield` with `buckler`. From Lore pass, read Chapter B and replace
   `spear` with `pike`. Use `./mf thread send <thread> <message> --mock '<script>'`:
   each script has `steps` containing separate `read` and `write` tool calls
   with `args.path`, and the replacement's `command`, `find` and `content`.
3. From Dialogue pass, create a new manuscript document in a mock `write` turn
   (`command: "create"`, a fresh `path` and `content`). Send no writes from
   Untouched. Verify the Work's draft list and previews through `./mf api`:
   Chapter A must have a closure class with visible operations from both Pacing
   pass and Lore pass, plus Lore pass's separate shield change; Chapter B must
   belong to Lore pass alone. A fixture without the shared class cannot prove
   the tie behavior.

### Checks

1. Open Pacing pass. PASS: the strip shows Chapter A and only this chat's shared
   change, not Lore pass's separate shield change or Chapter B. Summary and
   controls share one line without notes. Counts appear once previews arrive,
   except narrow docks hide the count to keep the filename readable.
2. Click the single-document strip’s document name (Tab and Enter also work).
   PASS: the name opens review without toggling expansion, and there is no
   summary Review button. A failed review launch keeps that name available to
   retry; its error replaces the count, not the review door. The chevron and remaining summary area still toggle
   expansion. On phone, the name has a 44px touch target and commands remain
   visible without hover. The Editor opens on the shared change, while its marks,
   stepper and document list still show the whole document's changes. The shared
   focused bar names both chats (overflow names are in +N); each name opens that chat beside the review at its own
   producing turn (the chat sheet on the phone), without changing destination.
3. From a fresh fixture, Apply on Pacing pass's strip. PASS: the whole shared
   change reaches live (`sabre`), while `shield` and Chapter B's `spear` stay
   unchanged on live and Lore pass's remaining changes stay pending. Recreate
   and repeat with Discard: the shared change leaves both strips, live keeps
   `sword`, and Lore pass's separate changes remain. No command navigates.
4. Open Lore pass before disposition. PASS: the strip shows Chapter A and B;
   expanding groups this chat’s changes under one-line file headers. Each file
   name opens its own review, never an arbitrary first document. A new document
   (one whole-draft change) has one named review row with Discard and Apply,
   not a header followed by the same name. The Work page’s expanded file uses
   the same rule; its chevron still collapses it. A real single per-change
   edit keeps its file header and excerpt. The document popover and phone
   sheet already have no file header and show the same whole-document row. Each
   change uses the shared Work row with its own Apply/Discard. Single-file
   strips also expand. Discard asks "Discard this
   chat's changes?" with Keep and Discard. Keep does nothing; confirming takes
   only Lore pass's changes, including the shared class.
5. Open Dialogue pass. Once loaded, its new document is one change with Apply,
   Discard and Review. Apply publishes it; Discard removes it. Review opens it
   without publishing. Verify whole-command payloads from strip, row and bar.
6. Open Untouched. PASS: no strip, although the Work has pending changes. After
   Pacing pass's last change is handled, its strip also disappears, even while
   Lore pass's other changes remain.
7. No strip or document list offers a Work-page footer. Ordinary Work navigation
   still reaches Files and its Work-wide commands.

8. **First paint and generation.** Hold previews for a new-document-only chat. Before
   release, Apply/Discard remain disabled. Then stage an ordinary file beside it
   and hold that preview: commands stay unavailable
   until its authority is known. While a scripted mock turn is actively generating,
   attempt strip commands: no disposition request. Release the turn and previews;
   commands reflect actual actionable changes. Capture DOM mutations, not just the
   final screenshot.
9. **Retry and discard scope.** Fail one owned preview read. Its file shows Retry, not
   empty-success; retry restores it. With two files, Cancel/Keep in the strip's
   Discard confirmation sends nothing, then confirm and inspect both files'
   selections. With one remaining file, Discard sends immediately and affects only
   that file/chat. Verify foreign-chat live/draft content.

## Probe H — the document list on both shells

Use Probe G's run-scoped Work and two-document, two-chat fixture. This is a
visual probe: run at desktop 1280×900 and phone 390×844; do not infer layout
from CLI success. Record screenshots and the fresh API reads per action.

1. Open Chapter A live. Open its identity-row change-list button (phone sheet).
   PASS: only this document's changes appear, no Chapter B, no Work-wide bulk
   commands. Expand the version menu: only live and this Work's version, never
   another file. Review opens the first relevant change; it is read-only until
   the review room paints. Repeat with a new document: no live version is offered.
2. Open its review, then hide marks. PASS: the list remains reachable by keyboard
   (Tab and Enter); focus a row and it closes, focusing that change. Step both
   ways, including wrap. On desktop shrink the pane until the bar moves below
   the text, then widen; commands stay keyboard reachable and do not cover prose.
   On phone open the keyboard: the bar clears it and the home indicator. Measure
   44px command/stepper touch targets. Check shared-chat excerpt width and names;
   untitled chats still have a usable link. Do not use separator glyphs as copy.
3. Apply one row, recreate and Discard one row. PASS: the list stays open, the
   chosen class disappears immediately, live changes only on Apply; both preview
   tokens and all operation IDs of that class go in the Apply request. Discard
   sends class IDs, their clicked admission tokens and immutable member part keys,
   not operation IDs. Member keys classify refusals only, never authorize growth. Refusal restores
   that row with the server reason, not a false connection warning. Switch offline
   and click: it returns with a connection refusal, never dispatching on reconnect.
4. Handle the last change with the list open. PASS: the list closes; Applying or
   Discarding then No changes left appears only in the existing review/path row. A formatting-only draft says formatting remains, not finished.
   Next draft preserves sorted-file position; Back to live is offered when alone.
5. No Work-page link or success toast appears in either list. Phone sheet title
   says Changes without a count, and its list button has no count badge. Whole-draft Discard lives in the version menu and dispatches without
   an approval dialog. The list button remains usable while review enters/leaves and marks hide.

6. **Marks, rows and arrivals.** With list open, hide marks, step Previous/Next
   through wrap, and focus a row by keyboard: it closes and the selected change is
   focused. Reopen and command a row: it stays open and does not treat the command
   click as a focus-row click. Send a new AI change while watching: count grows, new
   row pulses once, pulse expires; type a writer edit and confirm it gets no
   AI-arrival pulse. Reopen the list during loading, pending, finished and
   formatting-only states: button remains reachable.
7. **Refusal language and toast.** Cause a typed known refusal on a row/bar; it is a
   refusal, not connection loss. Keep that stored refusal and switch language
   without another command request. PASS: its code is rendered in the current
   locale, using the catalog translation where present and English fallback for
   empty entries (most of the 中文 catalog is untranslated). To verify an empty
   entry, break in `RefusalReason` in `ReviewMessageText.tsx`: switching locale
   must re-render the same stored code and call `i18n._(known)` with the new
   `i18n.locale`, not reuse previously translated text. If the selected catalog
   entry is translated, compare its displayed words instead. For a run-scoped
   intercepted unknown refusal, preserve its server reason verbatim. Dismiss the
   failure/toast and check it leaves; transient
   success has no toast. API category correctness remains automated.
8. **Versions and held failure navigation.** On desktop and phone, open Live/Draft
   menus with another file and Work present: only this document's offered versions
   appear. Whole Apply immediately moves to the next sorted file; reject its answer
   after moving: failure identifies the original file and never pulls navigation back.
   Explicit Open goes to the failed file. Finish a middle file and use Next: it
   follows the removed file's former sorted position, wrapping; alone, Back to live.
   Repeat No Work: no Work-page footer. While command is held, menu commands cannot
   run again.
9. **Rename/new document/phone lifetime.** Desktop Rename closes the version menu
   before opening rename UI. On a draft-only review, no Live choice exists; Close
   review does not open a live room. On phone, enter/leave review and another document
   while watching editor identity, scroll and selection: no unrelated document header
   or remount-induced loss. Discard with the sheet open: the row leaves immediately
   without a success toast; the sheet closes when no changes remain. Close the sheet and use the version
   menu's whole Discard; it dispatches immediately and moves on without an approval
   dialog. Verify the manuscript editor survives both interactions and the keyboard
   does not intercept controls.
10. **Real bar placement and neutral display.** At desktop wide/narrow/scrolled pane
   sizes, resize repeatedly: bar moves margin ↔ block, does not cover or clip prose,
   and keyboard activation reaches actual commands. On phone open the keyboard; verify
   44px targets, home indicator clearance and scrim stacking. Inspect a shared class,
   writer-only edit and unattributed removal: only server-flagged merge artifacts get
   merged treatment; neutral removal stays visible without an invented author. Use
   screenshot plus fresh preview, not guessed geometry.

## Probe I — Work page commands and held failures

Continue with Probe G's fixture (recreate affected proposals between actions).

1. Open the named Work's Files tab. PASS: Changes to review lists files in stable
   name/id order; journal recency does not reorder them. Expand Chapter A: only
   its preview loads, a failure shows Retry on that file, never an empty-success
   list. A new document expands to one change with Apply/Discard dispatching whole
   commands. Formatting-only rows say Formatting changes remain. Finished files
   leave the group without a duplicate completion message.
2. Apply a change from an unopened Chapter B while Chapter A remains in review.
   PASS: no review room/navigation is opened for B, the command acts on B alone,
   A stays where it was. Repeat for a Work owned by neither current chat nor Editor:
   it acts in that Work, with no cross-Work preview or command. Inspect fresh live
   and draft reads through `./mf`; cached DOM alone cannot certify persistence.
3. Filter search so one file is hidden; the menu says Apply all changes and Discard all changes, without counts,
   and still handles every document of that Work. Recreate, Discard all changes:
   inline confirmation says "Discard all changes?" and explains that pending changes
   from every document in this Work are removed. Keep cancels
   without requests, then confirming handles all, with no navigation.
4. While a batch waits, navigate to another Work, then archive the original Work
   through its ordinary menu. PASS: requests already owned by the original batch
   finish in the original Work, controls lock; no new Work gets an old request and
   no answer navigates back. Make one file refuse: later files still run and its
   error remains on that file's row until an explicit next action/dismissal.
5. From a finished review, send a fresh proposal to the same document. PASS: review
   re-enters in place with the new generation and room, no old completion, even if
   the previous answer/list read lands late. Leave for another document and repeat:
   a late answer cannot reopen the previous review. Capture request/response order.

6. **Work capability and unresolved interval.** Visit Files when its Work matches Editor,
   matches Chat only, matches neither, and matches both. Command one run-owned change
   each time and verify exact Work/document authority in requests and fresh reads.
   Hold Work resolution: no actionable stale Work list appears. While a batch waits,
   switch Work then archive its original Work; later requests remain bound to the
   original Work, controls lock and late answers do not navigate back.
7. **Work failures and offline batch.** Fail an expanded preview, Retry successfully,
   then verify dispositions become available with the successful preview. From
   a Work with multiple files go offline and attempt whole
   Apply/Discard; each affected file reports its own failure, no successful completion
   or navigation. Reconnect and verify no queued command fires. Log both online
   signals before every click; see the offline-emulation artifact in
   [README.md](README.md). A transport failure while the app still believes it is
   online is not this case: the serial batch then attempts every draft, possibly
   after reconnect. For a held online
   batch, refuse one file: later files run, failed-file reason remains until explicit
   action/dismissal.
8. **Two-tab whole Discard with held writing.** Open one draft's review in tabs A and
   B. In A, hold outgoing Yjs frames and incoming acknowledgements at the native
   WebSocket (HTTP stays open), then type in surviving prose and inside an AI-added
   change. In B, Discard all changes from the Work page. Release A without navigating
   it and recheck after 30 s. PASS: A keeps the `draft` address and shows the next
   generation with the surviving words as a **You** change; the words typed inside
   the discarded change are absent; live is unchanged. Control with no held writing:
   A leaves review for live and drops the address.

## Probe J — chat links from Work rows and cold history

Use a change with two writing chats and retained tool calls. Capture its preview's
chat, turn and tool-call IDs before clicking. Run both shells.

1. From the Work page's expanded row click each chat link. PASS: the chat opens
   beside the Work screen (phone's chat sheet), the correct turn lands, no review
   opens and no change command runs. Repeat from the document list and strip review.
2. For an open Process fold, the exact writing tool row is the landing target.
   Close the fold after opening it once: hidden retained ToolRows must not become
   targets; the fold itself lands and stays closed. A missing tool-call ID falls
   back to its turn, not another tool or another chat. Capture fold state/target.
3. Start in a fresh browser profile or reload without loading that chat first.
   Click the Work row's link while history is still loading. PASS: the request is
   held until its turns reach the transcript store, then lands on the same turn;
   it never concludes "absent" from a settled-but-empty transcript. Repeat warm.
4. Rename one writing chat and refresh. PASS: shared-change links name each current
   chat and each goes to its own latest contributing turn; writer-only edits name
   no chat. Inspect the preview and transcript with `./mf` for attribution.

Evidence: record commit, provider, viewport, Work/doc/chat/turn IDs, screenshots,
network outcomes and fresh live/draft reads in the work directory. Cleanup only
run-created fixtures using the ordinary UI/API; never reset the shared dev DB or
clear another run's mock queue. These recipes are not a claim of execution.

## History

- 2026-07-07 — #151 combined quality-fixes probe (disposition lock, bulk pump
  2→1→terminal, journey smoke) and h/quality-followups probe (A/B/C above).
  Reports under the draft-simplify work item's quality-phase ledger in the
  docs repo.
- 2026-07-09 — #151 draft-lifecycle wave: two independent probers (opus +
  sol) found the ghost-tab blocker, the apply-side "Access lost" session
  cache, the mode-switch phantom count, and the manifest resurrection;
  re-probes verified all fixed. Probe A step 4–5 and Probe D added from
  those runs.


## Pane paint continuity (#713)

Observe `[data-paint-hold]`, `[data-paint-page][inert]`, the destination URL,
visible prose and review marks with a MutationObserver and animation-frame samples.
Use exact request interception for controlled pending/error windows, never sleeps.
Exercise cold and warm Next draft, another document's strip Review, Apply draft and
Discard draft moving on, room-read failure on desktop and phone, leaving to Chat
mid-hold, and ordinary document switches on both shells. Navigation must change
outside the hold immediately; no sampled frame may show uncovered blank prose or
live prose under review chrome, and the cover must never show a loading status
("Opening document…"); phone Discard draft moving on is the case that caught it. Failure releases to the destination's card. Verify
the status line announces the destination, focus returns to the pane, copied ids are
absent and the 10-second bound does not restart on another move. Scope the pane by
screen visibility: route/session acquisition temporarily deactivates input but
must not withdraw the painted frame from capture.

## Review follows its document (desktop)

From this worktree’s mock stack, seed one new-document draft and one draft over
an existing manuscript with `./mf`. For each, review in Editor, switch to Chat
and back: the dock retains marks, change bar and commands, and returning opens
the review’s Work/draft address. Only the presenting host renders review.

On Chat close the retained Editor tab, reload, and verify a dock-only review
returns without a live-body or error frame. Apply and Discard remotely from a
second tab, each twice in fresh Works; the dock promotes live or returns to Recent,
and reload preserves that result. Check no project boundary or maximum-depth
console error occurs when an empty active preview/reset arrives before the
settlement catalog. Hold that catalog read to widen the ordering, then release
it; list omission must not re-admit the unchanged dock address. Check dock Next draft
and auto-advance stay on Chat, Back to live survives reload, Close only closes
the dock, and collapse/expand retains review. For each Close variant, start with
the same review in an Editor tab, carry it to Chat, close the dock document (X)
or use Close review on a new-document draft / Live version on a manuscript,
then return immediately to Editor. Its tab, `draft` URL and marks survive;
reload on Editor restores that review. Reload on Chat after closing the dock
instead restores the native occupant (draft-only Editor overlays never persist).
Capture screenshots with
`page.screenshot()`, fresh API readback and console errors.

Also check three fences. On a Work screen, open a manuscript in the dock through
its path menu, open its review from the Draft chip, and reload on the same Work:
the review returns; leaving the Work closes it. In the Editor, keep a draft-only
review whose preview is gone open while a catalog refresh runs: the review and
its error destination stay (no Apply, no exit). After a remote Apply, the dock's
draft-only review is released to live.

An Apply right after Discard of a new document in the same Work can return 500
`manifest_membership_push left pending Yjs dependencies`
([#753](https://github.com/haowjy/meridian-flow/issues/753)). It is a server
authoring defect, not a review-follows-document failure: use a fresh Work for
Apply cases that follow a new-document Discard, and record the 500 if you hit it.

## Compact review checks

- Existing previews containing an incomplete class keep selective controls on
  complete classes. The incomplete row/bar has no commands or explanation;
  the strip skips it, while whole-header commands cover it.
- Document lists show excerpt and controls only. Work rows retain whole chat
  names at wide widths and hide attribution at narrow container widths.
- Focused bars never abbreviate a chat name. +N opens the remaining chat links,
  including their producing-turn targets. Check desktop and phone.
- With the 320px dock open, and at narrower editor widths, the bar and both
  commands stay within the manuscript pane (under-change placement when needed).
- A one-change review has a list button but no stepper.
- Before screenshot capture, assert the intended surface is visible, no
  Loading project text or Saved locally (offline) pill, and navigator.onLine.


### Narrow strip failures and confirmation

With one existing document, retain a failed Review launch or whole-draft command:
automatic expansion must leave exactly one visible error owner. Whole-draft rows
carry their own failures; selective rows must not hide an unrepresented draft error.
With multiple documents, Discard replaces the summary with its question and
Keep/Discard, rather than overlapping the filename/count. Probe 390px touch and a
320px dock (256px inner strip), including a long translated question: all controls
must remain inside the row with disjoint bounds and 44px touch targets. Hold a
whole-row Apply/Discard request: the change disappears immediately and returns
on refusal, without a navigation change.

## Writer restoration and generation handoff (#713)

- Have a chat create a paragraph with an alignment attribute and a bold span.
  Change its alignment as the writer, then Ctrl+Z. Delete the whole paragraph,
  then Ctrl+Z. After each restoration, reload the review and check exact text,
  formatting and alignment. Same-parent attribute Undo deliberately stays
  writer-authored because a manual equal-value re-set is indistinguishable;
  recreated rich paragraphs retain chat attribution only for directly proved
  restoration slots. Unproved formatted/text slots remain writer-authored.
  Do not use the chat receipt's Undo: this probes the writer's own Undo.
- For missing-anchor handoff, use the controlled real-Yjs regression rather
  than timing a browser race:
  `pnpm --filter @meridian/app test src/core/editor/branch-writer-handoff.test.ts`.
  Same-generation rebuilds retain wholly/partly pending carries until late
  anchors arrive. A synced newer generation retires its source: rescue unrelated
  typing whose own anchors survive under a fresh client, drop the unanchorable
  remainder, report loss once, and release room ownership after rescue ack.
  The source AI text must never reappear. Cover whole loss, mixed rescue/loss,
  rich writer-created nodes with tombstones, and transient recovery.
- On both desktop and phone, check that the short loss sentence appears on the
  affected document, not another tab or a global toast. Leave review and return:
  the notice remains until dismissed, and dismissal does not undo rescued text.
- Run the certification and forged-claim controls with
  `pnpm --filter @meridian/server test server/domains/collab/domain/writer-restoration.test.ts`.
  This verifies cold attribution replay as well as complete attribute and rich
  paragraph aliases; it is not browser interaction evidence.

## Response replay after repeated Discards

These are server-seam integrity checks, not browser remount verification. Use an
owned database and the production preview/selection API. Record exact paragraphs
and every staged result's settlement ID, not only its grouped `wN` handle.

- Stage `green → lime` over pending `gold / azure / green`. Discard gold,
  write `red → pink` in the new generation, and read from the open reply.
  Discard pink, read again and save. Both reads succeed; the saved draft is
  exactly `red / azure / lime`.
- Stage only `gold → bronze`. Discard gold, read (its write drops), then
  Discard azure. Read and save still succeed, with a failed bronze receipt
  and exactly `red / blue / green`.
- Stage `gold → gild`, `gild → bronze` and independent `green → lime`.
  Discard gold and refuse the next Work-draft `commitBranchMutation` once
  through that existing test port. Restore it and retry. Both rejected
  settlement IDs remain, lime commits, and the draft is `red / azure / lime`.
- In that grouped-handle reply, the next tool names the document and handle
  once, says **part** of the handle was dropped, and identifies both rejected
  text changes. With no surviving sibling it says all staged writes for that
  handle were dropped. A subsequent tool does not repeat the notice.

The parameterized Postgres regression exercises those same production seams:

```bash
DB_TEST_WORKERS=1 pnpm test:db -- \
  apps/server/server/domains/collab/adapters/drizzle-document-edits.db.test.ts
```

### Ordinary concurrent response replay

Use the real-Yjs replay regressions for deterministic scheduling (no app stack
or database required):

```bash
taskset -c 0-7 pnpm exec vitest run \
  apps/server/server/domains/collab/domain/branch-response-replay.test.ts
```

- Two chats plan on `Alpha Beta.`. Commit A's `Beta → Gamma`, then replay B's
  staged `Beta → Delta`. Both replacement insertions remain, exactly as direct
  Yjs integration orders them. B is not refused or described as discarded.
- Stage `Beta → Delta`, then have the writer delete `Beta` normally before
  response save. The draft becomes `Alpha Delta.`. Repeat with retained
  generation-history evidence: a tombstone from ordinary deletion is not a
  physically retired identity.
- Discard still drops the whole touching write and its dependents while keeping
  independent writes. Undo still drops a staged write into undone text. Their
  notices and failed receipts identify Discard or the inverse, respectively.

The existing durable card-Undo protection uses the public response host:

```bash
DB_TEST_WORKERS=1 pnpm test:db -- \
  apps/server/server/domains/collab/inverse-placement.db.test.ts
```

These checks are automated replay and database evidence, not live-app or
browser verification.

### Long-history inverse measurements (on demand)

The package test retains one 200-edit, 4,000-word correctness round. The 15-round
warm/cold timing workload is deliberately outside the automated gate. Run the
[performance recipe][undo-perf] from the `drr-undo` checkout with `pnpm exec tsx`.
Its imports name that owned checkout; adjust them when measuring another one.
Keep its four min/median/max series, revision and machine/load context with the
work evidence. It uses real Yjs and a cold encoding for every cold round, no
caches and no timing assertion. Do not count it as browser or live-app evidence.

[undo-perf]: https://github.com/haowjy/meridian-flow-docs/blob/main/work/draft-review-repair/undo-step1-fix7-evidence/long-history-perf.ts

## Receipt card inverses (Draft mode)

Use only your own stack. Start `MODEL_PROVIDER=mock pnpm dev`, discover routes
with `pnpm portless:list`, and use `./mf` for fixtures and API actions. Do not
reuse another worktree's project, database, thread or browser session.

1. Create a Work and a draft-mode thread. Seed two manuscript
   documents using `./mf doc put`: `Seed.` and `Alpha Beta.`. Use a scripted
   mock read/write/text reply for each fixture, not free-form generated prose:
   insert `Added once.` in the first; replace `Beta` with `Gamma` in the second.
2. Each card says **Edited 1 document**, including in Draft mode. Its pending
   document row remains visible beside any settled excerpts. Read the turn's
   live-lineage endpoint to resolve its receipt state.
3. For each turn, POST its context/reverse endpoint with
   `{"scope":"turn","target":"<turn UUID>","direction":"undo"}`, then
   `redo`, `undo`, `redo`. Require `acceptedParts: 1` and no skips on every
   action. Draft reads alternate exactly between the seeded and edited text;
   live reads remain seeded until Apply. There must be one addition, not two.
4. Apply that document's draft via
   `POST /api/projects/<project>/works/<work>/documents/<document>/draft/apply`
   with `{"draftId":"<draft ID>","itemKey":"<item key>","commandId":"<uuid>"}`. Read via `./mf doc read <URI> --json`.
   Assert the entire `content` value, including terminal newlines:
   insertion `"Seed.\n\nAdded once.\n"`; replacement `"Alpha Gamma.\n"`.
5. For named partial skips, script a turn inserting `One addition.` and
   `Two addition.` into separate documents seeded `One seed.` / `Two seed.`.
   Discard the second document's draft. Its card still offers Undo, names
   `Two addition.` as **discarded**, and says **1 part stayed**. Undo must
   accept only the first part. Discard the first draft too: the card says
   **Can't undo**, with the named reasons. Never call skipped parts “changes”.
6. Capture Undo, Redo, partial-skip and Can't undo cards at desktop and 390px
   widths using `page.screenshot()`. Open the receipt disclosure. Check text
   wrapping, reachable buttons and page errors. Hold the reverse request:
   **Undoing…** / **Redoing…** appears immediately. A refusal remains on that
   card, without a success screen or a global toast.

The durable PostgreSQL matrix adds split placement, overlapping parts in one
view, branch-keyed restoration holds and release, typing inside restored text,
selective Discard of an inverse, staged-response dependency drops, per-response
rollback and checkpoint failure after root commit. Run it with:

```bash
DB_TEST_WORKERS=1 pnpm test:db -- \
  apps/server/server/domains/collab/turn-inverse.db.test.ts \
  apps/server/server/domains/collab/response-rollback.db.test.ts \
  apps/server/server/domains/collab/response-transaction-atomicity.db.test.ts
```

A checkpoint failure is post-commit maintenance, not a failed response: the
save still returns committed, its durable text remains, and it creates no
rollback inverse. Verify both draft-only and mixed live/draft responses.

For retained dev documents, do not reset the local database. Cold-load a pre-v2
snapshot with the old provenance array, edit it, and certify a restored range.
The old facts stay unread; new facts live in the target-keyed v2 map. Two
fact-carrying writes in separate paragraphs must produce two review classes,
and replaying either class alone must leave the other paragraph unchanged.
Every inverse row must own its metadata client and have no map-entry anchors
into another inverse row.

### Receipt hold and publication regression checks

- Apply turn A's `Beta → Gamma`. In the same draft, turn B replaces
  `Blue → Silver`, then Undo B restores `Blue`. Undo A and Redo A must
  report a **live** destination and change live exactly to
  `Alpha Beta.\n\nBlue.\n` and `Alpha Gamma.\n\nBlue.\n`.
  B's unrelated hold must not choose A's destination. Apply leaves the latter
  text unchanged, with no extra restored copy.
- For mixed applied/pending parts, use the card's Undo button. The card says
  **Undone in your draft. Apply it to change your manuscript.** beside its
  outcome, not in a toast. The live manuscript remains unchanged until Apply.
- Connect a live Yjs room before acting on a document with no active draft.
  Keep the connection and its local replica open through Undo and Redo. Drive
  actions with `./mf`; inspect only that replica between actions, never a
  document read, reopen or reconnect that could repair a missing publication.
  The replica must receive each committed inverse. The DB room regression
  also injects immediate-live failed-response rollback into that same schedule.
- Extend the long-history correctness case with a 10,000-character deletion
  through eight Undo/Redo cycles. The on-demand
  [hold preparation probe][receipt-hold-perf] measures the actual receipt service
  after those 17 history rows, using fresh invocation-local indices. Record host
  load with wall time; under ordinary load the receipt read should remain well
  below one second. This is a service measurement, not browser evidence.

[receipt-hold-perf]: https://github.com/haowjy/meridian-flow-docs/blob/main/work/draft-review-repair/undo-step2-evidence/r4/holds-probe.mts
## Terminal trail recovery

Use an owned thread and Work draft. Let its producing assistant turn finish,
then wait for the empty trail to settle while the edit remains unapplied.
Apply the draft, repeat with another edit and Discard, and read the trail through
`./mf api GET /api/threads/<thread-id>/change-trails`. Each late disposition
must reopen the producing trail and settle at a higher version. Unapplied drafts
must not publish themselves. An empty or failed assistant turn must also settle.

For the commit-to-worker crash window, use the PostgreSQL lifecycle suite:

```bash
DB_TEST_WORKERS=1 pnpm test:db -- apps/server/server/domains/collab/change-trail-lifecycle.db.test.ts apps/server/server/domains/collab/adapters/drizzle-trail-signals.db.test.ts
```

Its restart checks commit before constructing a fresh aggregate adapter on a
separate connection. Receipt and placement rollback must leave the signal log
unchanged; committed invalidation must survive destroying warm state. A lower
sequence committed after consumption must remain discoverable, and failed
consumption must restore the signals with the shell and outbox. Pending
live publication must delay settlement. These are DB integration checks, not a
claim that this manual writer workflow passed.

## Model Undo and Redo counts

On an owned mock-model stack, seed `manuscript://CountTwo` with two paragraphs:
`Alpha sword waits.` and `Beta shield gleams.` Use `./mf thread send --mock`
to read the file and issue two independent `write replace` calls, changing
`sword` to `blade` and `shield` to `buckler`. Verify each completed reply with
`./mf thread view --full`, not only the send command's streamed result.

1. Send `write` with `command: "undo", count: 2`. Both original paragraphs
   return, and the result names `undone: w2, w1`.
2. Send `write` with `command: "redo", count: 3`. It refuses with
   `insufficient_redo`, names the two available edits, and leaves text unchanged.
   In Chat, this row says **Couldn't redo**, not **Redid**.
3. Send `write` with `command: "redo", count: 2`. Both replacements return,
   with `redone: w1, w2`. The successful Chat row says **Redid**.
4. Undo both again, then send two individual Redo calls. The first restores
   `blade` only; the second restores `buckler`. Check exact paragraphs with
   `./mf doc read` after every call. Repeat in Draft mode using its draft read.

The DB model-inverse matrix also checks all-or-nothing shortage for Undo and
failed-scope rollback of both single-edit Undo actions, in Live and Draft.

## Discard while the writer keeps typing

Stage `sword → sabre` in Alpha and `shield → buckler` in Beta, with an unchanged
Gamma paragraph, in a named draft-mode Work. In the browser open review and
install an interceptor scoped to this document's `/draft/discard` POST before
clicking Alpha's Discard. Hold that request until the writer's Gamma edit is
durably visible in a fresh preview. Click Discard and insert Gamma text within
200 ms, then keep typing Gamma while the request is pending. Release the request.
PASS: the first command returns `discarded`, Alpha reads `sword`, Beta still reads
`buckler`, every Gamma word survives, and no “Check it and discard again” notice
appears. Read the draft independently with `./mf api` and live with `./mf doc read`.
Capture request body/response, typing timestamps, preview class membership,
screenshot and browser errors. Repeat with typing inside the AI-inserted word:
PASS: refusal remains attached to the moved class and all writer text survives.

## Model history inspection cost

Run the [counted production-policy probe][model-inspection-probe] against the
owned checkout, first at the base and then after the change. Bundle its actual
`model-inverse-policy`, `inverse-actions` and forward-inverse implementation;
instrument prepared `classify` calls as well as the standalone API so changing
the seam cannot hide work. Keep artifacts in the work directory, never source.
No app or database is needed: the probe uses real Yjs and an in-memory host port.

For a 20-entry page with 20 parts per entry and 2,000 retained parts, expect
one full lineage build, one effective-action index, and 400 part classifications
in one batch when all entries share a view. Display, revert eligibility and Undo
eligibility must reuse those classifications. Rollback membership must scan
history once, not once per part. Compare plain (uninstrumented) timings separately
and compare every result's status and exact history message with the base.
Retain undone, redone, rolled-back, older-page and invalid-cursor cases.

The existing model-inverse count matrix checks scratch advancement in Live and
Draft, including counted Redo, overlapping edits and atomic shortage. Run it
alongside the inverse action/hold/rollback matrices; performance counts alone
do not prove the next scratch step sees its own writes.

[model-inspection-probe]: https://github.com/haowjy/meridian-flow-docs/blob/main/work/draft-review-repair/r2-inspect-evidence/build-probe.cjs

## Whole Discard isolation across Works

In two draft-mode Works, create drafts of the same manuscript chapter. Stage an
independent edit to that chapter in each chat while their replies are still open.
Discard the chapter draft in Work A (repeat through Work **Discard all changes**).
Work B's reply must finish and its edit must appear in B's draft, not in live.
A's staged chapter edit must not reappear; a later edit in A starts from the reset
draft. A reply's staged edits to other documents must still finish.

The repeatable service-seam check is
`DB_TEST_WORKERS=1 pnpm test:db apps/server/server/domains/collab/adapters/response-helper-revocation.db.test.ts`.
It also checks that retirement waits for transaction commit and closes only A's
peer room. It also gates retirement after commit, evicts the old reply entry as
a refusal would, and stages a fresh peer's write in the same open reply before
releasing that gate; the fresh write and room must survive. This is DB integration evidence, not a browser or live-runtime probe.


## Same class, changed Discard meaning

With live `Alpha Beta.`, stage `Beta → Gamma` and capture the preview and
selective Discard request. Before sending it, delete `mm` in the draft, leaving
`Alpha Gaa.`. The visible operation and stable class ID stay the same, but its
closed rows grow and its admission token changes. The held request must return
`stale`, retaining `Alpha Gaa.` and unchanged live. If a stale retry or queued
click reads that changed token, it must refuse rather than send fresh evidence
for the old click. Independent typing in another change still admits.

DB evidence: `collab/review-disposition.db.test.ts` exercises deletion and
independent typing through the durable coordinator. Queue/retry evidence:
`client/query/draft-command-executor.test.tsx` includes changed-effect evidence
with unchanged stable keys. These are integration/adapter checks, not browser
smoke verification.

## Review commands against a replying model (browser, mock stack)

The strip's and the Work page's Apply all and Discard all while a reply is still writing. Use a draft-mode chat in a
Work (`aiWriteMode: "draft"` at thread creation) and an owned project, and drive both pages in `agent-browser` (desktop
1440x900). `./mf` only sets up the Work, a thread bound to it and the scripted turns, and reads durable state (`doc
read`, the drafts list, `thread view`) after each click. Per-change controls on the rows stay locked while a reply
streams; this recipe does not cover them.

**Holding a reply mid-write.** A reply saves once per model response, after all of that response's tools have
run, so the mock's `delayMs` (which delays the model, not the tools) cannot hold it. Send one response with 120 to
300 chained `replace` calls on one document (each `find` is the previous `content`) with `./mf thread send
--no-wait`, and click about one second later. An earlier turn must already have saved a draft edit to the document, so
it is listed.

1. **Strip Discard during the reply.** Open the Work's chat. While the reply runs, click Discard on the strip and
   confirm. PASS: one request goes out and the strip's list empties. Live text is unchanged, and the later writes fail.
   The expanded failed row reads "You discarded the text it edited, so the change wasn't kept. The AI will read it
   again." Not the old "This change was updated. Check it and discard again."
2. **Strip Apply during the reply.** Same setup, click Apply. PASS: live shows the text saved before the click. The
   reply finishes and the strip lists the late writes ("1 change", Discard, Apply) for the next review.
3. **Work page Apply all during the reply.** Work page, Files tab, "All changes" menu, Apply all changes. PASS: live
   has the text saved before the click, and the document is still under Changes to review for the late writes.
4. **Work page Discard all during the reply.** The same menu, Discard all changes, confirm (at 390x844 too: the question
   and both buttons stay on screen). PASS: the list is empty, live is unchanged, the in-flight writes fail "You discarded
   this draft, so the change wasn't kept. The AI will read it again.", and a later write lands in a new draft.
5. **Live-edit staleness.** Not covered here: an Apply with tokens from before a live edit refuses as `stale`, tested
   by the DB suite (`draft-tree.apply-staleness.db.test.ts`).

Capture `agent-browser console` and `errors` at the end of each: clean is part of the pass. The API-level answers
(`commandId` resend, conflict, unknown, `whole_item`, `cant_undo_elsewhere`) are covered by tests, not by this recipe.

## Cold-open waterfall and the ahead-link chip (browser)

Open a drafted document's review cold: a fresh `agent-browser` session with the auth state loaded, then `open` the
review URL (`/editor/<scheme>/<name>?work=<workId>&item=<draftId>:<documentId>`). Wrap `fetch` and `WebSocket` in an
init script, enlarge the Resource Timing buffer (Vite loads hundreds of modules), and watch for the first appearance
of the draft's text in `document.body.innerText`. Record, ordered by start time: the address admission request
(`reviewWorkId` and `itemKey` in its query), the draft preview request, the `/ws/yjs` connect and open, and the first
text. PASS is the request order and the total from the address request to first text, not a threshold: say whether
the three run as a serial chain.

For the link chip, record every change of `data-link-chip` and `aria-description` on `a[data-meridian-link]` with
`performance.now()` from the chip's first insertion, on a cold load, a load with `?work=`, in-app navigation, and with
the `links/resolve` response held by an owned fetch seam. A live chapter holding an `ahead:` link to a document that
exists only in a draft must settle on the "in a draft" state without reading "Doesn't exist yet" on the way.


## A writer's New file joins the draft's document (browser, #757)

A draft's new document is a real document with a draft, hidden live only because it is a
draft. Making it live (New file, a link's Create, the AI) unhides it, and it stays one document
with an ordinary draft over it. The device's instant create carries its destination, so the
server joins the document waiting there. The only device work is identity: the reservation's id
becomes the joined id, and what the writer typed is kept. No draft text is merged; the draft's
text stays in the draft for review.

Setup (own stack, `MODEL_PROVIDER=mock pnpm dev`): `./mf api` to create a Work with
`aiWriteMode: "draft"` and a thread bound to it. `./mf thread send <thread> go --mock @script`
with one scripted `write create` of `manuscript://Chapter 2` (give it text). Desktop 1440x900,
then the phone 390x844 with touch emulation.

1. **Online.** Open the project. Sidebar, Manuscript, New file, `Chapter 2`, Enter, and type a
   line at once.
   PASS: one `Chapter 2` row and one tab, on the draft's document (same id as the Work's draft
   item, read with `./mf api`); the typed line is kept; the Work's review item is an edit, not
   new. As soon as the create's answer lands, with no reload or navigation, the open document
   shows the "Live" chip with the version menu, and Draft opens that draft's review. Measure
   from the `create-untitled` response to the chip appearing. Check it inside the drafting
   Work's chat and browsing live with no Work. Database: one `documents` row at that path
   (`psql`, `hidden = false`).
2. **Offline.** `agent-browser set offline on` before New file; New file `Chapter 2`, type a
   line, set offline off. PASS: the same as step 1 once the connection returns; before it, the
   row sits at `Chapter 2` in the Manuscript, not under Unfiled.
3. **A rename while the create is out.** Offline, New file `Chapter 2`, rename it
   `Chapter 2b`, reconnect. PASS: one row `Chapter 2b` on the draft's document; the rename is
   not offered for repair.
4. **A link's Create.** The Create button exists only on a link that reads "doesn't exist yet", and
   following an "In a draft" link opens the review instead. So make the link in the editor (select
   text, Link, destination `manuscript://Chapter 10`), open it so its "Create" dialog is up, have
   the AI draft `Chapter 10` in the Work, then press Create. PASS: the same as step 1.
5. **No regression.** New file at a free name, and at a name a visible document holds (the
   second takes the free name, `Chapter 2 (2)`).

With no `?work=` the document shows the draft hint instead of the Live chip (see the next section).

Capture `agent-browser console` and `errors` at the end of each: clean is part of the pass.

## An open document says when a draft has changes to it (browser, #757)

`GET /api/projects/:p/documents/:d/drafts` answers the active drafts in the project with changes to the
document (`draftId`, `itemKey`, `label`, `originWorkId`), the same membership as the Work page's Changes to
review. The editor shows a line under the identity row for every draft other than the one the view works
in: "A draft has changes to this (Northern Arc)" with Review, or "2 drafts have changes to this" with a
menu. Setup as in the join recipe, plus a second named Work in draft mode. Desktop 1440x900, check 1 also
at 390x844.

1. **The owner's flow, in No Work.** The AI drafts `manuscript://Chapter 2` in Work A. With no Work open,
   New file `Chapter 2`. PASS: one row, and the hint naming Work A appears with no reload; Review opens
   Work A's review of Chapter 2. Time the `create-untitled` response to the hint (a `fetch` wrapper and a
   `MutationObserver` on `[data-document-draft-hint]`); note `uptime`.
2. **A live document a draft edits.** Open it with no Work and from Work B: the hint. Open it in Work A: the
   Live chip only, no hint.
3. **After Discard** of Work A's draft (Work page, Discard all changes): the hint goes on this device at
   once, and on another device on focus or the catalog wake.
4. **A document no draft touches** shows no hint.
5. **Two drafts** edit one document: "2 drafts have changes to this", and Review lists both by label.
