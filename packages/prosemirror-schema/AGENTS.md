# @meridian/prosemirror-schema

Shared ProseMirror structural contract used by TipTap/Yjs editor code.

- Preserve structural compatibility between server document logic and the app's
  separately built TipTap editor. `apps/app/src/core/editor/schema-parity.test.ts`
  mechanically guards node/mark names and structural specs.
- Export structural node/mark specs, `buildDocumentSchema()`, schema versioning,
  the shared fragment name, reserved client-ID policy, and the Y.Doc factory.
  DOM parsing/rendering belongs to TipTap extensions and markdown serializers,
  not this package.
- Keep `PROSEMIRROR_FRAGMENT_NAME` as the shared Y.XmlFragment name used by the
  frontend editor and server Yjs mirror.
- Treat `createCollabYDoc()` and the reserved clientID band constants as shared
  collab protocol: random-authoring docs use the factory so they never draw the
  server-owned clientID band `[0, RESERVED_CLIENT_ID_MAX]`.
- Keep this package independent from React components, TipTap runtime objects,
  database adapters, and server domain code.

## Schema version bump policy

`src/schema-shape.history.json` is the append-only record of collab schema
versions and surfaces protected by `src/schema-shape.test.ts`. Never modify or
remove an existing entry. Append the new version and surface so the test can
classify the transition from its immutable predecessor.

| Change | Version class |
|---|---|
| Surface identical | No bump required; patch allowed |
| New node/mark, or new attribute with a default | Minor `x.(y+1).0` |
| Content expression or attribute default changed | Next minor `x.(y+1).0` or next major `(x+1).0.0`; review must confirm the minor path only loosens the schema |
| Node/mark/attribute removed or renamed, fragment renamed, or Yjs encoding changed | Major `(x+1).0.0`, human ruling, and migration plan |

Minor is additive even for `0.x`. Patch changes must keep the surface
identical. A major is expected never; do not append an entry around a
removal or encoding change without the required ruling and migration plan.
Schema changes must still update TipTap extensions, markdown adapters, and
schema parity coverage together.

See [`.context/CONTEXT.md`](.context/CONTEXT.md) for the schema surface and
compatibility rules.
