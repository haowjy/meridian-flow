# core/editor — collaborative editor runtime

The browser TipTap schema, the Loro document-session binding (`@meridian/loro-prosemirror`
over `RoomDocs`) and editor-only projections. It is not the server persistence authority; feature surfaces consume
the headless seams here.

- Assemble collaborative extensions only through `createEditorExtensions()`. The
  TipTap schema and `@meridian/prosemirror-schema` are built separately and only
  type and attr names are tested (`schema-mirror.test.ts`), so a node or attr is a
  two-file change. An extension may not add node or mark types the shared schema
  lacks unless the schema package and the server Markdown adapter change in the
  same PR.
- Put every construction fact for a mount in `EditorMountIdentity`; reconcile
  editability and `editorProps` as live `EditorSurfaceOptions`, never by rebuilding
  from an effect dependency.
- Remote writes rebuild the blocks they touch and can move or replace
  anything while a menu, picker, drag or review operation is open. Hold identity
  with `EditorAnchor`/`NodeHold`, then resolve and validate at use time. Never trust
  a raw position or DOM element.
- Only `local-presence.ts` writes the presence `EphemeralStore`; don't expose the raw store
  to an extension. Cursor colors are design tokens, resolved to concrete RGB hex before
  publication.
- The editor shows Live only. Drafts, suggestion paint and peer marks are gone until phase 2
  brings drafts back as Loro forks; don't add a second attribute view.
- Undo is the binding's `UndoHistory` (`editor-history.ts` wraps it): a step's text goes back
  through a Loro `UndoManager` per text doc the tab changes, its structure values through the
  rule in `document-model`'s `take-back.ts`, so Ctrl+Z after a collaborator's edit undoes only
  the writer's. A step someone else wrote over stays whole, with the steps that share its
  paragraphs, and Ctrl+Z goes on to the one before (design §2); `DocumentHistory.run` returns the
  run, whose `stayed` counts them. A doc-changing transaction marked `addToHistory: false` commits under
  `UNTRACKED_ORIGIN` and closes the open step; any other local write into the session's docs
  outside the editor must commit under it too, or the next Ctrl+Z on that doc stops at it.
- Positions that must survive remote writes are Loro cursors (`loro-points.ts`), and nodes are
  found by block id (`findBlock`), never by a stored offset.
- Reading memory persists only account-stamped Loro cursors and dimensionless
  viewport offsets. Only a new mount restores, without taking focus; an explicit
  destination always beats mount-time memory, so every new jump path claims through
  `reading-position-navigation.ts`.
- Drops and presses with no text under them have one landing authority, `landing/`.
  Layout code and lanes never place a drop themselves, and StarterKit's dropcursor
  stays off. Policy: the editor context.
- Editor-owned keys stay consumed on a refusal (Tab would otherwise move focus out
  of the manuscript).
- Chrome owns Escape, context claims, hover and key scopes; object registration owns
  object physics; the suggestion lane owns trigger specs. Extensions register with
  those seams rather than binding private listeners.
- A picture enters as a document node before upload; see
  [`images/AGENTS.md`](images/AGENTS.md).
- Every `RoomDocs` has one owner, the `DocumentSession`, which frees it on close; nothing else
  calls `free()` on it ([session contract](.context/CONTEXT.md)).

Child areas: [chrome](chrome/AGENTS.md), [objects](objects/AGENTS.md),
[images](images/AGENTS.md), [links](links/AGENTS.md),
[diagrams](diagrams/AGENTS.md), [blocks](blocks/AGENTS.md),
[viewer](viewer/AGENTS.md), [`@`](extensions/at-reference/AGENTS.md),
[auto-pair](extensions/auto-pair/AGENTS.md), [`/`](extensions/slash/AGENTS.md),
[completion menus](../completion/AGENTS.md).

Depth: [`.context/CONTEXT.md`](.context/CONTEXT.md) (session, anchor, projection and
landing contracts), [`.context/TODO.md`](.context/TODO.md).
