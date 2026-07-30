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

What a surface needs about the app rather than the document is the one exception,
and it is a read rather than a prop: `useEditorScope()`
(`features/editor/editor-scope.tsx`) answers which project and which Work the
editor is open in. `EditorView` provides it around the host. This is what closed
the last two bypasses — a dialog that needed the project used to mount beside the
host, where the kernel could not see it.

## Mounting a surface, continued

`EditorChromeHost` takes an `active` flag and `EditorView` passes it down. It
is not decoration: `ContextEditorMountHost` keeps up to six editors mounted and
hides the inactive ones with `hidden`, which works for the manuscript (it is
inside the hidden element) and does nothing at all for chrome (it portals to
the body). Without the flag, a warm editor's menu, dialog, or selection-persistent
object row paints over the document the writer is reading, anchored to a rect
in a pane nobody can see.

## The Radix wrappers

All three take the same first four props: `editor`, `id` (names the layer in
the Esc chain), `open`, `onOpenChange`. All three bake in the layer
registration, the Escape deferral, the focus return, and `layer.scope(children)`
so a layer opened inside them is recognised as the deeper one.

### A refused row

`EditorMenuItem` and `EditorMenuCheckboxItem` take `blockedReason` on top of
Radix's own props. A row with one greys (`aria-disabled` + `cursor-not-allowed`
+ half opacity), swallows its `onSelect` so the menu stays open under the
writer, and mounts a `ReasonTooltip` that opens on hover and on focus — the
reason is never standing text on the row.

`EditorMenu` puts a `TooltipProvider` inside its content, which is what those
tooltips read; a row rendered outside an `EditorMenu` has to bring its own. The
tooltip's first line is the row's `aria-label` when it has one — an icon-only
row has no label on screen, and the tooltip is where its name lives whether or
not it can run.

### One surface opening another

This is the seam every lane hits: a menu item that opens a form. Two things
make it work, both inside `useChromeLayer`.

- **The focus return is layer-aware.** `onCloseAutoFocus` hands the caret back
  only when no other layer is open. Otherwise the closing menu pulls focus out
  of the form on the frame it appeared, and Radix reads that as an outside
  interaction and dismisses it.
- **The Escape deferral reads depth, not arrival.** The form registered inside
  the menu's `scope` is the deeper layer, so Escape closes it first.

A lane that opens a surface from a surface owes nothing beyond using the
wrappers. A lane that hand-rolls one owes `layer.onCloseAutoFocus` and
`layer.scope(...)`.

`EditorPopover` additionally refuses focus alone as a dismissal. Focus is
always in motion around an editor form — a menu unmounting drops it to the
body, a close hands it to the prose — and Radix would read every move as a
reason to close. Escape and a pointer outside still dismiss it.

| | Anchoring | Focus on open | Modal |
|---|---|---|---|
| `EditorMenu` | `at={{x, y}}` for a claimed right-click, or `trigger` for a control | Radix roving focus | no |
| `EditorPopover` | `at`, `anchorRect`, or `trigger` | Radix's by default; `focusOnOpen="prose"` leaves the caret where it was | no |

Focus on the way OUT is the layer's, and `returnFocus` is how a lane substitutes
its own answer without losing the guards: it runs only when no other layer took
this surface's place and the manuscript is not behind a scrim. A lane's own
`requestAnimationFrame` cannot do that — it fires before Radix's teardown and the
layer's hand-back overwrites it a frame later.
| `EditorDialog` | centered lightbox over the still-mounted page | Radix's | yes, with the scrim |

`EditorPopover`'s two anchors are one mechanism — a virtual reference
floating-ui measures — and the difference between them is whether the anchor
can move. `at` is a point that cannot (a right-click landed there); `anchorRect`
is a function read on every reposition, for a surface tied to the text itself
(the `/` a writer is typing after, in a manuscript that scrolls). The anchor
names `editor.view.dom` as its `contextElement`, which is what lets floating-ui
find the scroll container to watch; without it a virtual anchor only hears the
window. `EditorMenu` keeps the zero-size trigger from `pointer-anchor.ts`
instead, because Radix's `DropdownMenu` has no Anchor part — which is also why
only it needs the remount key on a new point.

`focusOnOpen="prose"` is for a surface the writer is still typing UNDERNEATH.
The slash menu filters on document text, so a popover that took focus would end
the query on its first keystroke; nothing inside such a surface may be
focusable, and its rows cancel their own mousedown.

Menu parts are re-exported with editor names (`EditorMenuItem`,
`EditorMenuSeparator`, `EditorMenuSub`, …) so a lane has one import.

**Focus returns to the prose unless the prose cannot take it.** `useChromeLayer`
gives every surface an `onCloseAutoFocus` that stands down in two cases: a
successor layer is still open (a menu item that opened a form), or the
manuscript is behind a modal scrim (`aria-hidden` / `inert`), where the dialog
would drag focus back asynchronously and land it on whatever is first inside.
Either way the caret stays where the writer left it.

Opening from inside a `contextmenu` handler works: Radix does not dismiss on
the pointer sequence that produced the event. Verified in the browser across
the whole split matrix.

## OverlayIconRow

```tsx
<OverlayIconRow
  editor={editor}
  kind="diagram"
  corner={{ inside: nodeViewElement }} // or { over: element }; null removes it
  visible={hovered || selected}        // drives the fade
  items={[{ id, label, icon, onSelect }]}
  overflow={(chip) => <EditorMenu trigger={chip} …>…</EditorMenu>}
/>
```

The chip handed to `overflow` is a real trigger: it spreads whatever Radix
merges onto it (`aria-haspopup`, the press handlers, the ref). A chip that
swallowed those would look like a menu and behave like a dead button.

`corner` and `visible` are separate on purpose. `corner` is which object is
being approached; `visible` fades the row over it. A row that unmounted on the
frame the pointer left would read as a flicker, and the design asks for a fade
both ways — so the lane holds `corner` through the hover intent's leave grace
(`CHROME_TIMING.fadeMs`) and lets `visible` go first.

`corner` also says whose coordinate space the row lives in, and there are only
two answers (`object-overlay.ts`):

| | who owns the element | how it is placed | who uses it |
|---|---|---|---|
| `{ inside: … }` | a node view | rendered in the element, CSS corner | diagram, image, figure, code fence |
| `{ over: … }` | ProseMirror | measured rect, body portal | the selected table's ⋮ |

`inside` is the default and the reason is structural: chrome rendered in the
object cannot go stale, because there is no rect between it and the object.
`over` exists only because ProseMirror reads its own elements back as document
content, so a child inserted into a table's wrapper is a document change it
will try to parse. A node view ignores DOM changes outside its `contentDOM`
and has no such problem.

Geometry, matching mockup 03b: inset 10px from the object's top-right, 6px gap,
card chip per button (`--color-card` ground, hairline border, `--shadow-card`),
the row ending in ⋮. Measured in the browser: `dxRight` 10, `dyTop` 10, three
32px chips, and the manuscript's block offsets are byte-identical with the row
up and down — the attached row is absolutely positioned and out of flow, so
zero footprint is a property of the CSS rather than of a portal.

It carries `data-editor-chrome`, so a right-click on it routes through the
claim ladder like a right-click on the object, and the approach reads a pointer
resting on it as still being on the object.

Which object is approached is the kernel's single answer
(`chrome.registerHoverAnchor`), never a listener here.

## Registering a layer by hand

A lane that portals its own surface rather than using a wrapper calls
`useChromeLayer` directly and owes two things the wrappers give for free:

```ts
const layer = useChromeLayer(editor, { id: "block-menu", open, close });
// 1. wrap whatever can contain another layer
return layer.scope(<div>{children}</div>);
// 2. hand `layer.onCloseAutoFocus` to whatever closes the surface, so the
//    caret goes back to the prose — and does not, when this surface opened
//    another one.
// 3. leave `dismissal` at its default unless the surface has its own Escape
//    listener; the kernel's backstop is what keeps it from surviving Escape
//    when focus has moved out of the editor.
// 4. pass `keys` for anything the surface answers while it is open. The hook
//    registers them against this layer's identity, so a chord the surface and
//    the one it opened both claim goes to the deeper of the two.
```

## Reading the kernel

```ts
const context = useChromeContext(editor);     // the deepest owner, law 4
const suppressed = useChromeSuppressed(editor); // drag or sweep in flight
const chrome = useEditorChrome(editor);       // registrations; may be null
useEditorRevision(editor);                    // re-render on every change
```

Reach for these by module (`./useEditorChrome`, `./EditorMenu`) rather than
through `chrome/index.ts`. That barrel also carries `chrome-surfaces`, the
registry every surface is listed in, so a surface importing the barrel closes a
module cycle — Vite reports the registry's own export being read before
initialization, and the lane's surface never mounts.
`useEditorRevision` is the blunt one, for chrome that reads the document
directly — a toolbar's lit states, a chip cluster's language label. Anything
that only needs the resolved context or suppression reads those stores instead:
they notify when their answer changes, not when the document does.
`useAnchorRect(editor, element)` is the shared measurement behind every surface
that still measures, over the kernel's `watchManuscriptLayout` — the same
scheduler the approach re-hit-tests on, so a rect and its target can never
disagree about when the world moved. It re-measures on scroll (capture phase, because
the manuscript scrolls in a pane), on window resize, on any editor transaction,
and on a resize of either the anchor or the manuscript root — the last two
between them cover the moves nothing else reports: a block travelling because a
peer typed above it, and a diagram or image finishing its render and pushing
everything below it down. Results are rAF-coalesced and identity-stable, so a
scroll or a keystroke that does not move the anchor costs no render. An anchor
that has left the document reports no rect at all, which takes the surface off
the page rather than leaving an opaque, clickable overlay measured from a dead
element.

`useChromeContext` and `useChromeSuppressed` are `useSyncExternalStore`
readings of one store, so two surfaces can never disagree about what owns
chrome. Both answer safely on an editor with no kernel.

## Where a lane still owns the work

- **Which element is the anchor.** The kernel resolves the document position;
  turning it into DOM is `editor.view.nodeDOM(pos)` and belongs to the lane
  that knows its node view's shape.
- **The probe, and only the probe.** A lane registers a `HoverAnchorLane` and
  answers which of ITS things is at a point. The pointer, its last place, the
  re-hit-test after a scroll, and the one hovered owner are the kernel's.
- **Menu contents.** Every item, its copy, and its command — including which
  reason applies, though never how a reason is drawn.
