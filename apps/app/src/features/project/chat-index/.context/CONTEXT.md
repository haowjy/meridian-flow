# Project chat index contracts

`useProjectChatFeed` reads flat `{ items, nextCursor }` pages. All and Favorites
have distinct query keys; the server applies Favorite filtering before keyset
pagination. `project-chat-feed-cache.ts` maps fields and deduplicates pages,
without categories. Pending Favorite membership is projected into cached
filtered pages without changing their server cursors, and stale first-page
responses retain Favorite commands that completed after the request began.

`thread-user-state-commands.ts` owns normalized Favorite intent, serialization,
stale-response fencing, and failure. `ProjectChatRow` is shared with Work detail.
The index delegates selection to route commands. Creation lives in
`features/chat/CreationComposer`: the `hero` variant above the feed here, the
pinned variant in the empty chat pane. Recency groups are computed per render from the flat,
newest-first pages, so pagination continues inside the last group.

A project with no chats shows the composer and one muted "No chats yet." line.
Search settles for 200 ms, then asks the server for title matches (`q`,
case-insensitive, LIKE metacharacters literal, applied with Favorites before
pagination); search and filter are part of the feed query key
(`chatFeedFilter`). Every page is exactly the server's matches. An empty search
result names the query. Search text and filter persist per project for the page
session, so returning to the index finds the list as the writer left it.
An empty Favorites filter is one muted line under the heading row.

The pagination sentinel observes only while a page can be requested, so a stale
observer callback cannot request a page. Lifecycle hints are snapshots, not live
signals for unsubscribed chats.

## Row layout and feed behavior

An index row is a borderless resume-list entry, not a card: title and bound Agent
name share line one; preview and activity date share line two. The list is flat,
so Favorite is a standing mark: a star icon button right beside the Agent name,
filled for favorites and shown on hover (always on touch) for the rest, next to
the overflow's Favorite item. The overflow also offers Delete chat when the
list passes `onDelete`. Every list takes Favorite and Delete from
`chat-list/useChatRowCommands`: it confirms through `DeleteChatDialog`, calls
the server soft delete (`deleteProjectChat` drops the chat from the thread list
and every chat feed), and clears it as the current chat. Work is not the row identity. Rows use the shared
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
must match it. Rows are ruled by `divide-row-rule`, a 1px line drawn over the row's bottom
edge (adding no height) and inset by the list's 8px bleed so it spans only the
text column.
