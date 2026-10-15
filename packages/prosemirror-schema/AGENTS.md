# @meridian/prosemirror-schema

Shared ProseMirror structural contract used by the TipTap/Yjs editor and server
collab code. It owns node and mark specs, schema versioning, the Yjs fragment
name, client-ID policy, and the Y.Doc factory; DOM and
editor runtime behavior stay outside this package.

## Rules

- Keep the app's separately built TipTap schema structurally aligned with this
  package. Any node, mark, or attr change updates
  `apps/app/src/core/editor/extensions/meridian-extensions.ts` in the same
  commit; no test mechanically guarantees that mirror.
- `PROSEMIRROR_FRAGMENT_NAME` is the shared Y.XmlFragment name. Import it from
  the protocol subpath when a consumer only needs the name.
- Random authoring docs use `createCollabYDoc()` so they avoid the reserved
  server-authored client-ID band.
- A schema version change follows the append-only history and compatibility
  rules in [`.context/CONTEXT.md`](.context/CONTEXT.md).

Keep this package independent from React, TipTap runtime objects, database
adapters, and server domains.

## Schema version bump policy

`src/schema-shape.history.json` is the append-only record of collab schema
versions and surfaces protected by `src/schema-shape.test.ts` (which points
here). Never modify or remove an existing entry; append the new version and
surface so the test can classify the transition from its predecessor.

| Change | Version class |
|---|---|
| Surface identical | No bump required; patch allowed |
| New node/mark, or new attribute with a default | Minor `x.(y+1).0` |
| Content expression or attribute default changed | Next minor or next major; review must confirm the minor path only loosens the schema |
| Node/mark/attribute removed or renamed, fragment renamed, or Yjs encoding changed | Major `(x+1).0.0`, human ruling, and migration plan |
| Any change a human ruling declares major (an added attr that changes what stored content means) | Major; the entry's `compatibilityNote` cites the ruling and the reset or migration |

Minor is additive even in `0.x`, and a patch must keep the surface identical.
A major is expected never: do not append an entry around a removal or encoding
change without the ruling and migration plan. `1.0.0` added `ref` to `link`,
`image` and `figure` by ruling (#729/#730): old heads are unreadable and collab
state is reset, not migrated.
