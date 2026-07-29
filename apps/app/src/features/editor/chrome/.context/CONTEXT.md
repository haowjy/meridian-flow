# Chrome primitives — contracts

Reference depth for the React half. Read [`AGENTS.md`](../AGENTS.md) first;
the seams and the Esc chain are in the kernel's
[`.context/CONTEXT.md`](../../../../core/editor/chrome/.context/CONTEXT.md).

## Mounting a surface

```ts
// chrome-surfaces.tsx — append-only, one entry per lane
{ id: "formatting-menu", render: ({ editor }) => <FormattingMenu editor={editor} /> },
```

A surface gets the editor and nothing else. Everything about the writer's
current state it reads from the kernel, so the host has no growing prop list
and a lane never has to ask for one. The host renders no element of its own;
every surface portals or floats, so nothing here can push the manuscript.

## The Radix wrappers

All three take the same first four props: `editor`, `id` (names the layer in
the Esc chain), `open`, `onOpenChange`. All three bake in the layer
registration, the Escape deferral, and the focus return.

| | Anchoring | Focus on open | Modal |
|---|---|---|---|
| `EditorMenu` | `at={{x, y}}` for a claimed right-click, or `trigger` for a control | Radix roving focus | no |
| `EditorPopover` | same | Radix's — a popover holds a form, and the writer opened it to type | no |
| `EditorDialog` | centered lightbox over the still-mounted page | Radix's | yes, with the scrim |

Menu parts are re-exported with editor names (`EditorMenuItem`,
`EditorMenuSeparator`, `EditorMenuSub`, …) so a lane has one import.

Opening from inside a `contextmenu` handler works: Radix does not dismiss on
the pointer sequence that produced the event. Verified in the browser across
the whole split matrix.

## OverlayIconRow

```tsx
<OverlayIconRow
  editor={editor}
  kind="diagram"
  anchor={objectElement}      // null takes the row out of the document
  visible={hovered || selected} // drives the fade
  items={[{ id, label, icon, onSelect }]}
  overflow={(chip) => <EditorMenu trigger={chip} …>…</EditorMenu>}
/>
```

`anchor` and `visible` are separate on purpose. `anchor` is which object is
being approached; `visible` fades the row over it. A row that unmounted on the
frame the pointer left would read as a flicker, and the design asks for a fade
both ways — so the lane holds `anchor` through the hover intent's leave grace
(`CHROME_TIMING.fadeMs`) and lets `visible` go first.

Geometry, matching mockup 03b: inset 10px from the object's top-right, 6px gap,
card chip per button (`--color-card` ground, hairline border, `--shadow-card`),
the row ending in ⋮. Measured in the browser: `dxRight` 10, `dyTop` 10, three
32px chips, and the manuscript's block offsets are byte-identical with the row
up and down.

The row follows its object: scroll is watched in capture phase because the
manuscript scrolls in a pane rather than the window, plus a `ResizeObserver` on
the anchor. It carries `data-editor-chrome`, so a right-click on it routes
through the claim ladder like a right-click on the object.

Hover reveal is the lane's to wire, through `chrome.createHoverIntent(...)` —
never a local `setTimeout`, which would linger through a drag.

## Reading the kernel

```ts
const context = useChromeContext(editor);     // the deepest owner, law 4
const suppressed = useChromeSuppressed(editor); // drag or sweep in flight
const chrome = useEditorChrome(editor);       // registrations; may be null
```

`useChromeContext` and `useChromeSuppressed` are `useSyncExternalStore`
readings of one store, so two surfaces can never disagree about what owns
chrome. Both answer safely on an editor with no kernel.

## Where a lane still owns the work

- **Which element is the anchor.** The kernel resolves the document position;
  turning it into DOM is `editor.view.nodeDOM(pos)` and belongs to the lane
  that knows its node view's shape.
- **Hover tracking.** The kernel supplies the timing policy, not the pointer
  listeners.
- **Menu contents.** Every item, its copy, and its command.
