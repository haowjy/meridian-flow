# core/editor — collaborative editor runtime

This directory owns the browser TipTap schema, Yjs document-session binding, and editor-only projections. It is not the server persistence or change-trail authority;
feature surfaces consume the headless seams here.

## Mental model

One mounted editor binds to one Yjs document fragment through the
`DocumentSessionRegistry`. Construction identity determines the React mount; surface options update a live editor. Anchors and `NodeHold`s carry identity across
the whole-document ProseMirror rebuild caused by remote Yjs writes.

## Rules that protect the boundary

- Assemble collaborative extensions only through `createEditorExtensions()`.
  Keep its TipTap schema structurally aligned with
  `@meridian/prosemirror-schema`, and use the shared
  `PROSEMIRROR_FRAGMENT_NAME` and one sync path. The two schemas are built
  separately and parity is not enforced, so a node or attr is a two-file change.
  An extension may not add node or mark types the shared schema lacks unless
  the schema package and the server Markdown adapter change in the same PR.
- `mounted-editor.ts` constructs and destroys TipTap through the session binding
  seam. Put every construction fact in `EditorMountIdentity`; reconcile
  editability and `editorProps` as live `EditorSurfaceOptions`, never by
  rebuilding from an effect dependency.
- The session owns one schema-repair witness and one local-presence write port.
  Repairs are reported, not fenced; presence suspension and client rotation
  preserve desired fields. Do not expose raw mutable Awareness to an extension.
- Reading memory persists only account-stamped Yjs anchors and dimensionless
  viewport offsets. Review rooms never consume or overwrite live positions.
  Only a new mount restores, without taking focus; an explicit destination
  always beats mount-time memory, so every new jump path claims through
  `reading-position-navigation.ts`.
- `pointer-boundary.ts` is the one answer for presses outside prose. It keeps
  caret placement, opaque-object refusal, seam precedence, and keyboard parity
  out of layout components; see the editor context for the geometry policy.
- Peer marks are projections: never persisted, draft-projected, or locally
  authored. Awareness cursor colors are concrete RGB hex before publication;
  only `local-presence.ts` may call `setLocalState*`.
- A picture enters as a document node before upload. Its stable source is an
  `asset:` identity, an address, or the empty pending slot; signed URLs and
  progress never enter Yjs. See [`images/AGENTS.md`](images/AGENTS.md).
- Shared editor policy has one owner: Chrome owns Escape, context claims,
  hover, and key scopes; object registration owns object physics; the suggestion
  lane owns trigger specs. Extensions register with those seams rather than
  binding private listeners.
- Draft identity is stable until close. Terminal draft retirement never transfers
  queued unacknowledged updates to a replacement draft; see [the session contract](.context/CONTEXT.md).
- Draft sessions persist locally under their room name. Review projection reads
  the mounted document and its server-owned review base; it never replays a
  retired snapshot or transfers selection to a replacement draft.
- Editor-owned keys remain consumed on refusals, and table drops have one
  landing authority. The Tab ladder, cell Enter behavior, dropcursor policy,
  diagram faces, and `@` delimiter rule are in the editor context.
- Remote writes can move or replace anything while a menu, picker, drag, or
  review operation is open. Hold identity with `EditorAnchor`/`NodeHold`, then
  resolve and validate at use time. Never trust a raw position or DOM element.

## Child boundaries

- [`chrome/AGENTS.md`](chrome/AGENTS.md) — control-surface policy
- [`objects/AGENTS.md`](objects/AGENTS.md) — registration-driven physics
- [`images/AGENTS.md`](images/AGENTS.md) — image ingress and rendering lifecycle
- [`links/AGENTS.md`](links/AGENTS.md) — link classification and resolution seam
- [`diagrams/AGENTS.md`](diagrams/AGENTS.md) — provider catalog and safe SVG
- [`blocks/AGENTS.md`](blocks/AGENTS.md) — block-drag document plugin
- [`viewer/AGENTS.md`](viewer/AGENTS.md) — disposable pan and zoom
- [`extensions/at-reference/AGENTS.md`](extensions/at-reference/AGENTS.md) — `@`
- [`extensions/auto-pair/AGENTS.md`](extensions/auto-pair/AGENTS.md) — closers
- [`extensions/slash/AGENTS.md`](extensions/slash/AGENTS.md) — `/` spec
- [`../completion/AGENTS.md`](../completion/AGENTS.md) — host-independent menus
→ [`.context/CONTEXT.md`](.context/CONTEXT.md) — session, anchor, and projection contracts; [`.context/TODO.md`](.context/TODO.md) — verified open editor contracts
