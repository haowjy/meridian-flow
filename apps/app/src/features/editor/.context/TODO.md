# TODO

- `EditorView.tsx` (`data-document-schema-stale`): the only surface where a writer
  faces a document they can't read or edit, a state the
  [repair-first decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/schema/repair-first-never-disable.md)
  rules out as a product state. It stands only as an assertion screen for major schema
  mismatches. If the 4407 path becomes reachable, replace it with the migration flow and
  at minimum a read-only view of the last known content, following the schema-fence
  read-only state.

- `EditorSurfaceFrame.tsx` toolbar row in the dock: at the narrowest width (280px) the
  last control starts off-screen, nothing shows the row scrolls, and a vertical wheel
  doesn't move it. Give the clipped edge a visible cue (a fade, or wheel-to-horizontal
  scrolling) without moving controls into a menu.
