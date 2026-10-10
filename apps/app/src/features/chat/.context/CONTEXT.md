# features/chat — Context map

This directory's durable contracts are split by concern so turn rendering and
draft-control changes can be understood independently.

- [Turn composition](turn-composition.md) — the process/text/artifact render
  model, tool kinds, tool rendering, and positional keys.
- [Activity row anatomy](activity-row-anatomy.md) — document names as doors,
  the stretched-button row, command glyphs, verb vocabulary, and why row
  chrome carries no colour of its own.
- [Turn rhythm and actions](turn-rhythm-and-actions.md) — the spacing scale,
  which turns are finished, the Copy/Info/Debug row, and control placement on
  rows and cards.
- [Tool expands](tool-expands.md) — the three rendering tiers, the three
  channels, what each expand shows, and how a clipped expand states its bound.
- [Turn edit receipts](turn-edit-receipts.md) — committed change records, Undo/Redo,
  and conversation reveal.
- [Composer write mode](composer-write-mode.md) — the Work-scoped Draft /
  Auto-apply control, neutral shared presentation, New-chat and chat-detail adapters, and
  composer sizing.
- [Draft review](draft-review.md) — inline review session, pending projection,
  freshness, and draft-only tabs.
- [Compaction surfaces](compaction-surfaces.md) — divider rows, R4 shells that
  never render, `endsTranscript` with a divider, and optimistic writer
  controls (`/compact`, withdrawal).
- [Fork and handoff](fork-and-handoff.md) — the turn actions, navigate-first
  creation and its failure, the brief card, a fork's inherited view, and
  `from` sources.
- [Failed-reply Retry](failed-reply-retry.md) — Retry on the latest failed
  reply, the optimistic new reply below it, and the refused and lost cases.
- [Thread live updates](thread-live-updates.md) — snapshot revalidation on
  activation and on a new run, and the per-run resume that renders a
  server-initiated continuation live.
- Durable acknowledged submissions — the account-stamped intent journal in
  `client/chat-submissions` and the reload reconciliation in
  `useChatSubmissionRecovery.ts` / `useThreadHandoff.ts`. The journal owns intent
  identity only; the server owns outcome. First-send creation is replayed by
  `useThreadHandoff` using current-chat identity; it never becomes lost-message
  recovery copy. For later sends, a proved rejection returns words to an empty
  per-tab composer or remains in the device journal as rejected when newer writing
  exists. A retired rejection's transient failed row is removed on remount
  because its words already belong to the composer. Failed rows reconstruct
  from rejected entries across tabs and reloads;
  rejected entries never trigger lookup or replay. Retry remints the submission
  identity and dispatches the exact fingerprint without replacing newer drafts.
  Edit transfers reference-preserving rejected paragraphs ahead of current writing
  before retiring the entry. Ambiguous sends keep Check submission status / Start
  over. Recovery lookup/replay/ack/
  retire is fenced by a per-hook recovery-session token in `ThreadRunController`,
  distinct from the run `admissionEpoch`: mounting the session hook tears the run
  session down in the same React StrictMode commit that starts recovery, so the
  admission epoch must not fence recovery's own work; a genuinely unmounted
  recovery owner stops matching, so a stale recovery lookup/replay cannot
  acknowledge, start a run, or retire; a stale recovery replay also leaves the
  optimistic row untouched (`StaleAcceptPolicy: "leave-row"`) rather than
  bridging it, so the returning session's `already-accepted` lookup owns the
  bridge and the retire. Live sends keep the admission-epoch fence and still
  bridge an accepted row after teardown.
  See [`client/chat-submissions/AGENTS.md`](../../../client/chat-submissions/AGENTS.md).

- Transcript links follow through `useChatLinkFollowing.ts` over the shared
  [`features/links`](../../links/AGENTS.md) follower; its header holds chat's
  scope, destination, and visibility rules, including the known deleted-Work gap.

- Every `ChatView` is owned by a project workspace and receives its required
  project ID from `ChatScreen`. Child-thread doors use the project shell's
  `ChatThreadNavigationProvider`, so they open the child in the same project
  address space instead of creating a second chat shell.

Durable change detail renders only through the owning turn receipt; the
transcript does not add a conversation-wide aggregate record.

See [`../AGENTS.md`](../AGENTS.md) for the working mental model and entry points.
