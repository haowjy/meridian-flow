# Project chat index

- It renders only as a page, the center at `/p/<project>/chats` and the phone Chat screen. The side has
  no index.
- Chats grow without bound: the list pages and searches on the server and is virtualized. Don't copy
  the Work collection UI here.
- `ProjectChatFeedRow` is shared with Work detail; keep them one row.

Feed behavior: [`.context/CONTEXT.md`](.context/CONTEXT.md).
