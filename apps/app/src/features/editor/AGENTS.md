# features/editor — app-facing editor surface

This directory owns the TipTap host and its writer-facing chrome: shared frame,
document toolbar, draft-review controls, and synchronization status. Document
schemas, session infrastructure, and ProseMirror extensions belong under
`core/editor`; project context owns pane and tab composition.

The interaction layer is being rebuilt against a design of record. Its trunk
is [`chrome/`](chrome/AGENTS.md): the primitives every surface renders from,
and the one host they all mount through. The persistent document toolbar is
[`surfaces/toolbar/`](surfaces/toolbar/AGENTS.md), and it owns the command
layer the contextual surfaces share: [`surfaces/formatting/`](surfaces/formatting/AGENTS.md)
(the menu a writer asks for over a selection), the insertion menu
[`surfaces/slash/`](surfaces/slash/AGENTS.md), and the block movement surface
[`surfaces/blocks/`](surfaces/blocks/AGENTS.md). The contextual bubbles were
deleted whole and their replacements are anchored to the blocks they serve.
Do not restore the old surfaces or grow new ones ad hoc here — build against
the design, from the primitives.

## Entry rules

- Keep prose geometry in `editor-column.ts`; hosts consume it rather than
  copying column or spacing classes. The toolbar row and the prose share one
  column edge, so a chrome row never re-encodes its own inset.
- `EditorSurfaceFrame` turns a press on the scroll pane's inert space into a
  caret, and owns only the guard on that press (scrollbar strip, interactive
  children, the prose itself). WHERE the caret lands is
  `core/editor/pointer-boundary`; a seam between two blocks belongs to neither
  of them, and no selection policy belongs in a layout component.
- Inline draft review mounts the server projection in an editable editor: the
  writer is a peer in the review branch room, and edits there land in that
  branch.
- Peer-mark evidence reads delegate to `features/change-trail`; the anchored
  popover and the press it opens on are [`surfaces/peer-marks/`](surfaces/peer-marks/AGENTS.md).
- A new control surface is a directory under `surfaces/` plus one entry in
  `chrome/chrome-surfaces.tsx`. `EditorView.tsx` mounts `EditorChromeHost` once
  and takes no further surfaces; a lane that edits it has taken a shared file
  hostage.
- **A concern the project owns is a runtime, and a runtime renders nothing.**
  Links and images both need the project, so each has one component `EditorView`
  mounts — `ProjectLinkRuntime`, `ImageIngressRuntime` — that registers its ports
  and returns null. What the writer SEES from either lane is a chrome surface
  like any other: an outcome dialog, a drop hint. A runtime that rendered its own
  Radix root would be a transient surface the kernel never heard about, which is
  exactly the bypass the host exists to prevent.
- **The clipboard is one boundary.** [`clipboard.ts`](clipboard.ts) owns
  capability, the rich/plain fallback, and what a refusal was; a surface chooses
  only the payload and where the answer goes. A second `navigator.clipboard`
  call in a surface is a fifth opinion about what a blocked write means, and
  the four that existed disagreed — one hid the row, one threw, one greyed, one
  closed as though the copy had happened.
- **What the app knows reaches a surface as scope, not as props.**
  `EditorScopeProvider` carries `{ projectId, workId }` around the host, and
  `useEditorScope()` is how a lane asks. It is runtime scope: a Work changing
  never remounts the editor, and it never appears in `EditorMountIdentity`.
- Anything opened over the manuscript hands the caret back on close
  (`onCloseAutoFocus` → prose) and defers Escape to the kernel's chain. Both
  come free from the `chrome/` wrappers; a hand-rolled Radix root does not get
  them, and the return already knows to stand aside when the closing surface
  left another one open — so a menu item opens its form synchronously rather
  than waiting for focus it must not wait for
  ([`surfaces/formatting/.context/CONTEXT.md`](surfaces/formatting/.context/CONTEXT.md)).
  A surface that keeps its own focus return does not get it either.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`chrome/AGENTS.md`](chrome/AGENTS.md)
→ [`surfaces/toolbar/AGENTS.md`](surfaces/toolbar/AGENTS.md)
→ [`surfaces/slash/AGENTS.md`](surfaces/slash/AGENTS.md)
→ [`surfaces/blocks/AGENTS.md`](surfaces/blocks/AGENTS.md)
→ [`surfaces/formatting/AGENTS.md`](surfaces/formatting/AGENTS.md)
→ [`surfaces/table/AGENTS.md`](surfaces/table/AGENTS.md)
→ [`surfaces/link/AGENTS.md`](surfaces/link/AGENTS.md)
→ [`surfaces/images/AGENTS.md`](surfaces/images/AGENTS.md)
→ [`surfaces/peer-marks/AGENTS.md`](surfaces/peer-marks/AGENTS.md)
→ [`../../core/editor/AGENTS.md`](../../core/editor/AGENTS.md)
