# features/editor/chrome — chrome primitives

The React adapter for the headless kernel in
[`core/editor/chrome/`](../../../core/editor/chrome/AGENTS.md).

- A surface is one entry in `chrome-surfaces.tsx`, taking the editor and nothing else.
  `EditorView` doesn't know individual surfaces.
- Pass `active` to `EditorChromeHost`, or hidden editors (the kept document, a closed side) paint chrome
  over the visible editor.
- Use `useChromeLayer`'s `onCloseAutoFocus` and `onEscapeKeyDown`. A lane that opens
  another surface wraps its content in `layer.scope(...)`; don't race Radix teardown with
  timers or hand-written focus return. A surface's own shortcuts go in
  `useChromeLayer({ keys })`, not a `document` listener, so the kernel sees the binding.
- Chrome that portals out of the prose spreads `editorChromeAttributes(chrome)`, or
  right-clicks on it bypass the claim ladder.
- A lane never spells a dialog's width or height (`DIALOG_SIZES`).
- Hover, suppression, revision and context are kernel answers. Mirroring them in local
  state or adding lane-local pointer/Escape listeners splits the authority.
- Measured chrome is pane-relative `position: absolute`, never viewport-fixed.
- `index.ts` exports primitives only: the registry and host in the barrel load every lane
  and create a cycle.

Wrapper seams and measurement: [`.context/CONTEXT.md`](.context/CONTEXT.md).
