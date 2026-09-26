# features/chat — Context map

This directory's durable contracts are split by concern so turn rendering and
draft-control changes can be understood independently.

- [Turn composition](turn-composition.md) — the process/text/artifact render
  model, tool kinds, tool rendering, and positional keys.
- [Activity row anatomy](activity-row-anatomy.md) — document names as doors,
  the stretched-button row, command glyphs, verb vocabulary, and why row
  chrome carries no colour of its own.
- [Tool expands](tool-expands.md) — the three rendering tiers, the three
  channels, what each expand shows, and how a clipped expand states its bound.
- [Turn edit receipts](turn-edit-receipts.md) — committed change records, Undo/Redo,
  and conversation reveal.
- [Composer write mode](composer-write-mode.md) — the Work-scoped Draft /
  Auto-apply control, neutral shared presentation, New-chat and chat-detail adapters, and
  composer sizing.
- [Draft review](draft-review.md) — inline review session, pending projection,
  freshness, and draft-only tabs.
- [Thread live updates](thread-live-updates.md) — snapshot revalidation on
  activation and on a new run, and the per-run resume that renders a
  server-initiated continuation live.
- Durable acknowledged submissions — the account-stamped intent journal in
  `client/chat-submissions` and the reload reconciliation in
  `useChatSubmissionRecovery.ts` / `useThreadHandoff.ts`. The journal owns intent
  identity only; the server owns outcome. First-send creation is replayed by
  `useThreadHandoff` using current-chat identity; it never becomes lost-message
  recovery copy. For later sends, a proved rejection retires the witness
  but keeps the failed user row with Retry / Edit (Retry remints the submission
  id, since the server never re-admits a rejected one); ambiguous sends keep the
  row with Check submission status / Start over. A Retry that is itself
  unresolved — ambiguous, unmounted, or epoch-fenced — leaves its fresh journal
  entry as the only witness and remounts as Check / Start over, never a second
  Retry; the retained rejection is inserted only after a proved rejection and
  cleared on acceptance. Edit focuses a live draft, or restores plain text only
  when the fingerprint is plain and the composer is empty; a structured
  rejection whose draft is gone offers Retry only. Recovery lookup/replay/ack/
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

- The authenticated `/chat/{threadId}` shell remains the project-less surface
  for independent-project and child threads. Its thread snapshot is the source
  of the backing project identity; after that resolves, the shell owns the
  project draft-recovery executor and the project navigation/review-handoff
  providers around its `DraftReviewProvider`. Keep these owners above
  `ChatView` on direct loads and refreshes, just as the project shell does.
  First-send project chats use `/p/{projectId}/chat/{threadId}` instead; the
  remaining `/chat/` producer is the child-thread door in `AssistantTurn`.

Durable change detail renders only through the owning turn receipt; the
transcript does not add a conversation-wide aggregate record.

See [`../AGENTS.md`](../AGENTS.md) for the working mental model and entry points.
