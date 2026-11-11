# surfaces/objects

Controls for registered image, figure, diagram and code-block objects.
`EDITOR_OBJECT_TYPES` is the authority for object kind, body mode, engagement and controls.

- An action holds its target with `NodeHold` and closes when the hold resolves null;
  approach comes from kernel hover.
- A write validates the source snapshot before changing an object, so a stale edit refuses
  rather than overwriting a collaborator's text.
- A render failure is a state of the object renderer and never touches the source. A
  diagram that stops parsing keeps its last good picture with the error note; one that has
  never rendered reveals its source.
- This lane owns the image verbs for both `image` and `figure`; their node views render and
  never edit.
- Alt text, caption and label are shared attributes written on every keystroke, with no
  Save button. Replace reuses the upload lifecycle on the existing node so those survive,
  and it is one undo step.
- The row's copy chip copies a diagram's source, not an image: revision runs through chat,
  and source works in every browser. Every copy or download reports its own failure.
- Pan, zoom and wrapped lines are view state, never written to the document.

Target, source-edit and viewer contracts: [`.context/CONTEXT.md`](.context/CONTEXT.md).
