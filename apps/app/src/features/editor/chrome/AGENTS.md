# features/editor/chrome — chrome primitives

This directory is the React adapter for the headless editor-chrome kernel in
[`core/editor/chrome/`](../../../core/editor/chrome/AGENTS.md). It owns the
wrappers, host, anchored object row, measured-overlay helpers, notices, and
suggestion list that every editor surface uses.

## Mental model

- `EditorChromeHost` is the only mount. It renders the registry in
  `chrome-surfaces.tsx`; `EditorView` does not know individual surfaces.
- `EditorMenu`, `EditorPopover`, and `EditorDialog` register layers, defer
  Escape to deeper layers, and return focus to prose through `useChromeLayer`.
  `EditorMenuItem` is the shared refused-row treatment; callers provide a
  `blockedReason` and never invent a second refusal shape.
- `OverlayIconRow` is the common object corner. Node-view objects use an
  attached `{ inside }` corner; ProseMirror-owned elements use measured `{ over
  }` geometry. `EditorNoticePill` and all other measured chrome use the
  manuscript pane, not the viewport.
- `SuggestionMenu` owns list scrolling, the eight-row ceiling, and keyboard
  announcements; lanes supply rows. `shortcutLabel` is the single platform
  aware shortcut formatter.

## Rules

- Pass `active` to `EditorChromeHost`; warm editors and collapsed docks must
  not paint chrome over the visible editor.
- Use `onCloseAutoFocus` and `onEscapeKeyDown` from `useChromeLayer`. A lane
  that opens another surface must wrap its content in `layer.scope(...)`; do
  not race Radix teardown with timers or hand-written focus return. A lane that
  returns focus elsewhere passes `returnFocus`, which runs under the same
  guards. A surface's own shortcuts go in `useChromeLayer({ keys })`, never a
  `document` listener, so the kernel sees the binding and its scope ladder.
- A dialog's size is a shell value (`DIALOG_SIZES`: `form` or `workspace`); a
  lane never spells its own width or height. A popover ignores focus loss alone
  as dismissal; Escape and an outside pointer still close it.
- Chrome that portals out of the prose spreads `editorChromeAttributes(chrome)`,
  or right-clicks on it bypass the claim ladder.
- Use `modal={false}` for menus and popovers. A prose-typing suggestion surface
  uses `focusOnOpen="prose"` and has no focusable content.
- Use pane-relative `position: absolute` for measured chrome. The pane clips
  it; `useAnchorRect` and `watchManuscriptLayout` own remeasurement. Holds
  (`NodeHold`) carry identity; DOM elements provide geometry only.
- Hover, suppression, revision, and context are kernel answers consumed with
  the shared external-store hooks. Do not mirror them in local React state or
  add lane-local pointer/Escape listeners.
- `index.ts` exports primitives only. Keep the surface registry and host out of
  the primitive barrel to avoid loading every lane and creating a cycle.
- Use design tokens and component styles; no raw colors or viewport-fixed
  manuscript chrome.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) for wrapper seams and
measurement details.
