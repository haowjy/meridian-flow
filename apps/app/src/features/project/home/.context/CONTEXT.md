# Project Home — Boundary and layout contract

`src/client/query/thread-user-state-commands.ts` is the single QueryClient-scoped
authority for each project/thread's favorite and effective-attention base,
pending favorite, request admission, per-command serialization, transport, and
field-local failure. Rows project immutable feed membership through that
normalized record.
Work feed pages are never rewritten by a user-state command.
`src/client/query/home-chat-feed-cache.ts` owns only Home's Continue/Favorite/Recent
category projection and moves only the affected Home thread.
`useHomeChatFeed` owns the Home query plus mounted-caller presentation and orchestration.
`visible-thread-open-acknowledgements.ts` owns semantic visible-Chat epochs,
Home-to-Chat transfer, creation-owned no-command epochs, retry attribution, and
lease cleanup above that transport;
field command state never retains a shared settled error or outcome.
The visible destination's inline error row is the only accessible alert owner
for an open-acknowledgement failure.
The Home feature keeps screen composition in `HomeScreen`, stable-ID creation,
ambiguity reconciliation, and route-only retry in `useHomeFirstSendAttempt`,
borderless two-line row semantics in the shared, Home-neutral
`../chat-list/ProjectChatRow`, list and section layout plus
cursor-observer lifecycle in `HomeFeed`, date policy in `../chat-list/project-chat-activity-date`,
and scroll/focus restoration in the favorite-movement hook. Do not duplicate
any of those concerns in the screen orchestrator. Work detail renders that same
row component; Work identity inside every list row is display-only.

`HomeFirstSendLifecycle` is the sole Home creation authority: `idle`, `creating`,
`reconciling`, `refused`, `ambiguous`, `routing`, `route_failed`, and
`mismatched` are exhaustive. Only the named `work_unavailable` and
`agent_not_found` server refusals unlock creation-context repair. Ambiguous
attempts retain their stable ID, text, Work, and Agent until same-ID
reconciliation succeeds. A mismatch is never staged or opened; **Start over**
retires it so the next submission allocates a fresh ID. The thread store begins
its distinct destination handoff lifecycle only after a matching canonical
thread has been prepared; it does not model Home creation.

## Row layout and feed behavior

A Home row is a borderless resume-list entry, not a card: title and Work share
line one; preview and activity date share line two; overflow owns Favorite and
has no standing-star counterpart. Real and loading rows use the same two-line
layout: a flexible title/preview lane, a right-side Work lane, and a trailing
date/action slot. The Work lane has the same position and width in every row,
and its text is right-aligned within that lane and vertically centered across
the full two-line row. Its compact current-value treatment follows the Composer:
the Work name is medium foreground text, while the Work label remains in its
accessible name. Title and preview are 13 px;
Work and both date presentations are 12 px. At 390 px, ordinary titles and Work
labels fit while genuinely long titles, Work labels, and previews truncate without
horizontal overflow. On fine pointers, the date and overflow share that trailing
center; the action replaces the date on hover, focus-within, or an open menu
without reflow. On coarse/no-hover inputs, the 44 × 44 px action remains in the
trailing lane and the date follows the preview inline. Fine rows retain a 53.6 px
rhythm and coarse rows a 56 px rhythm (plus any separator); loading must match it.
`e2e/home-row-component-geometry.pw.ts` protects the component fixture's stable
right-side Work column, including loading parity. A fine-pointer menu assertion requires
a focused browser page: a top-level `window.blur` closes the Radix menu normally,
so the prior observed close was an automation artifact, not a Home defect. Home
uses no colored attention dots: read/action state remains semantic and accessible
without a visual status badge. Continue, Favorite, and Recent are exclusive
one-column sections. `useHomeChatFeed` brands next-page identity
from both the project query key and opaque cursor. `HomeFeed` retains only the
last requested identity, and each observer callback must first prove its own
effect is active: a stale disconnected observer can neither fetch nor overwrite
that bounded guard.

Home and ordinary Chat share the neutral, shadowless Composer surface. Its
landing and pinned placements intentionally keep their own radius and input
height; shared implementation does not mean identical geometry. Continue,
Favorite, and Recent chats remain one compact vertical flow at every width.
Compactness removes layout ceremony, never information or the actual 44 × 44 px
coarse-pointer boxes for Send and Retry controls.

See [`../AGENTS.md`](../AGENTS.md) for the project-shell boundary and
[`../../../../../.context/CONTEXT.md`](../../../../../.context/CONTEXT.md) for
app-wide conventions.
