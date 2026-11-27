# features/editor/chrome

The React adapter for the headless kernel in
[`core/editor/chrome/`](../../../core/editor/chrome/AGENTS.md).

- Use `useChromeLayer`'s `onCloseAutoFocus` and `onEscapeKeyDown`. A lane that opens
  another surface wraps its content in `layer.scope(...)`; timers and hand-written focus
  return race Radix teardown. A surface's own shortcuts go in `useChromeLayer({ keys })`,
  not a `document` listener, so the kernel sees the binding.
- Chrome that portals out of the prose spreads `editorChromeAttributes(chrome)`, or
  right-clicks on it bypass the claim ladder.
- A lane never spells a dialog's width or height (`DIALOG_SIZES`).
- Hover, suppression, revision and context are kernel answers. Local mirrors or
  lane-local pointer/Escape listeners split the authority.
- Measured chrome is pane-relative `position: absolute`, never viewport-fixed.

Wrapper seams and measurement: [`.context/CONTEXT.md`](.context/CONTEXT.md).
