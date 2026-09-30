# surfaces/link — everything a writer meets a link through

The destination hint, the right-click menu, the form, the `[[` menu, what a
follow says when it finds nothing, and the runtime that gives an internal link
somewhere to go. Three entries in `EDITOR_CHROME_SURFACES` plus one headless
runtime `EditorView` mounts; policy and state live in
[`core/editor/links/`](../../../../core/editor/links/AGENTS.md),
[`core/editor/extensions/wikilink/`](../../../../core/editor/extensions/wikilink/AGENTS.md),
and — for the rows and their ranking, which the chat composer will share —
[`core/completion/`](../../../../core/completion/AGENTS.md).

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

Beside them, three things that are not summoned surfaces:

- **`WikilinkMenu`** — rows for the `[[` trigger, over the shared
  `SuggestionMenu` the slash menu also renders through. Its documents come from
  the context trees the app already caches (`useLinkableDocuments` in
  [`features/links`](../../../links/AGENTS.md)), so opening it costs no request.
- **`FollowOutcomeDialog`** — what a follow says when the document is not there:
  the `EditorDialog` host over the shared `FollowOutcomeContent`. A chrome
  surface rather than the runtime's own dialog, and that is the whole point: it
  can open a quarter second after the click, so the kernel has to know it is the
  open transient.
- **`ProjectLinkRuntime`** — the Editor's adapter over the link follower in
  [`features/links`](../../../links/AGENTS.md), mounted by `EditorView` and
  rendering nothing. It supplies the Editor's scope, its destination, and the
  link store as the outcome reporter, and registers the follower as the
  navigator a click is handed to. Resolving, the scope rules, and the follow
  procedure are not this directory's.

## Key rules

- **Absent, not greyed** (law 5). Open link is missing when nothing can follow
  the target, which is the honest state for an internal link before the app
  registers a navigator. A verb that cannot work does not appear. Copy reference (Copy link
  address for external links) is the exception, and for the reason the clipboard rows below it grey:
  a withheld clipboard is the browser's answer rather than the link's, it can
  arrive while the menu is open, and the writer who pressed Copy has to hear
  that nothing was copied. So that press keeps the menu open until the write
  settles.
- **The form has no preconditions.** A selection, a bare caret, a caret inside
  a link, a read-only-turned document mid-edit: each has an answer. It refuses
  nothing silently.
- **The menu acts by position.** Writers right-click a link paragraphs away
  from the caret constantly; a verb that quietly edited the caret's link
  instead would be the worst kind of correct. The clipboard rows are the one
  exception, and only where the writer made it one: a passage they had already
  swept around the link is what they chose, so Cut takes that.
- **Copy comes from the link core.** A component that spells out what a target
  means, or decides whether it can be followed, is a second classifier.
- **Unresolved is a sentence, never a warning.** The hint says no document
  carries that name yet; it is not an error voice, because linking ahead of
  writing is the job (§5.5).
- **A pending answer claims nothing.** The hint shows the destination and
  waits.
- **Following is `features/links`'.** The scope an answer belongs to, cache
  invalidation, the 250ms checking rule, and failed-versus-unresolved are its
  rules ([`AGENTS.md`](../../../links/AGENTS.md)). A surface here that resolves
  a link or reads the cache to decide a click is a second follow.

## Anti-patterns

- A local `setTimeout` for hover timing. The kernel owns it and cancels it on
  a gesture; a local timer lingers through a drag.
- Mirroring the store in `useState`. One `useSyncExternalStore` reading is what
  keeps the three from disagreeing.
- A second copy of the clipboard block. Cut, Copy, and Paste are one block two
  menus mount (`../formatting/clipboard-menu.tsx`); this menu supplies only the
  subject the verbs act on and the way it closes once one has run.
- A `navigator.clipboard` reading of this lane's own. Capability and what a
  refusal was belong to `features/editor/clipboard.ts`; the menu chooses the
  payload (the reference slice or external URL) and where the answer goes (the row).

→ [`../../chrome/AGENTS.md`](../../chrome/AGENTS.md) — the primitives, including
  the `SuggestionMenu` both typed-under menus render through
→ [`.context/CONTEXT.md`](.context/CONTEXT.md) — the app-side seam: what the
  Editor's adapter supplies, and who says what a follow found
→ design of record: `editor-toolbar-split/interaction-model.md` §5.5,
  mockup 06
