# surfaces/link — everything a writer meets a link through

The destination hint, the right-click menu, the form, the `[[` menu, and the
runtime that gives an internal link somewhere to go. Two entries in
`EDITOR_CHROME_SURFACES` plus one component `EditorView` mounts directly;
policy and state live in
[`core/editor/links/`](../../../../core/editor/links/AGENTS.md) and
[`core/editor/extensions/wikilink/`](../../../../core/editor/extensions/wikilink/AGENTS.md).

## Mental model

Three summoned components, three physics, one store.

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

Beside them, two things that are not summoned surfaces:

- **`WikilinkMenu`** — rows for the `[[` trigger, over the shared
  `SuggestionMenu` the slash menu also renders through. Its documents come
  from the context tree the app already caches (`useWikilinkDocuments`), so
  opening it costs no request.
- **`ProjectLinkRuntime`** — the app's half of the link system, mounted by
  `EditorView` because it needs the project a chrome surface is never given.
  It registers the resolution port every internal link is drawn from and the
  navigator a follow is handed to, and it owns the dialog an unresolved follow
  opens.

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
- **Unresolved is a sentence, never a warning.** The hint says no document
  carries that name yet and the follow offers to write the page; neither is
  an error voice, because linking ahead of writing is the job (§5.5).
- **A pending answer claims nothing.** The hint shows the destination and
  waits, and a follow only interrupts after 250ms — long enough that a link
  already resolved for rendering just opens.
- **A failed request is not an unresolved link.** It renders as an ordinary
  link and says so on follow, with Try again. Drawing it dashed would tell the
  writer their document is missing when the truth is that nobody asked.

## Anti-patterns

- A local `setTimeout` for hover timing. The kernel owns it and cancels it on
  a gesture; a local timer lingers through a drag.
- Mirroring the store in `useState`. One `useSyncExternalStore` reading is what
  keeps the three from disagreeing.
- Rendering a clipboard verb that cannot work. Cut, Copy, and Paste are the
  shared block every claimed menu will carry; they belong to the formatting
  menu's lane, once, rather than half-working here.

→ [`../../chrome/AGENTS.md`](../../chrome/AGENTS.md) — the primitives, including
  the `SuggestionMenu` both typed-under menus render through
→ [`.context/CONTEXT.md`](.context/CONTEXT.md) — the app-side seam: the port,
  the navigator, and what a follow does
→ design of record: `editor-toolbar-split/interaction-model.md` §5.5,
  mockup 06
