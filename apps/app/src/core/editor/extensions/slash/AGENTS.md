# extensions/slash — the `/` lane specification

The slash trigger predicate, insertion strategy table and host catalog over the
shared suggestion mechanism. It owns no menu lifecycle or rendering.

- `allowsSlashTrigger(doc, from)` is the complete envelope. Don't split its truth
  table across suggestion config, key handlers or entry code.
- Entries resolve through `slashTarget`. A retyping entry (heading level, list, quote) turns the
  line the trigger is in, empty or not, by the same toggle command the toolbar and Turn into
  run. Any other entry converts an empty paragraph, keeping its id and place
  (`replaceBlock`); anywhere else it lands after the list the block is in, inside the
  quotes around it (`afterList`), leaving the writer's sentence untouched.
- Don't write a block conversion per entry, `insertPoint` for the target (a schema
  question, not a domain one), or `@tiptap/suggestion` here. A rule the spec can't
  express is a missing spec field, not a second plugin.
- Availability uses schema `canReplaceWith` at the entry's target level, so it
  matches the actual transaction. Don't model an entry as a node shape it doesn't
  land, or grey rows from a parallel capability model.
