# TODO

- `EditorView.tsx` (`data-document-schema-stale`): the only surface where a writer
  faces a document they can't read or edit, a state the
  [repair-first rule](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/index.md#document-schema)
  rules out as a product state. It stands only as an assertion screen for major schema
  mismatches. If the 4407 path becomes reachable, replace it with the migration flow and
  at minimum a read-only view of the last known content, following the schema-fence
  read-only state.

- `EditorSurfaceFrame.tsx` toolbar row in the side: at the narrowest width (280px) the
  last control starts off-screen, nothing shows the row scrolls, and a vertical wheel
  doesn't move it. Give the clipped edge a visible cue (a fade, or wheel-to-horizontal
  scrolling) without moving controls into a menu.

- The editor's removal chip says "The AI in a chat deleted X" without the chat's title, while the
  Trash banner for the same document names it. `removalRecordOf`
  (`project/context/removal-answer.ts`) reads only the replay, which has the actor's kind but not
  the chat's title; the server's trashed-document read has the title. Take the chip's wording from
  the same read as the banner.
