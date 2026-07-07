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
   targeting a filename that doesn't exist). Name and Review-navigation must
   work pre-accept — draft-only documents get their `documents` row at write
   time, so the URI resolves before the manifest entry exists.

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
