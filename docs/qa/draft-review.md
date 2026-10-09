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
   - **Discard all** from the Changes to review `…` menu: the tab closes,
     the route repairs (URL must not keep pointing at the dead path), a reload must not restore it, and — the
     resurrection regression — after a LATER Apply of a different draft in
     the same work, the discarded document must never reappear in the tree.
   - **Apply all** from the same menu: the tab stays open on live content with no
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
