# core/editor — collaborative editor runtime

The browser TipTap schema, the Yjs document-session binding and editor-only
projections. It is not the server persistence authority; feature surfaces consume
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
- Remote writes rebuild the whole ProseMirror document and can move or replace
  anything while a menu, picker, drag or review operation is open. Hold identity
  with `EditorAnchor`/`NodeHold`, then resolve and validate at use time. Never trust
  a raw position or DOM element.
- Only `local-presence.ts` may call `setLocalState*`; don't expose raw Awareness to
  an extension. Awareness cursor colors are design tokens, resolved to concrete RGB hex before
  publication (y-prosemirror accepts concrete colors only).
- Peer marks are projections: never persisted, draft-projected, or locally authored.
- Reading memory persists only account-stamped Yjs anchors and dimensionless
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
- Draft identity is stable until close. Terminal draft retirement never transfers
  queued unacknowledged updates to a replacement draft, and review projection never
  replays a retired snapshot or transfers selection to a replacement
  ([session contract](.context/CONTEXT.md)).

Child areas: [chrome](chrome/AGENTS.md), [objects](objects/AGENTS.md),
[images](images/AGENTS.md), [links](links/AGENTS.md),
[diagrams](diagrams/AGENTS.md), [blocks](blocks/AGENTS.md),
[viewer](viewer/AGENTS.md), [`@`](extensions/at-reference/AGENTS.md),
[auto-pair](extensions/auto-pair/AGENTS.md), [`/`](extensions/slash/AGENTS.md),
[completion menus](../completion/AGENTS.md).

Depth: [`.context/CONTEXT.md`](.context/CONTEXT.md) (session, anchor, projection and
landing contracts), [`.context/TODO.md`](.context/TODO.md).
