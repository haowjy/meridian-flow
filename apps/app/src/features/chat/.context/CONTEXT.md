# features/chat — Context map

The chat's contracts, one page per concern.

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
- [Draft review](../../draft-review/.context/draft-review.md) — room-derived text review, frozen Apply
  queues, local Discard history and draft-only tabs. `useDraftDock` scopes the
  chat's changes; projection and commands belong to `features/draft-review`.
  The draft dock is this chat's changes only, and a chat with none shows no
  dock. Apply and Discard act on this chat's projected groups per file; only a
  new document is one whole-draft item. Each document name opens its own
  review, and there is no summary-wide Review command: Work-wide lists and
  Apply all stay on the Work page. Coarse-pointer targets are 44px. Inline
  Apply uses frozen server clicks; text Discard uses caller-owned local
  history. A draft-only tab is the document's one tab and settles in place.
- [Failure cards](failure-cards.md) — the one projection behind every chat
  failure, where each card anchors, its lifetime and the announcer.
- [Compaction surfaces](compaction-surfaces.md) — divider rows, non-rendered compaction bookkeeping turns, a divider as a closing row, and optimistic writer
  controls (`/compact`, withdrawal).
- [Fork and handoff](fork-and-handoff.md) — the turn actions, navigate-first
  creation and its failure, the brief card, a fork's inherited view, and
  `from` sources.
- [Failed-reply Retry](failed-reply-retry.md) — Retry on the latest failed
  reply, the optimistic new reply below it, and the refused and lost cases.
- [Thread live updates](thread-live-updates.md) — the one mounted subscriber:
  snapshot revalidation, the run-state feed, and joining a live run from the
  first snapshot's cursor.
- Durable acknowledged submissions — `client/chat-submissions` owns one
  account-stamped record for every unadmitted writer message. Its tab owner owns
  one shared account/thread row identity, live session/id-fenced attempts,
  failed/busy knowledge, Edit transfers and observable presentation snapshot. `useChatSubmissions` binds cancellation, external wakes and keyed alerts;
  the mounted `useThreadSnapshotSync` joins runs the snapshot shows. First-send creation is a field on the same record, not a
  separate stream handoff. The driver holds a per-thread Web Lock, bounds requests
  and fences every result by the account epoch and mounted recovery session.
  Accepted messages bridge and retire. Rejections remain on writer rows and never
  replay automatically. Ambiguity is tab-local and re-drives on mount, online,
  snapshot refresh and reconnect. Retry looks up first and re-mints only after successfully decoded
  rejection/retirement proof. Failed lookup/retire requests preserve ambiguity and identity. Edit retires server-side before transferring words, preserving newer
  drafts; this tab's Edit dissolves a never-created chat to New chat in the same pane.
  A stable record-id receipt is saved atomically with the transferred draft;
  same-tab reload or partial retirement cannot copy or Retry those words again.
  These receipts are tab-local, not a cross-tab ownership transaction.
  Remote absence requires a server 404 before dissolution; failed reads and
  inconclusive requests retain the destination and rows. Composer
  clears when the journal accepts ownership, not when the network completes.
  Composer drafts have one tab-local session owner and clear synchronously into
  the journal on Send. Work selection is prospective context, not a separate
  creation draft. Pending upload bytes don't persist; uploaded reference atoms
  do. `CreationComposer` sends through the route-owned pane-aware command and
  never writes a URL.

- Transcript links follow through `useChatLinkFollowing.ts` over the shared
  [`features/links`](../../links/AGENTS.md) follower; its header holds chat's
  scope, destination and visibility rules.

- Every `ChatView` is owned by a project workspace and receives its required
  project ID from `ChatScreen`. Child-thread doors use the project shell's
  `ChatThreadNavigationProvider`, so they open the child in the same project
  address space instead of creating a second chat shell.

Durable change detail renders only through the owning turn receipt; the
transcript does not add a conversation-wide aggregate record.

`ChatView` orchestrates each thread-store frame, while stable rendering boundaries keep unrelated
surfaces still. `ChatComposer` owns the chat draft and dock lifecycle. Transcript rows and assistant
items receive interned view-model values and are memoized. Context values for failure cards,
derivation actions, and subagent activity retain their reference until their own facts change; event
callbacks publish the latest committed render before paint.

The invariants are in [`../AGENTS.md`](../AGENTS.md).
