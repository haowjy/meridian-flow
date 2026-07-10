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
   `New` badge; the editor tab opens and inline review renders pre-accept
   even though the document has no context-tree entry — the launcher
   synthesizes the tab from draft metadata ([#153]). The file tree must NOT
   show the new document until accept (draft-only documents stay out of the
   live tree by design).
5. Dispose of the new-document draft both ways:
   - **Discard all**: the tab closes, the route repairs (URL must not keep
     pointing at the dead path), a reload must not restore it, and — the
     resurrection regression — after a LATER accept of a different draft in
     the same work, the discarded document must never reappear in the tree.
   - **Apply all**: the tab stays open on live content with no
     "Access lost" toast, and the document appears in the tree within ~5s
     without a reload.

[#153]: https://github.com/haowjy/meridian-flow/issues/153

## Probe D — entry banner and tree freshness

1. On a live document with a pending overwrite draft, opened from the tree:
   PASS: the `DraftEntryBanner` strip renders below the toolbar ("AI changes
   ready for review" + Review). It and `DraftReviewHeader` must never render
   simultaneously; Review swaps banner → header, Back to live swaps back.
   A document with no pending draft shows no banner.
2. With the Manuscript tree mounted, have the agent write a new document in
   auto-apply mode. PASS: the tree shows the document within ~5s of turn end
   with no navigation or reload.
3. With the dock showing "No pending changes", the Draft → Auto-apply switch
   must not warn about phantom pending changes (and must be disabled until
   the drafts query has settled).

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
4. Single-card check: apply one card; its verb must stay disabled until the
   row reflects the new state.

## Probe C — disposition journey smoke

1. Accept a draft, undo the accept, reject a draft, undo the reject.
2. PASS: rows move pending → applied/discarded → back correctly, editor
   content tracks each step, persistence survives a reload (`pushed` /
   `discarded` states match what the UI showed), nothing is stuck pending, and
   the console stayed clean throughout.

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
