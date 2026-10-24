# Project chat index

The Chat screen's page: the new-chat composer above every top-level project
chat, newest activity first, with title search and a Favorites filter.

- It renders only as a page: the center at `/p/<project>/chats` and the phone
  Chat screen. The dock has no index; its chat switcher lists the chats.
- Chats grow without bound: the list pages and searches on the server and is
  virtualized.
- Don't copy the Work collection UI here.
- `ProjectChatFeedRow` (over `ProjectChatRow`) is shared with Work detail; keep
  them one row.

Layout and feed behavior: [`.context/CONTEXT.md`](.context/CONTEXT.md).
