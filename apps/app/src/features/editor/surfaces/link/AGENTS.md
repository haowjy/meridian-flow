# Link surfaces

This lane is the app-facing link UI: completion, approach hint, form, and
follow/create outcomes. The headless classifier and link runtime live beside
the editor; project resource navigation remains in `features/links`.

- `ProjectLinkRuntime` is null-rendering and registers scope, resolver, and
  follow ports. Visible dialogs/notices mount through the chrome registry.
- The completion menu is a typed-under `SuggestionMenu`; the form is anchored
  to a held text target. A target is identity-held, not a remembered DOM node
  or position.
- The link mark stores an address/ref. Resolution is live cache state and must
  never be written into the document. Pending means no claim has been made;
  absent is not a disabled row.
- The link menu acts on the range the pointer hit, never the caret's link (a
  writer right-clicks links paragraphs away from the caret); only the clipboard
  rows may act on a passage the writer had already swept around the link. The
  form has no preconditions and refuses nothing silently. A verb that cannot work
  is absent, not greyed (Open link before a navigator exists); Copy is the
  exception, because a withheld clipboard must reach the writer, so it keeps the
  menu open until the write settles.
- Unresolved is a sentence, never a warning: the hint says "Doesn't exist yet"
  (linking ahead of writing is the job), and its look is the shared link chip,
  never a rule in this lane's stylesheet.
- Follow delegates to `features/links` with the current editor scope. The
  surface reports pending, unresolved, failed, or created outcomes but does
  not own resolver generations or navigation policy.
- All three doors use shared clipboard/chip rules and chrome focus/Escape
  wrappers. Do not restore the deleted link bubble or add a second link form.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) for catalog, follow, and
store synchronization contracts.
