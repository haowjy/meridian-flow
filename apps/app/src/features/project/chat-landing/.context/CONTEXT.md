# Project chat index contracts

`useProjectChatFeed` reads flat `{ items, nextCursor }` pages. All and Favorites
have distinct query keys; the server applies Favorite filtering before keyset
pagination. `project-chat-feed-cache.ts` maps fields and deduplicates pages,
without categories. Pending Favorite membership is projected into cached
filtered pages without changing their server cursors, and stale first-page
responses retain Favorite commands that completed after the request began.

`thread-user-state-commands.ts` owns normalized Favorite intent, serialization,
stale-response fencing, and failure. `ProjectChatRow` is shared with Work detail.
The index delegates selection and New chat to route commands. Creation lives
in `features/chat/CreationComposer`, rendered in the empty chat pane rather
than above the feed.

The feed observer keys pagination by project, filter, and opaque cursor. Stale
observer callbacks must not request pages. Lifecycle hints are snapshots, not
live signals for unsubscribed chats.

## Row layout and feed behavior

A landing row is a borderless resume-list entry, not a card: title and bound Agent
name share line one; preview and activity date share line two; overflow owns
Favorite and has no standing-star counterpart. Work is not the row identity.
Real and loading rows use the same two-line layout: a flexible title/preview
lane, a right-side Agent lane (`data-project-chat-row-work` for geometry), and a
trailing date/action slot. The Agent lane has the same position and width in
every row, and its text is right-aligned within that lane and vertically
centered across the full two-line row. Its compact current-value treatment
follows the Composer: the Agent name is medium foreground text, while the Agent
label remains in its accessible name. A null name displays as General. Title
and preview are 13 px; Agent and both date presentations are 12 px. At 390 px,
ordinary titles and Agent names fit while genuinely long titles, Agent names,
and previews truncate without horizontal overflow. On fine pointers, the date
and overflow share that trailing center; the action replaces the date on hover,
focus-within, or an open menu without reflow. On coarse/no-hover inputs, the
44 × 44 px action remains in the trailing lane and the date follows the preview
inline. Fine rows retain a 53.6 px rhythm and coarse rows a 56 px rhythm (plus
any separator); loading must match it.
