# QA: draft-review runtime probes

Repeatable browser probes for the AI draft-review surface (DraftDock, bulk
dispositions, review-from-dock). Run them whenever a change touches draft
disposition state, the dock, or the review launcher — they catch the class of
bug that unit tests around React Query state miss: stale-row windows, silent
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

## Probe A — review-from-dock

Regression guard for #152 (server sent `contextPath: null`, making the dock's
Review verb a silent no-op).

1. Get the mock assistant to produce a draft on an existing document. Open the
   dock's Changes view.
2. The row must show the real document title, not a placeholder.
3. Click Review. PASS: the app navigates to the Context view for that document
   (`screen=context&scheme=manuscript&path=<doc path>` in the URL) and the
   inline review UI appears in the editor. FAIL: dock switches views but
   nothing else happens.
4. Repeat with a draft that creates a **new** document (write directive
   targeting a filename that doesn't exist). PASS: the dock row shows the
   `New` badge; the editor tab opens and inline review renders before Apply
   even though the document has no context-tree entry — the launcher
   synthesizes the tab from draft metadata ([#153]). The file tree must NOT
   show the new document until Apply (draft-only documents stay out of the
   live tree by design).
5. Dispose of the new-document draft both ways:
   - **Discard all**: the tab closes, the route repairs (URL must not keep
     pointing at the dead path), a reload must not restore it, and — the
     resurrection regression — after a LATER Apply of a different draft in
     the same work, the discarded document must never reappear in the tree.
   - **Apply all**: the tab stays open on live content with no
     "Access lost" toast, and the document appears in the tree within ~5s
     without a reload.

[#153]: https://github.com/haowjy/meridian-flow/issues/153

## Probe B — no verb re-enable window during dispositions

Regression guard for the pump-tail window (mutations dropped `isPending`
before the workDrafts refetch settled, re-enabling verbs against stale rows
for ~200ms).

1. Stage 2–3 drafts across documents.
2. Before clicking a bulk verb, install a watcher via `agent-browser eval`: a
   MutationObserver on the composer-strip verbs recording timestamped
   `disabled`-attribute transitions into `window.__verbLog`. Snapshot polling
   misses sub-second flickers; the observer doesn't.
3. Run Discard-all, then (with fresh drafts) Apply-all. PASS: one
   enabled→disabled transition at pump start, one disabled→enabled at the end,
   nothing in between. Any mid-pump enabled blip is the bug returning.
4. Single-card check: discard one card; its verb must stay disabled until the
   row reflects the new state. Apply remains available only as the document-level
   header command (`Apply all`), never on a card.

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
   It and `DraftReviewHeader` must never render simultaneously; the chip opens
   review mode (header strip above the breadcrumb), Back to live swaps back. A
   document with no pending draft shows no chip.
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
2. Open a draft-only review in two pages. Apply all in one.
   PASS: the other page leaves review in place within about a second and shows the
   document live. Repeat with Discard all: the other page closes the draft-only tab.
3. On a live No Work document opened from a copied URL (no `?work=`), click Review
   draft. PASS: one `replaceState`, no `pushState`.
4. With a review open, rename the document from the manuscript tree.
   PASS: exactly one history write for the new address.

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

## Probe G — deleted Work draft admission (#736)

Use `./mf` for the nonvisual commands (see [debugging](../debugging.md)).

1. From a draft-mode chat, stage an edit to an existing chapter and record the
   draft list and preview. Keep the Work Files tab open.
2. Delete the Work. GET its drafts list and preview, POST per-document Apply
   and Discard, and POST Apply all and Discard all. PASS: all refuse with 404 `Draft not found`.
3. Let a catalog wake refetch the deleted Work's drafts. PASS: no new toast or
   "Pending drafts couldn’t load" row. Other HTTP failures must still surface.
4. Restore the Work. PASS: restore answers 200 and listing shows the same
   pending item; preview still contains the pending text. The refused list
   must not have created any `drafts` or `document_branches` rows.
5. Archive the restored Work. PASS: list and preview remain readable, while
   draft mutations remain frozen. Work purge is a separate privileged path.

The DB regression is in `draft-tree.preview.db.test.ts`; it drives the route
cores and lifecycle services over the composed runtime. It also snapshots row
identities across the refused GET to detect accidental provisioning.
