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

## Chat side panel and document path

Use the owned stack's existing project, plus `./mf thread create --project
"$PROJECT" --title "Empty side panel probe" --json` for a chat with no touches.
Use a chat whose `./mf api GET /api/threads/$THREAD/recent-documents --json`
returns documents for the populated case.

1. On the Chat index with no chat selected and no document open, capture the
   right panel: its header reads Recent (or the view switch, when Changes is
   offered), with no browse menu and no hint.
2. Open the untouched chat and capture the same header with an empty list.
3. Open the chat with recent documents. Capture its file rows (no heading of
   their own); confirm they still open the document beside the chat.
4. With a document open beside the chat, capture the header: close, the path,
   Open in Editor, collapse, and no title chip. Click each crumb: an area or
   folder opens inside itself, the filename inside its folder, `…` one level
   above the crumb after it. Climb with a back row: the folder left behind is
   highlighted, and climbing past the area reaches the area list without a
   heading. Pick a file: it replaces the document beside the chat.
5. At phone width, confirm existing full-screen document/navigation surfaces
   are unchanged. Do not expect a desktop right panel or add a phone equivalent.

Save screenshots and the two recent-documents responses in the active work
directory. Close only the browser session used for this probe.

## List moves and passive document failures

Named risks: Work Files exposes an unhandled Move command; a homed document's
refusal opens a name-only field; move retry loses a queued rename.

1. Open an editable Work's Files tab. On a Scratch file, choose Move… from its
   Actions menu. Drill to a different folder and submit. Check the file leaves
   the old list and its new URI reads through `./mf doc read`.
2. Keep a homed chapter open. For one move request, inject a typed terminal
   HTTP 409 with `{code: "conflict", message: "Probe refusal", source: "system",
   retryable: false}` into the owned browser's fetch. Move it from the file list.
   After reconciliation, the path bar must show its original path and a passive
   failure icon. Its tooltip names the rejected folder and says to use Move…
   in the file list. Clicking the mark must not open a placement/name field.
3. Repeat with a refused Rename. The list may offer its inline name repair;
   the path bar only directs retry to Rename in the file list.
4. Restore native fetch. Retry through the list. For a cancelled rename/move
   chain, check the request's name is the retained destination name, not the
   restored original name. Collision validation must use that retained name too.
5. Restore any moved probe file and the Work's original lifecycle state. Save
   screenshots and requests in the active work directory. Never leave fetch
   interception installed in the shared browser session.
