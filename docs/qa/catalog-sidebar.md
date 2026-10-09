# Catalog sidebar convergence

Named risk: a move repair can publish an upsert and then invalidate that same
identity in a later commit. A loaded browser must converge with a fresh catalog,
including after reload and deletion. This recipe is not a current pass claim.

## Setup

1. In an owned worktree, run `pnpm dev:db:prepare` and `pnpm dev --no-tailscale`.
   Discover its HTTPS origins with `pnpm portless:list`.
2. Create an isolated project:

   ```bash
   ./mf api POST /api/projects --data '{"title":"Catalog sidebar probe"}' --json
   ```

   Save its `id` as `$PROJECT`.
3. Seed `a.md`, `Arc/child.md`, and `keep.md` using `./mf doc put <uri>
   --project "$PROJECT" --text <markdown> --json`. Put links to both targets in
   `keep.md` before moving them. Record returned document IDs.
4. Open the owned app origin in an isolated `agent-browser --session
   catalog-sidebar` session. Authenticate at `/api/auth/dev-login`, then open
   `/p/$PROJECT/editor/manuscript/keep.md`. Capture the sidebar and a screenshot.

## Exercise a loaded browser

1. Capture `./mf api GET /api/projects/$PROJECT/context/catalog/snapshot --json`.
   Keep its cursor to fetch changes after mutations.
2. Rename `a.md` to `b.md` through the UI, or use this request with the seeded
   document ID in `$DOCUMENT`:

   ```bash
   ./mf api POST "/api/projects/$PROJECT/context/manuscript/move" --data \
     "{\"operationId\":\"$(cat /proc/sys/kernel/random/uuid)\",\"path\":\"a.md\",\"destinationScheme\":\"manuscript\",\"destinationFolderPath\":\"\",\"newName\":\"b.md\",\"expected\":{\"kind\":\"file\",\"nodeId\":\"$DOCUMENT\"}}" --json
   ```

3. Without reloading, check `b.md` appears and `a.md` disappears. Follow the
   original link from `keep.md`; it must open the moved target.
4. Move `b.md` into `Arc`, rename `Arc` to `Moved`, then move the file back to
   the root. Repeat with a folder moved into and out of another folder.
   Expand each destination; check both identity and path.
5. Rename the target again, then delete it with `./mf doc rm <uri> --project
   "$PROJECT"`. Check it disappears without reload and its link no longer
   resolves as a live document.
6. Reload the same browser, then open the project in a second isolated
   session. Both sidebars must agree with the authoritative snapshot. Record
   screenshots and the browser IndexedDB catalog checkpoint, not just HTTP.

## Feed invariant

Fetch `context/catalog/changes?cursor=<URL-encoded-cursor>` through `./mf api`.
Every `invalidate-subtree` removes the old root and descendants. Its same
whole commit must upsert every surviving affected entry, even unchanged ones.
A removed subtree has no surviving entries. The installed checkpoint contains
only the complete resulting entries, never a persistent invalidated/hidden set.

For deterministic repair-order evidence, run `pnpm test
packages/resource-replica/src/catalog.test.ts` and `pnpm test:db
context-catalog.db.test.ts`; runtime timing need not produce split commits on
every move.

## Cleanup

Close only the owned browser sessions (`agent-browser --session
catalog-sidebar close`, and the fresh session). Stop this worktree with
`pnpm dev --stop`. Keep feeds, screenshots, command logs, and outcomes in the
active work directory; do not clear another session or database.
