# Upload-first import protocol

## Phase boundary

Upload and organization are separate durable phases. Upload completion sets
`organizing` and wakes one server-owned organizer lane. The organizer prepares
receipts, plans the tree once, writes bounded batches of first texts into the journal, then
makes every planned node a `create` record in one submission to the project's tree list, in the
transaction that marks the import finished. Do not reintroduce placeholders,
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
NULL-project objects, waiting texts and entries after a hard deletion, leaving the tombstone.

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

A file that can't become a document is stored as a file, never as garbage text:
`classify` (whole bytes, at receipt) marks `kept_as_file` for a document extension over
non-text bytes, text that isn't valid UTF-8, and `.html`/`.htm` (tags aren't prose; the
MIME type is `text/html`). The entry's reason is `kept_as_file`, so the result needs a
look, and its name keeps its extension. A kept `binary.md` is stored as name `binary`,
extension `md`: a stored name carries a prose suffix only for such a file, so every lookup
tries `addressCandidates` (literal, then alias) in order (literal `binary.md` finds it; `binary` stays a document's),
and naming asks the row's kind, never the suffix: `storedFilename(typed, { extension, editable })`
uses `fileName` for a stored row (literal, keeps its suffix through rename, move and Copy) and the
document rules otherwise. The client reads `extension` from the catalog entry. Link matching tries the literal path before the extension-omitted key, so a
document `binary` and a kept `binary.md` each get their own links. A name the codec refuses
(`thesis.docx.md`) is kept as a file under its literal name, never a failed intake. A
broken DOCX takes the same reason later, when
prepare's conversion fails. `changed_after_pick` wins when both apply.

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
The header stores nullable placement facts, written once by the first organize pass; entries can
become `prepared` and retain a `converted_key` for DOCX Markdown. Counts distinguish prepared from
organized. The header's destination URI and folder identity are the immutable selection. The
first pass derives the effective destinations from that identity, and later passes plan from the
stored placement (`buildOrganizedTree`'s `fixed`), so the top-level names, and with them the paths
the stored texts spell their links with, never change between passes. Once the plan falls back
to an area's root, the import retains that outcome for its completion notice.
The repository projects nullable storage columns into one verified `FileReceipt`
at its boundary. Entries expose immutable `selection` separately; folders and
unreadable items have no receipt. Placement records destinations (including fallback)
and top-level names.
A DOCX's embedded images are extracted by the converter, never inlined as `data:`
URLs. Prepare stores each as an object plus an extra `import_entries` row
(`spec.derivedFrom` = the DOCX entry id, state `received`), at the path
`<docx name>/image-N.<ext>` beside the DOCX, so planning gives them a folder named
after the document and the existing relative-link resolution points at them. Derived
rows are replaced when the DOCX is reconverted, skipped by counts and the detail
listing, and go with the import on Stop. A derived row has its own id namespace
(`importNodeId` kind `derived`, keyed by the DOCX entry id), so it never collides with a
picked file. If a picked or other derived path already holds an image's path, the images'
folder gets a numeric suffix (`Chapter 1 (2)/`). Derived files skip the per-file size cap
(their DOCX passed admission) and count against the file budget; past it, the DOCX stays a
file. A lost image object makes prepare convert its DOCX again; once the DOCX's text is written,
the image fails and the DOCX takes `upload_lost` so the loss reaches "needs a look". A
DOCX whose conversion failed (`kept_as_file`) is not converted again. Prepare lists the
import's objects once per pass instead of reading each one to check it exists. Image types browsers can't render (TIFF,
EMF) stay files; formats are not converted.
Active sweeps protect both receipt and converted keys. `convertNote` produces occurrence-indexed
targets and hrefs, preserving adjacent links that spell the same address. The
organizer binds selected targets directly by their planned document ids; ordinary
unresolved links keep address-based ahead refs. There is no release-to-address
fallback for selected targets.


## Organize transaction seam

`OrganizeQueue` (claim, heartbeat and release with token predicates) stays separate
from the repository. One organize transaction entry guards each batch and the reveal: lock the
import, check organizing and the lease token, acquire the project lifecycle gate shared and check
liveness, then run the writes in that same transaction. Do not add token arguments to upload
mutations or open a second Context transaction. It is not an upload capability.

**The text waits in the journal.** A batch of at most 500 nodes or 16 MiB writes each document's
first Yjs state under the id its create will have (`encodeSeed`, `installSeeds`): a head with no
`documents` row, which nothing reads because no record names it. What else the batch worked out,
the document's properties and aliases and the links it made to documents that do not exist yet
(their random ids are inside the stored text, so they cannot be worked out twice), goes to
`import_entries.ahead` in the same transaction as the entries' `received -> prepared`.

**The reveal is one submission.** `ContextImportReveal` (`context/adapters/drizzle-import-reveal.ts`)
makes the planned folders, documents and files `create` records (actor `system`; the top level
arrives after what its folder already holds, a new folder's children in name order), writes the
documents' properties and previews, registers the ahead links and settles arrivals, all in the
transaction that marks the import finished. It is never refused: the list's replay numbers a name
taken meanwhile and stands a deleted destination folder again. A name numbered at the top level
is not respelled in links inside the import; they still reach it by id.

A pass that fails keeps its lease for a delay; five failed passes without a reveal fail the import
with `organize_failed`. Retry starts again from the stored plan and the texts already written.

**A stopped or abandoned import** deletes its waiting texts by its entries' ids in the sweep that
removes its objects (`discardUnbornDocuments`: heads of documents that never got a row).

Context and Collab refusals retain typed causes in server diagnostics. Browser
entry reasons remain the import-specific reason union; do not expose provider
causes as a second refusal vocabulary.

Publication commits in the reveal transaction. There is no separate publication
phase and no detached publication task to drain.
