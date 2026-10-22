# extensions/slash — the `/` lane specification

This directory supplies the slash trigger predicate, insertion strategy table,
and host catalog to the shared suggestion mechanism. It owns no menu lifecycle
or rendering; the surface is in `features/editor/surfaces/slash`.

## Rules

- `allowsSlashTrigger(doc, from)` is the complete envelope. Do not split its
  truth table across suggestion config, key handlers, or entry code.
- Entries create or insert through `slashTarget`; they never restyle an
  arbitrary node. A list item's target is after the whole list. A quote stays
  a quoted block. Every entry declares the structure it lands and the caret
  result.
- On an empty paragraph a choice converts the block; anywhere else it lands
  after, leaving the writer's sentence untouched. Every insertion opens ready to
  work (a table with the caret in its first cell, a fence with the caret inside,
  a divider with a line after it); an `engage: "surface"` type opens its surface
  through `engageObject`, the same door Enter uses.
- Do not use TipTap block commands per entry, `insertPoint` for the target (a
  schema question, not a domain one), or `@tiptap/suggestion` here: a rule the
  spec cannot express is a missing spec field, not a second plugin. Do not model
  an entry as a node shape it does not land, or availability answers about the
  surrogate.
- Block entries ask schema availability at their target level. The image entry
  asks whether the paragraph accepts an inline image. Keep these strategies
  separate so availability matches the actual transaction.
- A slash in a table cell stays in that cell. Use only schema `canReplaceWith`
  for entry availability; do not grey rows from a parallel capability model.
- The catalog is supplied by the host and read at open, so labels stay
  localized and host-specific. Entry IDs form a closed union with insertion
  rows and surface icons.
- Image choice consumes the trigger and passes an `EditorAnchor` to the host;
  the picker resolves it later and refuses if the place no longer accepts an
  image. It never reads the current selection after the dialog opens.
- Mount this lane through the catalog option of the shared suggestion
  mechanism. Escape, key timing, catalog fences, and origin policy belong to
  that mechanism and apply to `@` as well.

→ [`../suggestion/suggestion-lane.ts`](../suggestion/suggestion-lane.ts)
→ [`../../../completion/AGENTS.md`](../../../completion/AGENTS.md)
→ [`../../images/AGENTS.md`](../../images/AGENTS.md)
