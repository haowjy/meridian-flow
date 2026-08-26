# Project Home — Boundary and layout contract

`src/client/query/home-chat-feed-cache.ts` owns Home's QueryClient-scoped
desired-state overlays, request watermarks, and authoritative reconciliation.
`src/client/query/thread-user-state-commands.ts` is the QueryClient-scoped
transport, per-thread/per-field command serialization, and cache-command authority.
`useHomeChatFeed` owns the Home query plus mounted-caller presentation and orchestration.
`visible-thread-open-acknowledgements.ts` owns semantic visible-Chat epochs,
Home-to-Chat transfer, creation-owned no-command epochs, retry attribution, and
lease cleanup above that transport;
field command state never retains a shared settled error or outcome.
The visible destination's inline error row is the only accessible alert owner
for an open failure; manual read/unread failures remain with their initiating
Home control.
The Home feature keeps screen composition in `HomeScreen`, stable-ID creation,
ambiguity reconciliation, and route-only retry in `useHomeFirstSendAttempt`,
borderless two-line row semantics in `HomeChatRow`, list and section layout plus
cursor-observer lifecycle in `HomeFeed`, date policy in `home-activity-date`,
and scroll/focus restoration in the favorite-movement hook. Do not duplicate
any of those concerns in the screen orchestrator.

## Row layout and feed behavior

A Home row is a borderless resume-list entry, not a card: title and Work share
line one; preview and activity date share line two; overflow owns Favorite and
has no standing-star counterpart. Real and loading rows use the same two-line
layout: a flexible title/preview lane, a right-side Work lane, and a trailing
date/action slot. The Work lane has the same position and width in every row,
and its text is centered within that lane. Title and preview are 13 px;
Work and both date presentations are 12 px. At 390 px, ordinary titles and Work
labels fit while genuinely long titles, Work labels, and previews truncate without
horizontal overflow. On fine pointers, the date and overflow share that trailing
center; the action replaces the date on hover, focus-within, or an open menu
without reflow. On coarse/no-hover inputs, the 44 × 44 px action remains in the
trailing lane and the date follows the preview inline. Fine rows retain a 53.6 px
rhythm and coarse rows a 56 px rhythm (plus any separator); loading must match it.
`e2e/home-row-geometry.pw.ts` protects the production component's stable
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
