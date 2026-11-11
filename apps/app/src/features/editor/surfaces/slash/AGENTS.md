# surfaces/slash

The menu `/` opens. Where `/` may open, what an entry does and which keys the menu owns
live in [`core/editor/extensions/slash/`](../../../../core/editor/extensions/slash/AGENTS.md).
Scroll, fades and the announcement live in `chrome/SuggestionMenu`, shared with the `@` menu.

- With no matching rows the store reports closed, so Enter splits the paragraph as it would
  with no menu on screen.
- Every row applies wherever the menu opens, because availability is the schema's answer in
  core. There is nothing to grey.
- Group headings show only with an empty query: filtered matches sort by score, so headings
  would fragment them.
- Read what to show from the store, not `editor.state`; it is already the trigger's answer.
