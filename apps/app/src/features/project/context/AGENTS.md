# features/project/context: context file tree

The browse surface over the project's tree list: project documents, Scratch and Work Files,
shown in the desktop tree, phone browser, recent-document chooser and document hosts. Uploads
stay chat resources, not documents main opens.

- Every name, path and place is read from the replay of the list (`useProjectTreeViews`, a
  `TreeView` per source). Every tree action appends a record to the browser's copy through
  `TreeActions` (`useEntryActions` picks the project's list or the account's): there is no
  request, operation id or retry in the UI, and a number on a name is the list's to add.
- Context entries use one interaction boundary, which owns action dispatch. Nothing refuses a
  tree action; a change the server bounced (its Work was closed) says so on its row through the
  tree's notice words (`use-tree-notice-words.tsx`). Shells own geometry, creation entry points,
  navigation and the notice surface.
- A row changes folders only through `moveRows` (`entry-drag/execute-move.ts`), for Move…
  and drops alike, with the one refusal `moveRefusal` in `move-plan.ts`. Order sends a position
  beside a sibling (by id) or at the top or bottom, never an index or a rank: the writer lands
  the rows together, the first at the position and each next right after the one before it. Don't place entries anywhere else. A move
  stays in one list: Move… and the filing chip offer only the row's own list (the project's
  files, or Your files), and a drop on the other list offers Copy and Cancel. The one server
  route is Copy (`execute-copy.ts`).
- Drags that name a document or folder start through `entry-drag/reference-source.ts` and
  nothing else. What a drag may do is judged in `resolveDrop`.
- `tree-drop/` is the one drop scope that row moves and desktop import share: add a route,
  not a second scope. A refused drop is not an error: no fill, no red; the pointer hint
  names the reason.
- Inline create and rename use `useInlineEdit`/`EntryNameField`; don't fork a form protocol.
  A file made in an Agents location is stored by `documentFilenameAt` (literal name, `source`
  kind); at an Agent or skill path it starts with the Agent template.
- A source's pane states are distinct: rows; an error row when the account can't read the
  list; "Loading files…" until the list has synced (`isComplete` false);
  an empty line once it is installed and the source is empty. A failed or in-flight load must never read as an
  empty project.
- Document opening records what main shows, not the intent: the device record updates before
  the server request, which waits for `whenOnServer`. The side and the kept document don't
  count.
- Main with no document is a chooser. Selecting a recent document navigates; route and
  removal owners handle continuity and removal. Main's tabs
  (`client/project-shell/main-tabs.ts`) are the one record of open documents;
  `PresentedDocuments` only records what hosts mount and show. A new way for the writer or a
  removal to end a document (beyond close, Discard, vanish and the list's removal batch) must go
  through one of the coordinator's entry points that close its tab, `applyRemovals` (a removal
  batch) or `leaveDraftOnly` (a draft-only page switched to Live), or the desktop keeps it as a tab
  and brings it back in the side.
- The writer's own delete or Discard of a document begins with the removal coordinator's
  `beginOwnRemoval`: it sends main back to the document
  shown before. A new door that removes documents for the writer must use it. A delete door goes
  through `useDeleteContextEntries(projectId, at)`, which names where its notice with Undo shows.

Children: [`file-suggestions/AGENTS.md`](file-suggestions/AGENTS.md). The list's replay,
editor admission and identity continuity: [`.context/CONTEXT.md`](.context/CONTEXT.md). Drag,
selection and menus: [`.context/tree-interactions.md`](.context/tree-interactions.md). Also
[identity bar](.context/document-identity-bar.md),
[presented documents and editor lifecycle](.context/presented-documents-and-editor-lifecycle.md),
[TODO](.context/TODO.md), [FUTURE](.context/FUTURE.md).
