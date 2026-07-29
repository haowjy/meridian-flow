# extensions/slash — the `/` trigger

Four small modules and the plugin that wires them: where `/` may open
(`slash-trigger.ts`), what a choice does to the document
(`slash-insertion.ts`), what the menu is offering (`slash-catalog.ts`), and the
open menu React reads (`slash-menu-store.ts`). The surface that renders it is
[`features/editor/surfaces/slash/`](../../../../features/editor/surfaces/slash/AGENTS.md).

## Mental model

**The predicate is the spec.** The old menu's failure (F6) was an undefined
envelope, not a wrong one: preconditions lived in a plugin config and in code,
and a writer who typed `/` and got a literal slash had nowhere to learn why.
`allowsSlashTrigger(doc, from)` is the whole contract now, and its test is the
§5.7 truth table rather than a sample of it. That is why `startOfLine` and
`allowedPrefixes` are switched OFF in the suggestion config: splitting the
envelope across two places is how the old one became unreadable.

**Entries create, they never restyle** (F4). On an empty paragraph the choice
converts the block, because there is nothing there to restyle; anywhere else it
lands after, and the sentence the writer was standing in is untouched. Both
decisions are `slashTarget`, read from the document after the trigger text is
gone.

**Every insertion opens ready to work** (law 2): a table with the caret in its
first cell, a fence with the caret inside it, a divider with a line after it.
The caret rule is a field in the insertion table, not a special case in a
command. An object whose type registers `engage: "surface"` gets that surface
instead, through the object lane's `engageObject` — the same door Enter uses.

**"After the current one" needs a level.** A list item exists only as part of
its list and a cell only as part of its table, so a block asked for from inside
one lands after the whole structure. A quote is deliberately not one of those:
its children are ordinary blocks that happen to be quoted.

## Key rules

- **The catalog is the host's** (`catalog()`, read at open). Labels are
  localized and the image entry needs the host's picker, so nothing here may
  hard-code a string. Ids are a closed union: a new entry needs a row in the
  insertion table and an icon in the surface, or it will not compile.
- **This extension owns no Escape.** The kernel does; the menu takes its step by
  being a registered layer. Suggestion's own Escape handling is the floor under
  the frame before React has rendered.
- **A withdrawn catalog closes the menu.** Editability flips without a
  transaction (`setEditable` re-runs plugin views, not plugin `apply`), so the
  suggestion never re-evaluates on its own and would leave an open menu whose
  every row is dead. A plugin view watches for it and exits through the same
  door Escape uses, which is what releases the keymap and the layer once.
- **A dismissal stays dismissed.** A second `/` typed against a dismissed one
  is the same trigger, because the dismissed range maps forward onto it; the
  menu comes back when the trigger is deleted, not when it is repeated.
- **Keys register from the suggestion's `onStart`**, which is plugin-view
  lifetime. A React effect would arrive after the first ArrowDown of a writer
  who types `/` and moves in one motion.
- **No `shouldShow`.** It is evaluated on every transaction, so using it to keep
  remote writes from opening the menu would close an open menu every time a
  collaborator typed anywhere in the chapter.

## Anti-patterns

- Adding a precondition to `allow` instead of to the predicate. The truth table
  is the product contract; a rule that is not in it is a silent rejection.
- Reaching for TipTap's block commands (`setHeading`, `insertTable`) per entry.
  They each place the caret their own way; the insertion table is one rule.
- Reaching for `insertPoint` for the insertion position. It answers a schema
  question — first legal parent, stop climbing at a sibling — and this is a
  domain one, which is how a table once landed inside a bullet and how the
  Table row once died in every cell but the last.
- Mounting this in `EDITOR_CHROME_EXTENSIONS`. It mounts with the catalog
  option, so a surface that offers no catalog pays for no trigger.

→ [`../../chrome/AGENTS.md`](../../chrome/AGENTS.md) for the layer, keymap, and Esc contracts
→ design of record: `editor-toolbar-split/interaction-model.md` §5.7
