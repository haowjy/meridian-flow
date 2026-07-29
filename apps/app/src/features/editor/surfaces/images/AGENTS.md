# surfaces/images — the app's half of image ingress

Two small things: where a picture's bytes actually go, and the two moments
ingress has something to say outside the document.

## Mental model

`ImageIngressRuntime` is the seam, and it is `ProjectLinkRuntime`'s twin — both
are ports the app registers on the running editor, mounted by `EditorView` and
rendering nothing. It registers the upload and fetch-bytes ports and feeds the
editor's asset index from the project tree the app already caches. Anything the
writer sees goes through the chrome host instead; a runtime that rendered a Radix
root of its own would be a surface the kernel could not subordinate.

`ImageIngressOverlay` renders what is not content: the pane's drop hint while a
drag carries files, and one pill for a refusal (a file that is not an image, a
picker with no project, a site that would not hand over its bytes). Both come
from the ingress store, and the pill is the same `VerbNoticePill` every other
transient answer in the editor uses.

There is deliberately **no upload status here**. A picture arriving is a node in
the manuscript, and everything about its progress, failure, and recovery belongs
to that node ([`core/editor/images`](../../../../core/editor/images/AGENTS.md)).

## Key rules

- **Nothing in this directory holds upload state.** If a change wants a percent,
  a filename, or a completion timer in React, the lifecycle belongs in the
  extension and this is the wrong file.
- **A refusal is about an event, not content.** Anything that produced a document
  change is labelled on that node instead.
- **The ports are the only knowledge crossing.** `uploadFigure`, `fetch`, and the
  project context tree stay on this side; the editor gets two functions.

→ [`../../../../core/editor/images/AGENTS.md`](../../../../core/editor/images/AGENTS.md)
→ design of record: `editor-toolbar-split/interaction-model.md` §5.6
