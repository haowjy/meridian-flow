# The server Copy command

Named risks: a copy points a link or an image at the original when the target was
copied with it, reveals a hidden draft document instead of naming around it, leaves
a partial tree or a duplicated object behind when it fails, answers a retry with the
first stale answer for ever, or scatters the roots of one drop. This recipe drives
the server with `./mf` (`doc copy` shares no client code; it is evidence of the
server only). The browser's Copy is a later slice. It is not a current pass claim.

## Setup

1. Start an owned stack on the mock model (`MODEL_PROVIDER=mock pnpm dev`) and find
   its origins with `pnpm portless:list`. If `./mf` refuses the checkout's routes
   (the Portless proxy listens on a port other than 443), set `MF_SERVER_URL` and
   `MF_APP_URL` to the two origins, and pass `--project <id>` when running several
   `./mf` at once: the default-project bootstrap races.
2. Seed with `./mf doc put` (angle brackets around any address with a space):
   `manuscript://Book/Chapter 1` linking `<Chapter 2>` (not yet written, so it mints
   an ahead ref), `<manuscript://Outside/Sheet>`, an external URL and an image of
   `manuscript://Book/Art/cover.png`; `Chapter 2` linking back to `Chapter 1` and to
   `Part/Inner`. Make the image with `./mf doc copy "uploads://@c1/cover.png" --to
   "manuscript://Book/Art"`, and the empty folders with `./mf api POST
   .../context/manuscript/create --data '{"type":"folder","path":"Book/Empty/Deep"}'`.
3. A Work in draft mode with a chat bound to it (`./mf thread create --work w1`).

## Steps

1. **Rich folder.** `./mf doc copy "manuscript://Book" --to "kb://Dest"`. Every
   created identity prints, empty folders included. In the copy, `Chapter 1` links
   to the copy of `Chapter 2` (the settled ahead ref), `Chapter 2` to the copies of
   `Chapter 1` and `Inner`, both still to the original `Outside/Sheet`, and the image
   to the copy of `cover.png` (`document_links`: `doc:` and `asset:` keys). The
   source's links are unchanged.
2. **Hidden occupant.** A draft-mode chat creates `kb://Hidden/Sheet` and
   `kb://Hidden/Vault/Note` (`./mf thread send <chat> go --mock @script.json`, a
   `write` create each). Copy a live `Sheet` and a live `Vault` folder into
   `kb://Hidden`: the copies are `Sheet (2)` and `Vault (2)`, and the hidden rows
   stay hidden and unchanged.
3. **Draft source.** The same chat overwrites `manuscript://Outside/Sheet` in its
   draft. Copy it with `--draft-work w1 --draft-thread <chat>`: the copy holds the
   draft text and `metadata.copiedFrom.version` is `draft`. Copy without the flags:
   the live text, `live`. A folder with a draft view is refused (`invalid_operation`).
4. **Fifty documents.** Copy a folder of 50 documents linking in a ring. All 50 land
   in one transaction (about 5 s here), the ring closes inside the copy, and
   concurrent copies into one folder get distinct names with no deadlock.
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
   the room: `io_error` ("The source has edits the server has not received yet"),
   `retryable: true`, and no `context_operation_receipts` row. Resend the same
   `operationId` with the room's own vector: it copies and the receipt appears.
8. **Position and order.** Copy two roots with `--position after:<P1>` into a default
   parent holding `P1 P2 P3`: the order is `P1 root-1 root-2 P2 P3` and the parent
   is manual. Copy a root with no position into that manual parent: it lands last.
   Copy a manually ordered folder into a default and a manual parent: the copy keeps
   the source's child order and its manual policy.
9. **Refusals.** Uploads as the destination (`bad_request`), a folder into its own
   subtree and into itself ("Can't go inside itself"), a path nothing holds and an
   identity another entry holds (`not_found`), a destination folder identity that was
   deleted or never existed (`destination_missing`), a destination path that is a
   document (`conflict`), a path with `..` (`bad_request`). Each answer is typed and
   non-retryable.
10. **Other owners.** Copy a Work's Scratch folder into a project area, a project
    document into a Work's Scratch and into a chat's Scratch, an upload out into a
    Work's Scratch, and a chat lineage Scratch note out. A Work note's link to the
    project keeps its target; its link to a sibling copied with it names the sibling's
    copy.
11. **The model's copy.** Send `write` `{command: "copy", path, from: {path}}` on the
    mock model for a document that links to itself: the copy's own link names the
    copy, and its other links keep their targets.
12. **Arrival.** Write a link to an address that does not exist yet, then copy a
    document to that address: `link_ahead_refs.settled_document_id` is the copy.

## Cleanup

Delete the probe folders, then stop the stack with `pnpm dev --stop`.
