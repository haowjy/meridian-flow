# Object controls — contracts

This reference covers object-control targeting, source edits, render states,
and dialog outcomes. Read [`AGENTS.md`](../AGENTS.md) first; object identity and
physics come from the core registration table.

## Registration and targeting

`EDITOR_OBJECT_TYPES` is the sole authority for object kind, body mode,
engagement, and controls. The surface distinguishes the object approached by
kernel hover from the target held for an action. `NodeHold` carries the target
through transactions and resolves null when the node is gone; DOM elements are
only current geometry.

Node-view objects use the attached `OverlayIconRow` corner. Tables are the
measured exception and use the table lane. Approach, suppression, pointer
re-hit-testing, and Escape are shared kernel/chrome answers, not local state.
A missing control is absence, not a disabled row; where a command is visible
but refused, use the shared blocked-row reason.

## Render and edit contracts

Diagram rendering is token-time and provider-keyed. The renderer owns loading,
error, and empty faces; a parse or provider failure must not rewrite source.
Source identity remains a stable document address, never a signed URL.

Source editing is a held-target operation with a source/base check. If a
collaborator changed the target, the command refuses rather than overwriting
new content. Replace operations hold their target until confirmation and keep
the command's undo semantics.

Export/viewer/source-editor outcomes are separate chrome surfaces. They use
`EditorDialog`/`EditorPopover`, standard pane anchoring, layer scope, and
focus/Escape handling. Do not let a dialog own a second object selection or
render an outcome outside the chrome registry.

## Cross-lane boundaries

The block surface owns movement; the table surface owns table chrome; image
ingress owns upload and stable image source. Object controls only provide the
verbs and target handoff. Shared notices and clipboard behavior stay in
`features/editor/chrome`.
