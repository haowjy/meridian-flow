# Project chat index contracts

The list contract is in
[Project Chat Lists Share Presentation and State Boundaries](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/chat/entry-and-navigation/project-chat-list-contract.md).

## Feed

`client/query/chat-projections.ts` is the one canonical writer for every cache holding a denormalized
chat row: a mutation patches or removes a row there, applied to all of them in one batch, rather than
hand-listing a subset.

`useProjectChatFeed` memoizes the flattened, favorite-filtered `items`, so a keystroke elsewhere doesn't
invalidate every row. Pending Favorite membership is projected into cached filtered pages without
changing their server cursors, and stale first-page responses retain Favorite commands that completed
after the request began.

Search text and filter are router search params (`q`, `filter`), not component state, so Back restores
exactly what the writer left. An empty search result is suppressed while placeholder data from a
different filter or search is still on screen.

The pagination sentinel observes only while a page can be requested, so a stale observer callback can't
request one. `NextPage` owns the sentinel and next-page failure row, and Work detail reuses it.

Recency labels and rows are one flat run of virtual entries, and a row with an open menu or focus stays
mounted when scrolled away. Lifecycle hints are snapshots, not live signals for unsubscribed chats.

## Row

Every list takes Favorite and Delete from `chat-list/useChatRowCommands`. Confirming closes
`DeleteChatDialog` at once and deletes optimistically; a failed delete restores the row from its
pre-delete snapshot and shows the error on that row, not the closed dialog.

`row-rule` is a 1px line drawn over the row's bottom edge, adding no height, so real and loading rows
keep one rhythm.
