# The server Copy command

Named risks: a copy points a link or an image at the original when the target was
copied with it, reveals a hidden draft document or lets one take its name, leaves
a partial tree or a duplicated object behind when it fails, answers a retry with the
first stale answer for ever, scatters the roots of one drop, copies a root twice when a
selection nests, or holds a lock that stalls every writer of the destination while a big
tree is written. This recipe drives
the server with `./mf` (`doc copy` shares no client code; it is evidence of the
server only). The browser's Copy has its own recipe, [Copy in the tree](copy-browser.md).

## Setup

1. Start an owned stack on the mock model (`MODEL_PROVIDER=mock pnpm dev`) and find
   its origins with `pnpm portless:list`. If `./mf` refuses the checkout's routes
   (the Portless proxy listens on a port other than 443), set `MF_SERVER_URL` and
   `MF_APP_URL` to the two origins, and pass `--project <id>` when running several
   `./mf` at once: the default-project bootstrap races.
2. Seed with `./mf doc put` (angle brackets around any address with a space):
   `manuscript://Book/Chapter 1` linking `<Chapter 2>` (not yet written, so it mints
   an ahead ref), `<manuscript://Outside/Sheet>`, an external URL and an image of
   `manuscript://Book/Art/cover.png`; `Chapter 2` linking back to `Chapter 1`, to
   `Part/Inner`, and to `<Empty/Deep>` (also before that folder exists). Make the image with
   `./mf doc copy "uploads://@c1/cover.png" --to "manuscript://Book/Art"`, and the
   empty folders with `./mf api POST
   .../context/manuscript/create --data '{"type":"folder","path":"Book/Empty/Deep"}'`.
3. A Work in draft mode with a chat bound to it (`./mf thread create --work w1`).

## Steps

1. **Rich folder.** `./mf doc copy "manuscript://Book" --to "kb://Dest"`. Every
   created identity prints, empty folders included. In the copy, `Chapter 1` links
   to the copy of `Chapter 2` (the settled ahead ref) and still to the original
   `Outside/Sheet`, and the image to the copy of `cover.png` (`document_links`:
   `doc:` and `asset:` keys). `Chapter 2` links to the copies of `Chapter 1` and
   `Inner`, and its `<Empty/Deep>` — an ahead ref minted before that folder existed —
   reads as the copy's folder ref `Empty/Deep/` (folder refs have no `document_links`
   row). The source's links are unchanged.
2. **Hidden occupant.** A draft-mode chat creates `kb://Hidden/Sheet` and
   `kb://Hidden/Vault/Note` (`./mf thread send <chat> go --mock @script.json`, a
   `write` create each). Copy a live `Sheet` and a live `Vault` folder into
   `kb://Hidden`: the copies take the names `Sheet` and `Vault` (a hidden node never
   vetoes a visible one), and the hidden rows stay hidden and yield to `Sheet (2)` and
   `Vault (2)` in the draft, still holding the draft's text. The same copy where the
   name is held by a live document lands at `Sheet (2)`.
3. **Draft source.** The same chat overwrites `manuscript://Outside/Sheet` in its
   draft. Copy it with `--draft-work w1`: the copy holds the draft text and
   `metadata.copiedFrom.version` is `draft`. Copy without the flag: the live text,
   `live`. A folder with a draft view is refused (`invalid_operation`). The draft is the
   Work's, whichever chat wrote it: rebind the chat to another Work, and `--draft-work w1`
   still copies Work w1's draft. A Work that holds no draft of the document (`--draft-work`
   a second Work) is refused with `invalid_operation` reason `no_draft`, never the
   live text.
4. **Fifty documents.** Copy a folder of 50 documents linking in a ring. All 50 land
   in one transaction (about 4 s here, most of it reading the sources before any
   lock), the ring closes inside the copy, and concurrent copies into one folder get
   distinct names with no deadlock.
5. **Failure on the last child.** In a folder of two binaries delete the stored
   object of the one that sorts second (`/tmp/meridian-object-store/copies/…`), then
   copy the folder. The answer is `io_error` (retryable), no folder or document row
   was written, and the object the first binary duplicated is released (the
   `copies/` count is unchanged).
6. **Replay.** POST one `operationId` twice: the same identities answer and one copy
   exists. Delete the copy and send it a third time: still the original answer, no
   resurrection. A refusal replays as the same refusal. The same `operationId` with
   another destination answers `operation_mismatch`.
7. **Source not caught up.** POST a source with `stateVector` one client edit ahead of
   the room: after a wait of about 2 s, `io_error` ("The source has edits the server has
   not received yet") with `details.reason: "source_behind"`, `retryable: true`, and no
   `context_operation_receipts` row. Resend the same `operationId` with the room's own
   vector: it copies and the receipt appears. A vector that arrives within the wait (a
   client reconnecting 800 ms after the request) copies on the first send. With
   `view: draft` the vector is compared with the draft room. A `stateVector` on a folder
   source and one that does not decode (`////////`) are `bad_request`.
8. **Position and order.** Copy two roots with `--position after:<P1>` into a default
   parent holding `P1 P2 P3`: the order is `P1 root-1 root-2 P2 P3` and the parent
   is manual. Copy a root with no position into that manual parent: it lands last.
   Copy a manually ordered folder into a default and a manual parent: the copy keeps
   the source's child order and its manual policy.
9. **Refusals.** Uploads as the destination (`bad_request`), a folder into its own
   subtree and into itself ("Can't go inside itself"), a path nothing holds and an
   identity another entry holds (`not_found`), a destination folder identity that was
   deleted or never existed (`destination_missing`), a destination path that is a
   document (`conflict`), a path with `..` (`bad_request`), an uploads folder named by
   identity as the destination (`bad_request`, the same out-only answer as by path),
   and a draft view whose Work belongs to another project or does not exist
   (`context_unavailable`, `work_missing`). Each answer is typed and non-retryable.
10. **Other owners.** Copy a Work's Scratch folder into a project area, a project
    document into a Work's Scratch and into a chat's Scratch, an upload out into a
    Work's Scratch, and a chat lineage Scratch note out. A Work note's link to the
    project keeps its target; its link to a sibling copied with it names the sibling's
    copy.
11. **The model's copy.** Send `write` `{command: "copy", path, from: {path}}` on the
    mock model for a document that links to itself: the copy's own link names the
    copy, and its other links keep their targets. The turn's live lineage gives the
    copy `tree: {op: "copy", from, to}`, which the chat receipt reads as
    `Copied <source> to <name>`. The model names the exact path, so a path another
    entry holds answers `invalid_write` ("File already exists: …") as a typed tool
    error and creates nothing; the model chooses another path. The command's copy
    instead plans a free name (steps 2 and 17).
12. **Arrival.** Write a link to an address that does not exist yet, then copy a
    document to that address: `link_ahead_refs.settled_document_id` is the copy.
13. **Nested selection.** `./mf doc copy "manuscript://Book" "manuscript://Book/Ch1"
    --to kb://Nested` (and the child first, and a root named twice): one `Book` copy
    holds `Ch1`, no stray `Nested/Ch1` exists, and a sibling's link to `Ch1` names the
    copy inside the folder. Two roots that do not nest still copy separately.
14. **The model's excerpt.** Send `write` `{command: "copy", path: "…/Excerpt", from:
    {path: "…/Src#part-a"}}` for a source that links to itself: the excerpt's links
    still name `Src`. Copying the whole document names the copy (step 11).
15. **A big tree.** Copy 200 chapters of about 1,500 words, each linked to its
    neighbours, into a new folder while a script puts a document into the destination
    tree and into an unrelated source folder every second. Each of those puts waits
    about a second at most (an idle put takes 0.1-0.3 s); on the previous code every
    put waited as long as the copy took, 40 s or more. The 200 rows show one
    transaction start, and `document_links` holds the copies' links when the copy
    returns.
16. **Cold rooms.** Restart the server and copy 40 documents that were never opened at
    once into distinct folders: all 40 answer 200. (Before the reads moved out of the
    transaction, ten or more of them held every pool connection and waited for one
    more.)
17. **A taken name.** While a `./mf doc copy` prepares, create the folder or file it
    would take in the destination: the copy lands under the next free name (`Book (2)`)
    and its internal links name the copy. Only a temporary sleep between the plan and
    the lock makes the race reproducible, so no step here reaches it without one. The
    model's copy has no plan to reallocate, so it refuses instead; step 11.

## Cleanup

Delete the probe folders, then stop the stack with `pnpm dev --stop`.
