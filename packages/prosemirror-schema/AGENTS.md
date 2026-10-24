# @meridian/prosemirror-schema

The shared ProseMirror structural contract for the TipTap/Yjs editor and
server collab code: node and mark specs, schema versioning, the Yjs fragment
name, client-ID policy and the Y.Doc factory. DOM and editor runtime behavior
live outside it, and it depends on no React, TipTap runtime objects, database
adapters or server domains.

## Rules

- Keep the app's separately built TipTap schema structurally aligned with this
  package. Any node, mark, or attr change updates
  `apps/app/src/core/editor/extensions/meridian-extensions.ts` in the same
  commit; no test mechanically guarantees that mirror.
- `PROSEMIRROR_FRAGMENT_NAME` is the shared Y.XmlFragment name. Import it from
  the protocol subpath when a consumer only needs the name.
- Random authoring docs use `createCollabYDoc()` so they avoid the reserved
  server-authored client-ID band. Review restoration belongs to the diff kernel,
  not this schema package.
- Compatibility seams between the schema, the editor and Yjs:
  [`.context/CONTEXT.md`](.context/CONTEXT.md).

## Schema version bump policy

`src/schema-shape.history.json` is the append-only record of collab schema
versions and surfaces; `src/schema-shape.test.ts` checks each transition
against this table. Never modify or remove an entry: append the new version and
its surface.

| Change | Version class |
|---|---|
| Surface identical | No bump required; patch allowed |
| New node or mark, or new attribute with a default | Minor `x.(y+1).0` |
| Content expression or attribute default changed | Next minor or next major; review confirms the minor path only loosens the schema |
| Node, mark or attribute removed or renamed, fragment renamed, or Yjs encoding changed | Major `(x+1).0.0` |
| A change that alters what stored content means (such as an added attribute) | Major |

Minor is additive even in `0.x`, and a patch keeps the surface identical. A
major needs a human call and a migration or reset plan, recorded in the entry's
`compatibilityNote`. Past majors are listed in
[`.context/CONTEXT.md`](.context/CONTEXT.md).
