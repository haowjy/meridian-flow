# features/project/context: context file tree

The browse surface over the account resource replica: project documents, Scratch and Work
Files, shown in the desktop tree, phone browser, recent-document chooser and document hosts.
Uploads stay chat resources, not Editor tabs.

- The replica owns durable descriptors, catalog checkpoints, local content, placement and
  namespace journal state. React Query acquires and projects; it is not a second catalog owner.
- Every placement consumer uses the shared `ResourcePlacement` snapshot, including other
  Works. Synthetic ancestors are navigation-only and have no mutations.
- Context entries use one interaction boundary, which owns action dispatch and
  operation/refusal state. Shells own geometry, creation entry points, navigation and the
  notice surface.
- Delete and move persist optimistically through the replica. File targets retain
  `documentId`; folder targets retain catalog `entryId`.
- A row changes folders only through `moveRows` (`entry-drag/execute-move.ts`), for Move…
  and drops alike, with the one refusal `moveRefusal` in `move-plan.ts`. Order sends a
  sibling position, never a rank. Don't place entries anywhere else.
- Drags that name a document or folder start through `entry-drag/reference-source.ts` and
  nothing else. What a drag may do is judged in `resolveDrop`.
- `tree-drop/` is the one drop scope that row moves and desktop import share: add a route,
  not a second scope. A refused drop is not an error: no fill, no red; the pointer hint
  names the reason.
- Inline create and rename use `useInlineEdit`/`EntryNameField`; don't fork a form protocol.
- A source's pane states are distinct: rows; an error row with Retry when the catalog
  query failed; "Loading files…" while the catalog isn't installed (`isComplete` false);
  an empty line once it is installed and the source is empty. A failed or in-flight load must never read as an
  empty project.
- Document opening records the active tab, not the intent: the device record updates before
  the server request, which waits for `whenOnServer`. Restored parked tabs don't count.

Children: [`file-suggestions/AGENTS.md`](file-suggestions/AGENTS.md). Catalog ownership,
editor admission and identity continuity: [`.context/CONTEXT.md`](.context/CONTEXT.md). Drag,
selection and menus: [`.context/tree-interactions.md`](.context/tree-interactions.md). Also
[identity bar](.context/document-identity-bar.md),
[catalog and editor lifecycle](.context/resource-catalog-and-editor-lifecycle.md),
[TODO](.context/TODO.md), [FUTURE](.context/FUTURE.md).
