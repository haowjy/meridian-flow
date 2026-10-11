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
- Durable acknowledged submissions — `client/chat-submissions` owns one
  account-stamped record for every unadmitted writer message. `useChatSubmissions`
  binds journal rows to `ChatSubmissionDriver`; `useThreadRunResume` resumes only
  server snapshot runs. First-send creation is a field on the same record, not a
  separate stream handoff. The driver holds a per-thread Web Lock, bounds requests
  and fences every result by the account epoch and mounted recovery session.
  Accepted messages bridge and retire. Rejections remain on writer rows and never
  replay automatically. Ambiguity is tab-local and re-drives on mount, online,
  snapshot refresh and reconnect. Retry looks up first and re-mints only a durable
  rejected id. Edit retires server-side before transferring words, preserving newer
  drafts; a never-created chat dissolves to New chat in the same pane. Composer
  clears when the journal accepts ownership, not when the network completes.

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
