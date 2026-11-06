# extensions/slash — the `/` lane specification

The slash trigger predicate, insertion strategy table and host catalog over the
shared suggestion mechanism. It owns no menu lifecycle or rendering.

- `allowsSlashTrigger(doc, from)` is the complete envelope. Don't split its truth
  table across suggestion config, key handlers or entry code.
- Entries create or insert through `slashTarget`; they don't restyle an arbitrary
  node. On an empty paragraph a choice converts the block; anywhere else it lands
  after, leaving the writer's sentence untouched.
- Don't use TipTap block commands per entry, `insertPoint` for the target (a schema
  question, not a domain one), or `@tiptap/suggestion` here. A rule the spec can't
  express is a missing spec field, not a second plugin.
- Availability uses schema `canReplaceWith` at the entry's target level, so it
  matches the actual transaction. Don't model an entry as a node shape it doesn't
  land, or grey rows from a parallel capability model.
