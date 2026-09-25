# Project chat index

The index lists top-level project chats: one flat list by latest activity,
grouped Today / Yesterday / Earlier, behind an All | Favorites filter. It is
the Editor's Recently opened in a different key: shared `RecencyGroupedList`,
heading row with the create action, quiet failure. It never hosts a composer;
New chat opens the empty chat in the same pane through the route command.

- One component for every pane: `placement="page"` (center root, phone) or
  `"rail"` (dock body). `namedByChrome` hides the heading visually where the
  phone trail already reads `Chats`.
- The header doors (`ChatIndexButton.tsx`) follow each pane's band grammar:
  tab chips in the center, a quiet toggle in the dock. Do not copy the Work
  collection UI here.
- `ProjectChatRow` is shared with Work detail; keep them one row.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) before changing feed behavior.
