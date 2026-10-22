# Object controls surface

This surface provides controls for registered image, figure, diagram, and
code-block objects. Registration in the editor core is the authority for
object types, engagement, body mode, and available controls.

- Keep approach identity separate from target identity. Approach comes from
  kernel hover; an action holds its target with `NodeHold` and closes when the
  hold resolves null.
- Overlay controls use the shared attached object corner. Table controls are
  the measured exception. No local pointer or hover authority is allowed.
- A target write must validate the source snapshot/base before changing an
  object. Stale source edits refuse rather than overwriting collaborator text.
- Replace operations hold their target through the dialog and preserve the
  command's undo semantics. Absence is not a disabled state; omit controls
  that do not apply and use shared blocked-row treatment where a reason is
  useful.
- Source editing, export, and viewer dialogs are separate outcomes. Their
  keyboard, Escape, focus return, and notices come from `chrome/` wrappers.
- Diagram render failure is a state of the object renderer, not permission to
  mutate the source. Keep provider-keyed rendering and source identity intact.
  A diagram that stops parsing keeps its last good picture with the error note
  (page and dialog alike); one that has never rendered reveals its source.
- This lane owns the image verbs for both the inline `image` and the captioned
  `figure` (alt text, Replace, caption, label, copy, download, duplicate,
  delete); their node views render and never edit.
- Alt text, caption and label are shared attributes written on every keystroke
  (no Save button; undo is the way back). Replace is always offered, refuses
  aloud without a project, reuses the upload lifecycle on the existing node so
  its alt text, caption and label survive, and is one undo step.
- The row's copy chip copies a diagram's source, not an image (revision runs
  through chat, and source works in every browser); image copy and download live
  in the overflow menu. Every copy or download reports its own failure (clipboard
  blocked versus an export the browser will not do), never a bare retry.
- Pan, zoom and wrapped lines are disposable view state, never written to the
  document.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) for target, source-edit, and
viewer contracts.
