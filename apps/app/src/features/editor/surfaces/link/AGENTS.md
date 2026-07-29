# surfaces/link — the link's three surfaces

The destination hint, the right-click menu, and the form. One entry in
`EDITOR_CHROME_SURFACES`; policy and state live in
[`core/editor/links/`](../../../../core/editor/links/AGENTS.md).

## Mental model

Three components, three physics, one store.

- **`LinkHint`** — approach chrome (law 7). It takes no focus, claims no layer,
  and lets the pointer through; it fades both ways, because the store nulls the
  hint on the kernel's leave grace and unmounting on that frame reads as a
  blink.
- **`LinkMenu`** — the primary link surface (§5.5, ruled). The kernel's claim
  ladder already decided it wins the right-click; this owns the verbs, and
  every one acts on the range the pointer hit rather than on the caret.
- **`LinkForm`** — one surface behind three doors: Ctrl+K, the toolbar's Link
  button, and the menu's Edit link. It hangs at the caret, because the writer
  is looking at their own sentence.

## Key rules

- **Absent, not greyed** (law 5). Open link is missing when nothing can follow
  the target, which is the honest state for an internal link before the app
  registers a navigator. A verb that cannot work does not appear.
- **The form has no preconditions.** A selection, a bare caret, a caret inside
  a link, a read-only-turned document mid-edit: each has an answer. It refuses
  nothing silently.
- **The menu acts by position.** Writers right-click a link paragraphs away
  from the caret constantly; a verb that quietly edited the caret's link
  instead would be the worst kind of correct.
- **Copy comes from the link core.** A component that spells out what a target
  means, or decides whether it can be followed, is a second classifier.

## Anti-patterns

- A local `setTimeout` for hover timing. The kernel owns it and cancels it on
  a gesture; a local timer lingers through a drag.
- Mirroring the store in `useState`. One `useSyncExternalStore` reading is what
  keeps the three from disagreeing.
- Rendering a clipboard verb that cannot work. Cut, Copy, and Paste are the
  shared block every claimed menu will carry; they belong to the formatting
  menu's lane, once, rather than half-working here.

→ [`../../chrome/AGENTS.md`](../../chrome/AGENTS.md) — the primitives
→ design of record: `editor-toolbar-split/interaction-model.md` §5.5,
  mockup 06
