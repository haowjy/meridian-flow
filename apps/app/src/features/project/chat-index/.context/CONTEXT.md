# Project chat index contracts

`useProjectChatFeed` reads flat `{ items, nextCursor }` pages, keeps the
previous filter/search page on screen (`placeholderData: keepPreviousData`)
while the next settles, and memoizes the flattened, favorite-filtered `items`
so a keystroke elsewhere does not invalidate every row. All and Favorites have
distinct query keys; the server applies Favorite filtering before keyset
pagination. `client/query/chat-projections.ts` is the one canonical writer for
every cache that holds a denormalized chat row (the project thread list, every
chat-feed page, every Work-feed page): a mutation patches or removes
(`null`) a row there, applied to all of them in one batch, instead of each
mutation hand-listing a subset. It also owns `flattenChatFeed`. Pending
Favorite membership is projected into cached filtered pages without changing
their server cursors, and stale first-page responses retain Favorite commands
that completed after the request began.

`thread-user-state-commands.ts` owns normalized Favorite intent, serialization,
stale-response fencing, and failure, routed through `chat-projections`.
`ProjectChatFeedRow` (in `chat-list/ProjectChatRow.tsx`) is the one row entry
point shared with Work detail: it reads the row's user state itself, and both
lists pass it only the item and commands. The index delegates selection to
route commands. Creation lives in `features/chat/CreationComposer`: the `hero`
variant above the feed here, the pinned variant in the empty chat pane. Recency
groups are computed per render from the flat, newest-first pages, so
pagination continues inside the last group.

A project with no chats shows the composer and one muted "No chats yet." line.
Search settles for 200 ms in a small local field that reports only the settled
value up, then asks the server for title matches (`q`, case-insensitive, LIKE
metacharacters literal, applied with Favorites before pagination); search and
filter are part of the feed query key (`chatFeedFilter`). Every page is exactly
the server's matches. An empty search result names the query, suppressed while
placeholder data from a different filter/search is still on screen. Search text
and filter are router search params on this route (`q`, `filter`), not
component state, so Back restores exactly what the writer left. An empty
Favorites filter is one muted line under the heading row.

The pagination sentinel observes only while a page can be requested, so a stale
observer callback cannot request a page. It sits after the virtualized list,
whose height is the measured total, so it is reached as the writer scrolls to
the last loaded row. Recency labels and rows are one flat run of virtual
entries; a row is ruled only when the next entry is a row of its group, and a
row with an open menu or focus stays mounted when scrolled away. Lifecycle hints are snapshots, not live
signals for unsubscribed chats.

## Row layout and feed behavior

An index row is a borderless resume-list entry, not a card: title and bound Agent
name share line one; preview and activity date share line two. The list is flat,
so Favorite is a standing mark: a star icon button right beside the Agent name,
filled for favorites and shown on hover (always on touch) for the rest, next to
the overflow's Favorite item. The overflow also offers Delete chat when the
list passes `onDelete`. Every list takes Favorite and Delete from
`chat-list/useChatRowCommands`: confirming closes `DeleteChatDialog` at once and
deletes optimistically — the row leaves every projection and the current chat
is forgotten immediately, ahead of `deleteProjectChat`'s server confirmation. A
failed delete restores the row from its pre-delete snapshot and surfaces the
error on that row (the same `InlineErrorRow` + Retry treatment as a failed
Favorite), not the (already-closed) dialog. Work is not the row identity. Rows use the shared
inset list-row hover (`bg-dropdown-hover`, rounded), the chat switcher's recipe.
Real and loading rows use the same two-line layout: a flexible title/preview
lane, a right-side Agent lane (`data-project-chat-row-work` for geometry; the
name is `data-project-chat-row-agent`), and a trailing date/action slot. The
Agent lane has the same position and width in every row, and its star and name
are right-aligned together within that lane and vertically
centered across the full two-line row. Its compact current-value treatment
follows the Composer: the Agent name is medium foreground text, while the Agent
label remains in its accessible name. A null name displays as General. Title
and preview are 13 px; Agent and both date presentations are 12 px. At 390 px,
ordinary titles and Agent names fit while genuinely long titles, Agent names,
and previews truncate without horizontal overflow. On fine pointers, the date
and overflow share that trailing center; the action replaces the date on hover,
focus-within, or an open menu without reflow. On coarse/no-hover inputs, the
44 × 44 px action remains in the trailing lane and the date follows the preview
inline. Fine rows retain a 53.6 px rhythm and coarse rows a 56 px rhythm; loading
must match it. Rows are ruled by `row-rule`, a 1px line drawn over the row's bottom edge
(adding no height) and inset by the list's 8px bleed so it spans only the text
column.
