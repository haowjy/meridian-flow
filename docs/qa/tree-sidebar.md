# Tree sidebar convergence

Named risk: two tabs, or a tab and a fresh profile, show different trees for one project after a
rename, move, delete or create, including one made offline and one made before a reload. The tree
is the replay of the project's list of records, so every copy must replay to the same tree. This
recipe is not a current pass claim.

## Setup

1. In an owned worktree, run `pnpm dev`.
   Discover its URLs with `pnpm dev:urls`.
2. Create an isolated project:

   ```bash
   ./mf api POST /api/projects --data "{\"commandId\":\"$(cat /proc/sys/kernel/random/uuid)\",\"title\":\"Tree sidebar probe\"}" --json
   ```

   Save its `id` as `$PROJECT`.
3. Seed `a.md`, `Arc/child.md`, and an empty `keep.md` using `./mf doc put <uri>
   --project "$PROJECT" --text <markdown> --json`. Record returned document IDs. Markdown the
   seed writes carries no identity, so a path link put there cannot follow a rename.
4. Open the owned app origin in two isolated `agent-browser` sessions (`tree-a`, `tree-b`). The
   stack runs with `DEV_AUTH_BYPASS=1`, so both open signed in. Open
   `/p/$PROJECT/editor/manuscript/keep.md` in each. In `tree-a`, type `@` in `keep.md` and mention
   `a` and `child`, the way the app stores a link (by identity); wait for the save. Capture each
   sidebar.

## Exercise two loaded tabs

1. In `tree-a`, rename `a.md` to `b.md` through the UI. Without reloading, check `b.md` appears and
   `a.md` disappears in both tabs. Follow the original link from `keep.md`; it must open the moved
   target.
2. Move `b.md` into `Arc`, rename `Arc` to `Moved`, then move the file back to the root. Repeat with
   a folder moved into and out of another folder. Expand each destination in both tabs; check both
   identity and path.
3. Rename the target again, then delete it with the UI or `./mf doc rm <uri> --project "$PROJECT"`.
   Both tabs drop it without reload and its link no longer resolves as a live document. It waits in
   Trash; restoring it returns the file at its prior path in both tabs.
4. Take `tree-a` offline (browser network emulation). Rename one file, move another and delete a
   third. `tree-a` shows each at once. `tree-b` shows none of them. Create `new.md` in both tabs
   while `tree-a` is offline. Go back online: both tabs converge to one tree, and the second
   `new.md` keeps both documents, both named `new` (the later's path is `new~…`), never dropped.
5. Reload `tree-a`, then open the project in a third isolated session. All three sidebars must
   agree, and `./mf doc read` at each file's new URI returns its content. Record screenshots.

## Cleanup

Close only the owned browser sessions. Stop this worktree with `pnpm dev --stop`. Keep screenshots,
command logs, and outcomes in the active work directory; do not clear another session or database.

## Chat side panel and document path

Use the owned stack's existing project, plus `./mf thread create --project
"$PROJECT" --title "Empty side panel probe" --json` for a chat with no touches.
Use a chat whose `./mf api GET /api/threads/$THREAD/recent-documents --json`
returns documents for the populated case.

1. On a new chat (`/chats`) with no document open, capture the
   right panel: its header reads Recent, with no browse menu and no hint.
2. Open the untouched chat and capture the same header with an empty list.
3. Open the chat with recent documents. Capture its file rows (no heading of
   their own); confirm they still open the document beside the chat.
4. With a document open beside the chat, capture the header: close and Open in
   Editor together, the path, collapse, and no title chip. Click each crumb: each opens the
   list it sits in with itself highlighted (the area among the areas, a folder
   in its parent, the filename in its folder, `…` where the last hidden folder
   sits), and no two crumbs open the same list. Climb with a back row: the folder left behind is
   highlighted, and climbing past the area reaches the area list without a
   heading. Pick a file: it opens in main.
5. Use `Manuscript/Book 1/Part Two/Act 2/chapter-2.md` to resize the
   Editor through the full-path boundary (including a 1077px viewport), then
   drag the side panel's divider through last-folder, no-folder, and area-icon
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

## Shared list entry interactions

Named risks: list shells dispatch different actions; Scratch loses a pending
delete when a row remounts; Work Files folders expose no management actions.

In an owned project, seed two Manuscript folders and an editable Work's Scratch
with two folders and a note. Open a chat bound to that Work (for example Beats).

1. In Files tree, chat Scratch, and Work Files, rename a file in place, move it
   to another folder, then delete it. Each step says "Undo" in the row's trailing place,
   with no toast; the deleted row stays struck through in its place until the next action
   there, and the file waits in Trash. Restore it there: the file returns at its prior path, and
   `./mf doc read` returns its content. Keep all operations
   in the isolated project.
2. In Work Files, repeat Rename and Delete on a populated folder. Its menu
   must also offer Move…. Delete removes the folder and descendants at once.
   Archived Work folders and files must expose no actions.
3. Scratch's menus offer only Rename, Move… and Delete (no create commands).
   When Earlier notes are present, delete a lineage entry and a Work entry in
   turn. Each leaves the surface that owned it.
4. At phone width, repeat file and folder Rename, Move… and Delete from
   Files. The folder tap target must still drill in independently.
5. A new Work note must still open its naming field when it arrives. Cancelling
   the field keeps the note; renaming it clears the pending naming request.

## Folder deletion and Scratch lineage

1. Create a `zz-probe` No Work chat with `./mf thread create`, and script an AI
   `write create` to `scratch://zz-probe-note.md` on an owned mock-provider stack.
   Open the note beside the chat.
2. Trash the last live chat with `./mf api DELETE /api/threads/$THREAD --data '{"commandId":"<uuid>"}'`. While
   hidden, follow a link to the note: expect "not available", never a Trash entry.
3. Restore with `./mf api POST /api/threads/$THREAD/restore --data '{"commandId":"<uuid>"}'`. Reopen the chat
   and Scratch. The same note must return in the loaded profile and in a fresh one.
   Repeat with Work trash/restore cascading over the lineage's chats.
4. Seed a `zz-probe` folder with nested documents. Keep descendants open in
   main, the side and kept (open one, then another, with a chat in between). Delete the folder
   from its list: the folder's row is struck through with "Undo" at once, its rows go, and the
   open documents close with nothing said.
   Repeat offline, reload, then reconnect: the delete lands once and the tree agrees in a second tab.
5. Delete a Scratch note independently, then trash and restore its No Work chat
   and its Work. The independently deleted note never returns.
6. Open a folder descendant and confirm it appears in Recently opened. Delete the parent.
   Recently opened loses the link, and a reload of its list omits the deleted document.
7. A deleted file disappears from Chat Recent despite a cached touches response.
   A live renamed file uses its current name; a not-yet-loaded identity
   may still use its touch-row name.

Clean up `zz-probe` notes and chats and close only the owned browser profiles.
