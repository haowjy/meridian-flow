# @meridian/prosemirror-schema

Shared ProseMirror structural contract used by TipTap/Yjs editor code.

- Preserve structural compatibility between server document logic and the app's
  TipTap editor. `apps/app/src/core/editor/schema-parity.test.ts` is the guard.
- Export structural node/mark specs and `buildDocumentSchema()` only. DOM
  parsing/rendering belongs to TipTap extensions and markdown serializers, not
  this package.
- Keep `PROSEMIRROR_FRAGMENT_NAME` as the shared Y.XmlFragment name used by the
  frontend editor and server Yjs mirror.
- Treat `createCollabYDoc()` and the reserved clientID band constants as shared
  collab protocol: random-authoring docs use the factory so they never draw the
  server-owned clientID band `[0, RESERVED_CLIENT_ID_MAX]`.
- Keep this package independent from React components, TipTap runtime objects,
  database adapters, and server domain code.

See [`.context/CONTEXT.md`](.context/CONTEXT.md) for the schema surface and
compatibility rules.
