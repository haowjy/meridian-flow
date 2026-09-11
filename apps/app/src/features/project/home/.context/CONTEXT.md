# Project Home — Boundary and layout contract

`src/client/query/thread-user-state-commands.ts` is the single QueryClient-scoped
authority for each project/thread's Favorite state, including pending intent,
request admission, per-command serialization, transport, and field-local
failure. Favorite commands move only the affected Home thread between Home
categories; Work feed membership is unchanged.
`src/client/query/home-chat-feed-cache.ts` owns only Home's Continue/Favorite/Recent
category projection and moves only the affected Home thread.
`useHomeChatFeed` owns the Home query plus mounted-caller presentation and orchestration.
Thread lifecycle projection owns the independent `actionRequired` fact and
converges it across Project, Home, and matching Work feed caches.
The Home feature keeps screen composition in `HomeScreen` and delegates creation
to the shared `features/chat/CreationComposer` and account-owned
`client/first-send-continuity/creation-controller`,
borderless two-line row semantics in the shared, Home-neutral
`../chat-list/ProjectChatRow`, list and section layout plus
cursor-observer lifecycle in `HomeFeed`, date policy in `../chat-list/project-chat-activity-date`,
and scroll/focus restoration in the favorite-movement hook. Do not duplicate
any of those concerns in the screen orchestrator. Work detail renders that same
row component; Work identity inside every list row is display-only.

Project Home and New chat observe one persisted creation slot per account and
creation context. The account owner, not a mounted Home or destination Chat,
atomically claims, creates, and reconciles project-scoped entities. Only
definite Work/Agent refusals allow correcting captured choices; uncertain
attempts retain their IDs and immutable original submission. Ready readable
destination handles and first-send admission commit together. Destination Chat
restores continuity only when its Composer revision still permits it, then
retires exactly the restored durable revision. A newer destination edit must
never be overwritten or retired to finish a handoff. Favorite/feed state is
independent from this creation lifecycle.

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
uses no colored attention dots: `actionRequired` remains semantic and accessible
without a visual status badge. Continue, Favorite, and Recent are exclusive
one-column sections. Home loading consumes the zero-prop
`ProjectChatRowSkeleton` owned beside `ProjectChatRow`; Home must not recreate
the row's three-lane anatomy. `useHomeChatFeed` brands next-page identity
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
