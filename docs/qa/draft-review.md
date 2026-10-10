# QA: draft-review runtime probes

Repeatable browser probes for the AI draft-review surface (DraftDock, bulk
dispositions, review from the Work page). Run them whenever a change touches draft
disposition state, the composer strip, the Work page's Changes to review, or
the review launcher. They catch bugs that unit tests around React Query state
miss: stale-row windows, silent
no-op verbs, stuck pending states.

## Environment

- Start a dev stack from the branch under test: `pnpm dev` in a tmux session
  (portless HTTPS — get URLs from `pnpm portless:list`, never probe raw ports).
- With no provider keys (or `MODEL_PROVIDER=mock`) the gateway runs an
  in-process mock. Its write directives make the assistant write to documents;
  syntax lives in
  `apps/server/server/domains/runtime/gateway/adapters/mock/write-directive.ts`.
- Drive the UI with `agent-browser` (snapshot → click by ref → re-snapshot).
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

## Probe A — review from the Work page

Regression guard for #152 (server sent `contextPath: null`, making a draft
row's Review a silent no-op).

1. Get the mock assistant to produce a draft on an existing document. Open the
   Work page's Files tab ("Changes to review").
2. The row must show the real document title, not a placeholder.
3. Click the file's name. PASS: the app navigates to the Editor for that document
   (`/editor/manuscript/<path>?work=…&draft=…` under the project URL) and the
   inline review UI appears in the editor. FAIL: nothing happens.
4. Repeat with a draft that creates a **new** document (write directive
   targeting a filename that doesn't exist). PASS: the Work page row shows the
   `New` badge; the editor tab opens and inline review renders before Apply
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
3. With the Work holding no pending changes (no strip, no Changes to review
   group), the Draft → Auto-apply switch
   must not warn about phantom pending changes (and must be disabled until
   the drafts query has settled).

## Probe E — cold load and reload of a draft-only review

1. Leave a pending new-document draft unapplied. Open its review, copy the
   address (`/editor/manuscript/<name>.md?work=…&draft=…`), and open it in a
   fresh tab, then reload. Run it at desktop width and as a phone (390px wide,
   coarse pointer).
   PASS: the document opens in review at the same URL with `?draft=` kept,
   and no other document shows at any point. Record the history writes with a
   `history.replaceState` wrapper installed before first load: there must be
   none beyond the router's own startup write. FAIL: the address ends on
   another open document with `?draft=` dropped (a tab at a path spelling the
   route does not match, or a phone host rejecting the route before the
   address admitted it).

## Probe F — copied No Work review address, remote disposition, history writes

1. Leave a pending new-document draft in No Work. Copy its review address
   (`…/editor/manuscript/<name>.md?work=&draft=…`: the draft states its Work).
   Select a named Work in this browser, then open the copied address cold, at
   desktop width and as a phone.
   PASS: the same draft opens in review, `?draft=` kept, no history write beyond the
   router's startup one. FAIL: `?draft=` dropped or another document shown.
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
   change, not Lore pass's separate shield change or Chapter B. The tie note
   names Lore pass and says Apply and Discard take both, above the commands
   whether collapsed or expanded. Counts appear only once previews arrive.
2. Choose Review. PASS: the Editor opens on the shared change, while its marks,
   stepper and document list still show the whole document's changes. The shared
   row names both chats; each name opens that chat beside the review at its own
   producing turn (the chat sheet on the phone), without changing destination.
3. From a fresh fixture, Apply on Pacing pass's strip. PASS: the whole shared
   change reaches live (`sabre`), while `shield` and Chapter B's `spear` stay
   unchanged on live and Lore pass's remaining changes stay pending. Recreate
   and repeat with Discard: the shared change leaves both strips, live keeps
   `sword`, and Lore pass's separate changes remain. No command navigates.
4. Open Lore pass before disposition. PASS: the strip shows Chapter A and B;
   expanding reveals each file's count and notes. Discard asks "Discard this
   chat's changes?" with Keep and Discard. Keep does nothing; confirming takes
   only Lore pass's changes, including the shared class warned about in its note.
5. Open Dialogue pass. Once the preview has loaded, PASS: the new-document note
   says to review it to apply, and the strip offers Review only, no Apply or
   Discard. Review opens the draft-only document without publishing it.
6. Open Untouched. PASS: no strip, although the Work has pending changes. After
   Pacing pass's last change is handled, its strip also disappears, even while
   Lore pass's other changes remain.
7. From a populated strip, click "All changes in <Work>" (expand a multi-file
   strip first). PASS: one navigation opens that Work's Files tab, with the
   Work-wide Changes to review group. The document list's footer goes to the
   same destination. Repeat in No Work: its own chat strip and document list
   still work, but neither offers a Work-wide footer or list.

8. **First paint and generation.** Hold previews for a new-document-only chat. Before
   release, only Review is offered; no selective Apply/Discard flashes. Then stage an
   ordinary file beside it and hold that preview: selective commands stay unavailable
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
visual probe: run at desktop 1280×900 and phone 393×852; do not infer layout
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
   tokens and all operation IDs of that class go in the request. Refusal restores
   that row with the server reason, not a false connection warning. Switch offline
   and click: it returns with a connection refusal, never dispatching on reconnect.
4. Keep the list open while its last change completes. PASS: pending says Applying
   or Discarding, never prematurely No changes left; confirmed close holds the
   finished state. A formatting-only draft says formatting remains, not finished.
   Next draft preserves sorted-file position; Back to live is offered when alone.
5. Click "All changes in <Work>" at the foot. PASS: one navigation opens that Work's
   Files tab and closes the list. Repeat in No Work: no Work-page link exists.
   On phone the row command's confirmation toast is inside the sheet, not under
   its scrim. Whole-draft Discard lives in the version menu and dispatches without
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
   success toast has no Undo and expires. API category correctness remains automated.
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
   or remount-induced loss. Discard a row with the sheet open: its confirmation toast
   appears inside the sheet, above the scrim. Close the sheet and use the version
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
   list. With a new-document-only proposal, the row offers Review, not selective
   Apply. Formatting-only rows explain why whole-document commands remain.
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

6. **Scope choices and no-scope interval.** Visit Files when its Work matches Editor,
   matches Chat only, matches neither, and matches both. Command one run-owned change
   each time and verify exact Work/document authority in requests and fresh reads.
   Hold scope resolution: no actionable stale Work list appears. While a batch waits,
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
