# @meridian/prosemirror-schema

The shared ProseMirror structural contract for the TipTap/Yjs editor and server
collab code. DOM and editor runtime behavior live outside it.

- The app builds its TipTap schema separately. Any node, mark or attr change updates
  `apps/app/src/core/editor/extensions/meridian-extensions.ts` in the same commit;
  `apps/app/src/core/editor/schema-mirror.test.ts` guards that mirror.
- Random authoring docs use `createCollabYDoc()`, which avoids the reserved
  server-authored client-ID band.

Compatibility seams: [`.context/CONTEXT.md`](.context/CONTEXT.md).

## Schema version bump policy

`src/schema-shape.test.ts` checks each transition in `src/schema-shape.history.json`
against this table and fails an edited entry. It cannot judge the two rows that need review:

| Change | Version class |
|---|---|
| Surface identical | No bump required; patch allowed |
| New node or mark, or new attribute with a default | Minor `x.(y+1).0` |
| Content expression or attribute default changed | Next minor or next major; review confirms the minor path only loosens the schema |
| Node, mark or attribute removed or renamed, fragment renamed, or Yjs encoding changed | Major `(x+1).0.0` |
| A change that alters what stored content means (such as an added attribute) | Major |

A major needs a human call and a migration or reset plan, recorded in the entry's
`compatibilityNote`.
