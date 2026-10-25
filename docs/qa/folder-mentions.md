# Folder mentions

Checks that `@` can mention a folder in the composer and the Editor, and that a
folder chip opens the drill-in menu inside its folder, wherever the folder now
lives.

Use this checkout's `pnpm dev` stack and the URLs from `pnpm portless:list`.
Sign in with dev-login. Seed a chat with `./mf seed tools/mf/fixtures/basic.json`,
then a folder with one document and an empty subfolder:

```bash
./mf doc put "manuscript://Act 1/Opening.md" --text "Opening scene"
./mf doc put "manuscript://Act 1/Battle/Draft.md" --text "Draft"
./mf doc rm "manuscript://Act 1/Battle/Draft.md"   # leaves Battle empty
```

1. **Picker.** In the chat composer type `@`, choose Manuscript, then Act 1.
   The first row under Back reads "Mention Act 1" with a folder icon. Pressing
   Act 1's row in the Manuscript listing drills into it; it doesn't insert
   anything. Battle is listed even though it is empty, and drilling into it
   shows "Mention Battle" in place of "This folder is empty." The Manuscript
   listing itself has no Mention row. Typing a search inside Act 1 hides the
   Mention row.
2. **Composer chip.** Choose "Mention Act 1". The chip looks like a document
   chip, with a folder icon and the label Act 1. Reload: the chip returns.
   Copy the chip and paste it into the same composer: it pastes as a folder chip.
   Copy it again, open a document, and paste into the Editor: the pasted link
   keeps its folder icon and opens inside Act 1 rather than becoming a missing
   document link.
3. **Composer menu.** Click the chip. The menu opens inside Act 1: Back,
   Opening, Battle. Battle drills, Back climbs to Manuscript, and Opening opens
   the document. Enter on the focused chip opens the same menu. Focus the chip
   and press Shift+F10: the reference-editing menu opens with Edit display text,
   Change reference, and Remove reference. Its accessibility role is button and
   it exposes a menu popup.
4. **Editor link.** Open Opening in the Editor and type `@`, then mention Act 1.
   The link chip has a folder icon; the stored Markdown (`./mf doc read
   "manuscript://Act 1/Opening.md"` after the save) is
   `[Act 1](<../Act 1/>)`. Hover shows Act 1. Click it: the drill-in
   menu opens below the link. Escape closes it and returns the caret to the
   prose. The link menu's Open does the same.
5. **Rename, then click.** Rename Act 1 to "Act One" in the sidebar. The prose
   label stays as written, while the Editor hover and every opened menu use
   "Act One". Clicking the Editor or composer chip opens inside Act One.
6. **Transcript and model input.** Send a message with the folder chip. It has
   the folder icon, and clicking it opens inside the folder. Rename or move the
   folder, then click the sent chip again: the menu opens at the current
   location, while the message text keeps its send-time label. Focus it and
   press Shift+F10: its context menu opens. Run `./mf thread
   context <thread>` and confirm the user message contains the send-time
   Markdown link (`[Act 1](<manuscript://Act 1/>)`). Run `./mf thread view
   <thread> --json` and confirm no folder read was inlined (`readDocuments`
   remains zero). Delete the folder: the chip turns dashed and opens nothing.
7. **Deleted folder in an open menu.** Mention a folder in the composer, delete
   the folder from the sidebar, then click the chip. The menu says "This folder
   is no longer available."
8. **Folder outside the loaded catalogs.** Create another Work and put a note
   under a Scratch folder, then create a manuscript document containing a link
   to that qualified folder. This setup keeps the foreign Work's Scratch out of
   the Editor's local link index:

   ```bash
   project_id=$(./mf project default --json | jq -r .projectId)
   work=$(./mf api POST "/api/projects/$project_id/works" \
     --data '{"name":"Foreign Scratch"}' --json)
   work_id=$(printf '%s' "$work" | jq -r .id)
   work_handle=$(printf '%s' "$work" | jq -r .handle)
   ./mf doc put "scratch://Remote Folder/Seed.md" --work "$work_handle" --text "Seed"
   ./mf doc put "manuscript://Foreign Folder Link.md" \
     --text "[Remote Folder](<scratch://@$work_handle/Remote Folder/>)"
   ```

   Open Foreign Folder Link in the Editor. Remote Folder resolves with a filled
   folder chip, and the console has no `catalog.folderAt is not a function`
   error. Delete the Work with `./mf api DELETE "/api/works/$work_id"`. Without
   reloading, the chip turns dashed: the server's `gone` answer reached a link
   whose target catalog was never loaded by this Editor.

9. **Server identity boundaries.** Create a fresh holder whose first content
   includes a folder link, then rename the folder:

   ```bash
   project_id=$(./mf project default --json | jq -r .projectId)
   ./mf doc put "manuscript://Folder Probe/Child.md" --text "Child"
   ./mf doc put "manuscript://Folder Probe Holder.md" \
     --text '[Folder](<manuscript://Folder Probe/>)'
   snapshot=$(./mf api GET "/api/projects/$project_id/context/catalog/snapshot?scope=project" --json)
   folder_id=$(printf '%s' "$snapshot" | jq -r \
     '.entries[] | select(.kind == "folder" and .uri == "manuscript://Folder Probe") | .entryId')
   child_id=$(printf '%s' "$snapshot" | jq -r \
     '.entries[] | select(.kind == "file" and .uri == "manuscript://Folder Probe/Child") | .entryId')
   no_work_id=$(printf '%s' "$snapshot" | jq -r \
     '.entries[] | select(.kind == "authority" and .authority.workHandle == null) | .entryId')
   operation_id=$(python3 -c 'import uuid; print(uuid.uuid4())')
   ./mf api POST "/api/projects/$project_id/context/manuscript/move" --data "$(jq -nc \
     --arg operationId "$operation_id" --arg nodeId "$folder_id" \
     '{operationId: $operationId, path: "Folder Probe", expected: {kind: "folder", nodeId: $nodeId}, destinationScheme: "manuscript", destinationFolderPath: "", newName: "Folder Probe Renamed"}')"
   ./mf doc read "manuscript://Folder Probe Holder.md"
   ```

   The read returns the Folder link with `Folder Probe Renamed/` as its
   destination: the holder bound the folder ID before the folder moved.

   Resolve a relative directory link from the child, using the same prepared
   address for lookup and resolution:

   ```bash
   ./mf api POST "/api/projects/$project_id/links/resolve" --data "$(jq -nc \
     --arg workId "$no_work_id" --arg holderDocumentId "$child_id" \
     '{workId: $workId, baseUri: "manuscript://Folder Probe Renamed/Child", holderDocumentId: $holderDocumentId, links: [{ref: null, href: "../Folder Probe Renamed/"}]}')" --json
   ```

   The answer is the folder named `Folder Probe Renamed`, not `gone`. Finally,
   send 129 distinct folder identities through the 200-link route boundary:

   ```bash
   python3 - "$no_work_id" <<'PY' >/tmp/folder-links-129.json
   import json, sys, uuid
   print(json.dumps({
       "workId": sys.argv[1],
       "baseUri": None,
       "links": [
           {"ref": f"folder:{uuid.uuid4()}", "href": f"manuscript://Batch {i}/"}
           for i in range(129)
       ],
   }))
   PY
   ./mf api POST "/api/projects/$project_id/links/resolve" \
     --data @/tmp/folder-links-129.json --json | jq '.answers | {length, states: group_by(.state) | map({state: .[0].state, count: length})}'
   ```

   It returns 129 `gone` answers rather than exceeding the availability
   adapter's 128-identity call limit. Clean up the probe:

   ```bash
   ./mf doc rm "manuscript://Folder Probe Holder.md"
   ./mf doc rm "manuscript://Folder Probe Renamed/Child.md"
   operation_id=$(python3 -c 'import uuid; print(uuid.uuid4())')
   ./mf api POST "/api/projects/$project_id/context/manuscript/delete" --data "$(jq -nc \
     --arg operationId "$operation_id" --arg nodeId "$folder_id" \
     '{operationId: $operationId, path: "Folder Probe Renamed", expected: {kind: "folder", nodeId: $nodeId}}')"
   ```

Record the commit, date, stack, outcome and screenshot paths in the active work
directory after a run.
