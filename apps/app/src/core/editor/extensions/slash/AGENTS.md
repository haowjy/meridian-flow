# extensions/slash — the `/` trigger

Three small modules and the spec that hands them to the shared mechanism: where
`/` may open (`slash-trigger.ts`), what a choice does to the document
(`slash-insertion.ts`), and what the menu is offering (`slash-catalog.ts`). The
lifecycle is [`../suggestion/`](../suggestion/suggestion-lane.ts), which `[[`
uses too; the open menu React reads is the headless store in
[`@/core/completion`](../../../completion/AGENTS.md). The surface that renders it
is
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

**"After the current one" needs a level, and a ceiling.** A list item exists
only as part of its list, so a block asked for from inside a bullet lands after
the whole list. A quote is deliberately not one of those: its children are
ordinary blocks that happen to be quoted.

**A table cell is never left** (ruling). §5.7 lets `/` open in a cell, but a
pick that answered by inserting after the whole table would yank the caret out
of the structure the writer is standing in — the deepest owner, law 4. A
Meridian cell holds one plain paragraph, so most entries have nowhere to go
there: they grey, and the menu says why in the toolbar's own words. Nothing
inserts outside a cell from inside one.

## Key rules

- **The catalog is the host's** (`catalog()`, read at open). Labels are
  localized and the image entry needs the host's picker, so nothing here may
  hard-code a string. Ids are a closed union: a new entry needs a row in the
  insertion table and an icon in the surface, or it will not compile.
- **A refusal is a code here and copy there.** `slashRefusals` answers for
  every visible row at once, in the toolbar's vocabulary (`"table-cell"`); the
  surface renders it through `blockTypeReasonMessage`, so a writer meets one
  wording of the rule wherever they meet it. Core holds no writer-facing string.
- **The lifecycle is not this lane's.** Escape, the catalog fence, the arrow
  keys' timing, dismissal, and the refusal to gate on transaction origin are one
  mechanism's contracts, reasoned about in
  [`../suggestion/suggestion-lane.ts`](../suggestion/suggestion-lane.ts). A
  correction to any of them belongs there, where `[[` and the next trigger get
  it too.

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
- Reaching for `@tiptap/suggestion` here. This lane is a spec; a rule it cannot
  express is a missing field on the spec, not a second plugin.

→ [`../suggestion/suggestion-lane.ts`](../suggestion/suggestion-lane.ts) — the
  mechanism every lane shares
→ [`../../chrome/AGENTS.md`](../../chrome/AGENTS.md) for the layer, keymap, and Esc contracts
→ design of record: `editor-toolbar-split/interaction-model.md` §5.7
