# Upload-first import protocol

## Phase boundary

Upload is implemented independently of the organize runner. An upload completes
by setting `organizing`; this branch's D2 adds the staged build and atomic reveal
once the Collab and Context prerequisites merge. Do not reintroduce placeholders,
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
including after completion. Receives pulse activity every 30 seconds and time
out after ten minutes; an expired receive cannot commit a receipt.

## Commands and cleanup

Stop cancels and acknowledges uploading, organizing, or failed imports before
reveal. A non-null `revealed_at` refuses with `import_finished`, even while still
organizing for catalog publication; finished imports refuse too. D2 sets the
reveal timestamp and only marks finished after publication commits. A failed import can Retry or Stop; only
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
The repository projects nullable storage columns into one verified `FileReceipt`
at its boundary. Entries expose immutable `selection` separately; folders and
unreadable items have no receipt. Placement records destinations (including fallback),
top-level names and the creation-set digest, independent of its header generation.
Active sweeps protect both receipt and converted keys. D2 owns preparation,
staged discard, and atomic reveal after lanes A and B merge. `convertNote` produces occurrence-indexed
targets and hrefs, preserving adjacent links that spell the same address. The
organizer binds selected targets directly by their planned document ids; ordinary
unresolved links keep address-based ahead refs. There is no release-to-address
fallback for selected targets.
