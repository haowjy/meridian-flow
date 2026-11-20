# @meridian/suggestions

A Work's draft of a document, stored as that Work's suggestion marks inside the one Live
document. Behind `FLOW_SUGGESTIONS` (server) and `VITE_FLOW_SUGGESTIONS` (app) until the draft
documents are deleted; with both off nothing reads these marks.

- Pure ProseMirror: no Yjs, no workspace imports. Code that reads or writes a Y.Doc's suggestions
  goes through agent-edit's `suggesting-model.ts` (`suggestingModel`, `resolveStored`), so the
  move to Yjs 14 stays a package swap. Add no new `Y.Xml*` use elsewhere.
- `kindOf` is the one decision table. Every reader shows a view through `viewBlock`, and every
  writer, the editor and the model alike, goes through `rewrite`. A second rule for "what does
  this view see" or "what does this edit do" is the bug to look for in review.
- Discard is `reject({ work })`. There is no hidden or discarded state in the document.

How it works, and its limits: [.context/CONTEXT.md](.context/CONTEXT.md).
