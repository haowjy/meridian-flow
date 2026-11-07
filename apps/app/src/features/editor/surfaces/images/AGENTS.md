# surfaces/images — the app's half of image ingress

`ImageIngressRuntime` registers the upload and fetch-bytes ports and renders nothing. Anything
the writer sees goes through `ImageIngressOverlay`, a chrome surface: a runtime that rendered a
Radix root of its own would be a surface the kernel couldn't subordinate.

- Nothing here holds upload state. A percent, a filename or a completion timer in React belongs
  to the extension: progress, failure and recovery belong to the picture's node
  ([`core/editor/images`](../../../../core/editor/images/AGENTS.md)), and what a peer sees is
  drawn by its node view from a decoration.
- A refusal is about an event, not content. Anything that produced a document change is labelled
  on that node instead.
- The ports are the only knowledge crossing: `uploadFigure`, `fetch` and the project context tree
  stay on this side.
