# Project chat index

The index is the Chat screen's page: "What will you write next?", the
new-chat composer, then top-level project chats in one flat list by latest
activity, grouped Today / Yesterday / Earlier, behind an All | Favorites
filter. It is the Editor's Recently opened in a different key: shared
`RecencyGroupedList`, quiet failure. The page scrolls as one, in a scroll box
as wide as the column so the scrollbar sits at the rows' edge.

- It renders only as a page: the center project root and the phone Chat
  screen. The dock has no index; its chat switcher lists the chats.
  `namedByChrome` hides the heading visually where the phone trail already
  reads `Chats`.
- The center header door (`ChatIndexButton.tsx`) wears the tab-chip grammar.
  Do not copy the Work collection UI here.
- `ProjectChatRow` is shared with Work detail; keep them one row.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) before changing feed behavior.
