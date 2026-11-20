# @meridian/suggestions

A Work's draft of a document, stored as that Work's suggestion marks inside the one Live
document. Behind `FLOW_SUGGESTIONS` (server) and `VITE_FLOW_SUGGESTIONS` (app) until the draft
documents are deleted; with both off nothing reads these marks.

- Pure ProseMirror: no Yjs, no workspace imports. Code that reads or writes a Y.Doc's suggestions
  goes through agent-edit: `suggesting-model.ts` (the model's view) and `stored-suggestions.ts`
  (`resolveStored`, the press, `suggestionAuthors`), so the move to Yjs 14 stays a package swap.
  Add no new `Y.Xml*` use elsewhere.
- A resolve is one path: the tab, the press and card Undo all call `resolveStored`, which writes
  exactly what the verdict settles. A second way to apply a verdict to Yjs is the bug to look for.
- Marks hold `{ id, work }` only; authors are once per change in `Authors`. Put nothing per-run on
  a mark that `kindOf` does not read.
- `kindOf` is the one decision table. Every reader shows a view through `viewBlock`, and every
  writer, the editor and the model alike, goes through `rewrite`. A second rule for "what does
  this view see" or "what does this edit do" is the bug to look for in review.
- Discard is `reject({ work })`. There is no hidden or discarded state in the document.

How it works, and its limits: [.context/CONTEXT.md](.context/CONTEXT.md).
