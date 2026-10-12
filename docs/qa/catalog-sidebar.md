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
4. With a document open beside the chat, capture the header: close and Open in
   Editor together, the path, collapse, and no title chip. Click each crumb: each opens the
   list it sits in with itself highlighted (the area among the areas, a folder
   in its parent, the filename in its folder, `…` where the last hidden folder
   sits), and no two crumbs open the same list. Climb with a back row: the folder left behind is
   highlighted, and climbing past the area reaches the area list without a
   heading. Pick a file: it replaces the document beside the chat.
5. Use `Manuscript/Book 1/Part Two/Act 2/chapter-2.md` to resize the
   Editor through the full-path boundary (including a 1077px viewport), then
   drag the Chat dock divider through last-folder, no-folder, and area-icon
   fits. Folders must collapse before their names or the filename truncate
   whenever a smaller candidate fits. With last-folder fit, `…` opens inside
   Book 1 and highlights Part Two; with no-folder or icon fit, it opens inside
   Part Two and highlights Act 2. An absent link-update note leaves no empty
   trailing flex item. Close and reopen a crumb: the first displayed menu is
   already at the correct level, and Escape restores focus to that crumb.
6. At phone width, confirm existing full-screen document/navigation surfaces
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
4. Restore native fetch. Reopen Move…: it must start at the refused destination
   with an enabled Move to button, not Already in the current parent. Submit
   without drilling again. If the destination was removed, it instead opens at
   the current parent and retains the refusal message. Retry through the list. For a cancelled rename/move
   chain, check the request's name is the retained destination name, not the
   restored original name. Collision validation must use that retained name too.
5. Restore any moved probe file and the Work's original lifecycle state. Save
   screenshots and requests in the active work directory. Never leave fetch
   interception installed in the shared browser session.


## Shared list entry interactions

Named risks: list shells dispatch different actions; Scratch loses a pending
delete when a row remounts; Work Files folders expose no management actions.

In an owned project, seed two Manuscript folders and an editable Work's Scratch
with two folders and a note. Open a chat bound to that Work (for example Beats).

1. In Files tree, chat Scratch, and Work Files, rename a file in place, move it
   to another folder, and open Delete then Cancel. Verify its content at the new
   URI through `./mf doc read`. Keep all operations in the isolated project.
2. In Work Files, repeat Rename and Delete then Cancel on a folder; its menu
   must also offer Move…. Archived Work folders and files must expose no actions.
3. Scratch's menus offer only Rename, Move… and Delete (no create commands).
   When Earlier notes are present, request Delete on a lineage entry and on a
   Work entry; each opens the same surface dialog with the correct target.
4. At phone width, repeat file and folder Rename, Move… and Delete then Cancel
   from Files. The folder tap target must still drill in independently.
5. A new Work note must still open its naming field when it arrives. Cancelling
   the field keeps the note; renaming it clears the pending naming request.

## Restorable lineage Scratch and folder namespace deletion

1. Create a `zz-probe` No Work chat with `./mf thread create`, and script an AI
   `write create` to `scratch://zz-probe-note.md` on an owned mock-provider stack.
   Open the note beside the chat so the browser installs its resource descriptor.
2. Trash the last live chat with `./mf api DELETE /api/threads/$THREAD`. While
   hidden, query `/api/projects/$PROJECT/context/availability` for the note ID:
   expect `authority-unavailable` with `lineage_hidden`, never `deleted`.
3. Restore with `./mf api POST /api/threads/$THREAD/restore`. Reopen the chat
   and Scratch. The same note must return in the loaded profile, not just in a
   fresh one. Repeat with Work trash/restore cascading over the lineage's chats.
4. Seed a `zz-probe` folder with nested documents. Keep descendants open in
   Editor tabs and the document dock. Delete the folder from its list: the
   dialog and rows disappear after local admission, without waiting for HTTP.
   Descendant tabs and dock close through resource projection. Repeat offline,
   reload, then reconnect: the same journal attempt settles from its receipt.
   Switch accounts during dispatch and return: only the original account settles.
   Inject a typed nonretryable refusal for one delete: the folder and descendants
   return, with a delete failure mark and no rename field.
5. Delete another open folder through `./mf api` using its catalog folder node
   ID. Availability reconciliation closes its tabs and dock (wake/focus/poll),
   without a general durable deletion intake (session authority retains its adopted
   local-origin exception). A delayed delete naming an old folder
   ID at a replacement folder's path must return `stale_target`.
6. Delete a Scratch note independently, then trash and restore its No Work chat
   and its Work. Availability must still say `deleted`, including while its lineage
   is hidden; the independently deleted note never returns.
7. Open a folder descendant and confirm it appears in Recently opened. Go
   offline in the browser and delete the parent. The dialog closes after local
   persistence, the tree/tab/dock closes, and Recently opened loses the link
   before the server deletion runs. Reconnect: the accepted deletion refetches
   `/api/projects/$PROJECT/recent-documents`; its response and the reloaded
   Recently opened list omit the deleted document. No deleted-state view or
   Undo is expected: deletion is permanent.
8. A deleted file disappears from Chat Recent despite a cached touches response.
   A live renamed file uses its current catalog name; a not-yet-loaded identity
   may still use its touch-row name.

Known independent issue: a mounted project can recreate a deleted Work's shared
draft and make Work restore fail ([#761](https://github.com/haowjy/meridian-flow/issues/761)).
Record this separately from Scratch availability; never delete real branches to force restoration.

Clean up `zz-probe` notes and chats and close only the owned browser profiles.
Focused automated proofs: `indexeddb-resource-metadata.test.ts` (atomic folder settlement) and
`lineage-scratch-arrivals.db.test.ts` (both restore doors).

## Shared placement and missing recovery rows (PR #754)

1. Seed `P/A/doc.md` and `B/anchor.md` in an isolated project. Open the first
   document in the Editor and expand both folders. Neither P nor B should have
   a local namespace journal.
2. In an isolated browser session, abort `**/context/manuscript/move` requests.
   Move A into B through its Actions menu. Before reconnecting, A and doc.md
   must appear under B and the open document path must read B / A / doc.md.
   Prose stays mounted. Rename A in place and repeat under an unjournaled parent.
3. Remove interception and trigger online/focus reconciliation. Check the same
   placement after receipt settlement, folder-only availability, full catalog
   convergence, and reload. Read the document through `./mf` at its new URI.
4. Repeat across two named Works: move alpha's B to beta without changing B's
   name, then move beta's X under B/sub. Both row orders must place X at
   `scratch://@beta/B/sub/X`.
5. If availability returns `unavailable` while a move refresh fences a queued
   command, the queued command becomes repair, not deletion. Even without the
   folder's catalog row, its journal identity must remain reachable in the
   tree at its last known home with failure evidence. An entirely missing
   checkpoint also renders the repair source and ancestor chain. Real parent
   and child recovery identities occupy their homes before missing ancestors
   are synthesized, regardless of identity sort order. Synthetic ancestors
   permit navigation but expose no create, rename, move or delete controls.
   These recovery rows do not establish server visibility or catalog completeness.

Automated boundary evidence: `folder-placement-selectors.test.ts` exercises the
real tree and tab selectors through pending, accepted and folder-only refreshed
placements, absent-row/absent-catalog repair, and placement-relative deletion.
`cross-owner-placement.test.ts` guards qualified alias binding. The folder
schedule suite retains its full schedule inventory and validates that any new
non-catalog rows belong to a reachable journal repair chain.

`folder-placement-regressions.test.ts` bounds 200 nested journaled identities
with a missing destination and verifies parent/child recovery identity reuse.
`useRecentDocuments.test.tsx` checks shared pending-delete suppression, refusal
restoration and accepted-delete query invalidation.
