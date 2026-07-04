# Draft undo runtime fixtures

Captured from local draft-review runtime sessions where browser/user undo rows differed from synthetic Yjs unit rows.

Expected shape:

- `liveCheckpointB64`: `document_yjs_checkpoints.state` for the live document before draft updates are replayed.
- `sequences`: named ordered `document_yjs_draft_updates` rows. Each row preserves its database `id`, actor attribution, and base64-encoded `update_data`.

Regenerate with:

```bash
DATABASE_URL=... pnpm exec tsx tools/collab/capture-draft-undo-fixture.ts \
  --document-id <uuid> \
  --sequence A:<draft-id> \
  --sequence B:<draft-id> \
  > apps/server/server/domains/collab/domain/__fixtures__/draft-undo-runtime/phase2.fixture
```
