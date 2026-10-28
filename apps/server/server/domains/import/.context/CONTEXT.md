# Upload-first import protocol

## Phase boundary

Upload and organization are separate durable phases. Upload completion sets
`organizing` and wakes one server-owned organizer lane. The organizer prepares
receipts, stages bounded generations through Context and Collab, then reveals the
tree, catalog publication and terminal import status in one transaction. Do not reintroduce placeholders,
landing receipts, awaited document ids, or browser plan/resume loops to bridge
that boundary. `OrganizeWake` is only a latency hint; durable rows are authoritative.

## Identity and admission

Create persists roots and one entry per selected or implied folder, file, and
unreadable item. `importNodeId(projectId, importId, rootId, kind, path)` is stable.
The exact validated selection fingerprint distinguishes replay from a different
command. A user advisory lock serializes the three-open-import limit; an import-id
advisory lock reserves identity across projects and users. Replays run before
checking the current destination or open limit.

The header retains summary counts when its entries expire. Roots retain their
historical creation facts. `project_id` is nullable with `ON DELETE SET NULL`;
headers are never deleted. Soft-deleted projects leave the open list and open
count. The project repository has no hard-purge command; the sweep reclaims
NULL-project staging and entries after a hard deletion, leaving the tombstone.

## Upload receipts

The body reader streams multipart through Busboy. Parts are numbered by entry
id. A file crossing 50 MiB returns its identity with an oversize marker and drains the rest without retaining bytes, rather than rejecting an unidentified body and leaving that entry
awaiting forever. Requests remain bounded to 200 parts and 8 MiB for multi-file
batches; one file may carry up to 50 MiB. Oversize metadata is accepted, but the
entry starts `failed/too_large` and needs no bytes.

`X-Import-Changed-Entries` is a comma-separated list of ids in that request. Native
FormData cannot set per-part custom headers; this carries the per-entry Continue
fact without altering part names. The server independently hashes, classifies,
and reads aliases from the received bytes.

Each put uses `imports/<importId>/<entryId>/<UUIDv7>`. Under the import row lock,
only an awaiting entry in an uploading import can receive the key. Its age must
be less than one hour by database time. Cumulative received bytes are checked
under that same lock; overflow fails the entry with `too_large`. The transaction
updates retained counts and activity, then moves to organizing if no awaiting
entry remains. An already-received part replays without replacing its bytes,
including after completion. Receive separates the lifetime scope, object preparation,
and synchronous ordered admission decisions under the lock. Only the request's
file ids are fetched. The adapter persists receipt patches in bounded typed SQL
batches; uniform transitions use import/state (and optionally id-set) predicates.
Receives pulse activity every 30 seconds and time out after ten minutes. The scope
keeps admission until execution settles, even after its response deadline. Abort
checks around database waits roll back an expired receive's transaction.

## Commands and cleanup

Continue reports its re-picked received entries at `POST .../picked` with a
SHA-256, size and modified time per entry. The server never reads or stores those
bytes again. `picked` (`domain/picked.ts`) compares each hash with the receipt and
only touches received entries. Two facts, kept apart:

- `import_entries.changed_after_upload` says the file on disk differs from the
  receipt, so the import holds the earlier text. Only `picked` writes it, from the
  report alone: a differing hash sets it, an equal hash clears it. A reverted edit
  therefore clears it.
- `reason = changed_after_pick` is set at receive: the bytes sent differed from the
  pick. `picked` clears it only on proof it was false: the re-picked file has the
  recorded size and time (it is the file originally picked) and equals the receipt.
  Picking a copy first and then the original is the case this serves. A reverted
  edit or a matching copy proves nothing about the pick, so the mark stays.

An entry needs a look when either holds, and the aggregate count includes both.

Stop cancels and acknowledges uploading, organizing, or failed imports before
reveal. A non-null `revealed_at` refuses with `import_finished`; finished imports
refuse too. Publication and the finished transition commit with the reveal. A failed import can Retry or Stop; only
finished/cancelled imports can acknowledge. Stop returns without object-store I/O.
The recovery lane discovers terminal headers with an unset sweep marker.

The sweep expires inactive uploading and failed imports after seven days as
cancelled/expired. Active imports retain referenced keys and discard unreferenced
keys older than two hours. Terminal imports retain only organized binary receipts;
NULL-project tombstones retain no objects. Sweep at cancellation, two hours, and
one day catches late puts. Complete all pages before deleting: local and in-memory
stores use offset cursors. Failed deletes leave the marker unchanged for retry.
Thirty days after acknowledgement, remove entries, never headers. Once the final
sweep is recorded, replay and retention must not sweep again without receipts:
organized binaries still belong to documents.

## Conversion

`planSelection` accepts server receipt facts, not browser sniff/frontmatter.
Its identity graph preserves folder-note relocation and export-marker routing.
Name allocation belongs to Context. The header stores nullable placement facts and
a generation (initially zero); entries can become `prepared` and retain a
`converted_key` for DOCX Markdown. Counts distinguish prepared from organized.
The header's destination URI and folder identity are the immutable selection. Each
placement generation derives its effective destinations from that identity; the
summary reads the selected area's effective placement. Once any generation falls
back, the import retains that outcome for its completion notice.
The repository projects nullable storage columns into one verified `FileReceipt`
at its boundary. Entries expose immutable `selection` separately; folders and
unreadable items have no receipt. Placement records destinations (including fallback),
top-level names and the creation-set digest, independent of its header generation.
A DOCX's embedded images are extracted by the converter, never inlined as `data:`
URLs. Prepare stores each as an object plus an extra `import_entries` row
(`spec.derivedFrom` = the DOCX entry id, state `received`), at the path
`<docx name>/image-N.<ext>` beside the DOCX, so planning gives them a folder named
after the document and the existing relative-link resolution points at them. Derived
rows are replaced when the DOCX is reconverted, skipped by counts and the detail
listing, and go with the import on Stop. Image types browsers can't render (TIFF,
EMF) stay files; formats are not converted.
Active sweeps protect both receipt and converted keys. `convertNote` produces occurrence-indexed
targets and hrefs, preserving adjacent links that spell the same address. The
organizer binds selected targets directly by their planned document ids; ordinary
unresolved links keep address-based ahead refs. There is no release-to-address
fallback for selected targets.


## Organize transaction seam

`OrganizeQueue` (claim, heartbeat and release with token predicates) stays separate
from the repository. One organize transaction entry guards build, reset and
reveal: lock the import, check organizing/token/generation, acquire the
project lifecycle gate shared and check liveness, then run repository and Context
staging writes in that same transaction. The generation reset persists placement,
increments generation, resets prepared entries set-wise and discards the old stage.
Do not add token arguments to upload mutations or open a second Context transaction.
It is not an upload capability.

Staged batches advance work only within their placement generation. A placement
rebuild keeps the accumulated no-progress count; five rebuilt generations without
a reveal fail the import with `organize_failed`.

Context and Collab refusals retain typed causes in server diagnostics. Browser
entry reasons remain the import-specific reason union; do not expose provider
causes as a second refusal vocabulary.

Publication commits in the reveal transaction. There is no separate publication
phase and no detached publication task to drain.
