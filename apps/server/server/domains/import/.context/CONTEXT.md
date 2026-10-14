# Import protocol

The imports row is the transaction fence. Plan chunks and landing commits take
its shared row lock; ready admission and Finish take its exclusive lock. Ready
admission is its own transaction that rechecks planning and preparation; a
shared fence is never upgraded, since two resumes would deadlock. Namespace locks precede
entry-row locks. A parent that changes source during lock acquisition retries
in a new transaction. The parent capability belongs to Context, not this domain.

A plan persists the complete identity graph before creating anything. Chunks
track preparation separately from creation: folders and prose/DOCX notes exist
after planning, while binaries and code documents only have allocated names.
Chunks process one parent at a time and use the live listing plus the import's
own uncreated allocations. The same selection resumes by content, independent
of client numbers/order. A different selection conflicts.

Landing claims use an attempt id and two-minute lease. Conversion and link
binding happen outside transactions. Content, pending metadata and the landed
receipt commit together. Replay reads the receipt, never document text. An
edited placeholder fails once; the next upload prepends imported blocks while
preserving the writer's nodes. Deletion wins over arrival.

Binary object keys are deterministic (imports/<importId>/<entryId>).
Unreceipted puts are overwritten on retry. Sweep candidates are claimed
binaries that ended deleted or not imported, after their lease expires. Each is
swept once after the lease and once after a one-hour late-put grace; a late put
that records its receipt clears the marker so the next sweep reclaims it.
Finish sweeps only its own import after commit, and a cleanup failure goes to
observability, never to the Finish response. The periodic sweep runs in
batches of 500.

The isolated binder binds prose by existing placeholder id. Link-free code
can bind to its planned id before its row exists; Context admits that bound
write only when creation uses exactly that id. Recorded ahead refs and binary
receipts serialize on the target entry row. Settlement is compare-and-set by
ref id.

## Wiki-style note conversion

Conversion runs per landing note, outside transactions, over a link index built
once per note: selected paths, basenames and aliases, then the project's
existing Manuscript, Knowledge Base and Unfiled documents. Existing names and
aliases are frozen into the record at plan time (manifest.existingLinks), so
their ranking locations never move; only the written addresses are respelled
from current locations. Project fallback uses markup's shared wikilink
ranking, the same one paste uses. Frontmatter is stored verbatim in
metadata.properties with derived metadata.aliases.

Conversion edits only Markdown destination spans the scanner reports, and
writes every converted destination as a unique placeholder. The binder parses
that template, so each source link is its own occurrence, and receives the
target id and written href per occurrence. Refs are assigned before real
addresses could merge adjacent links into one run: two targets sharing a
current address, a hand-written link to it, or a link after them never swap
identity or destination. The readable Markdown is never reparsed for binding.

Binaries and code have no row until they land. The binder receives them as
pending ids: one already live binds to itself, otherwise it mints an ahead ref
whose registry row persists the awaited id (`awaited_document_id`). No other
document settles that row, whether it was at the address before registration
or arrives after; only the target's landing settles it, by id, so a file at
the address only makes the target count up. Finish (or Stop here) releases
rows awaiting files that never landed; from then on they are ordinary ahead
refs and settle at once to a document already at their address.

A single selected folder with a valid meridian-export.json routes Manuscript/,
Knowledge Base/ and Unfiled/ to their area roots; planning chunks group by
area as well as parent, and Works/ is skipped as export_works. The sort is
the manifest's choice; the dialog defaults it off for an export.

Finish clears pending flags on unfinished placeholders, leaves ordinary empty
documents, and marks unfinished entries not imported. There is no Remove,
Restore, staging tree, ZIP extraction or automatic model sort in this domain.

The API probe is pnpm exec tsx apps/server/scripts/probe-import.mjs PROJECT URI
PATH... [--files]. It builds a manifest with the shared frontmatter
splitter and uses ./mf api for every request.

The performance probe is pnpm probe:db
apps/server/scripts/probe-import-performance.ts --out FILE.ndjson
[--notes 2000]. It runs the production composition on a throwaway migrated
database and records plan, chunk and landing timings with the machine. Keep
its output in the work directory, not the repository. It is not part of the
correctness gate.

## Reports and activity

Reasons and findings are the typed codes/params in contracts/imports. Raw
failures go to server observability only. Unreadable selections are skipped,
with the reader's code in reasonParams. They never acquire a document row, so
their paths keep the source names (a name Meridian refuses, like `Who?.md`, is
reported rather than refusing the selection); only bounds, empty, dot and
control-character segments are checked.

Reports first observe created entries' live address and presence and publish
any drift as ordinary entry changes, so every report field comes from one
versioned cut and since never misses a move or delete. Rows a landing commit
holds are skipped (SKIP LOCKED) and compared again next time. Addresses come
from Context's canonical batch loaders, never a scalar ancestry walk. Each
entry's wanted flag uses the rule land() claims by; it is the only authority on
which entries the app sends or counts.

Intake is bounded before work: paths at 4,096 bytes and 64 segments, entries
plus synthesized folders at 20,000 nodes, manifest bodies at 32 MiB, file
requests at 50 MiB plus framing (refused while streaming), at most 200 parts,
four concurrent receives per import (import_busy) and four concurrent landings
per request. Every refusal is an ImportRefusalCode with bounded numeric params.

The imports row cannot also be the progress counter: shared landing fences
would deadlock on lock upgrades. import_progress sequences publication in a
before-commit transaction participant, after all entry/content locks. The same
commit writes entry versions and activity. Repeatable-read report cuts combine
summary and entries; since returns only changed file entries, not the roots.

Both long multipart receives and owned landing attempts pulse every 30 seconds.
An expired attempt cannot renew a replacement's lease. Open summaries list
unfinished imports and undismissed finished reports; each names its
destination folder by id (null at an area root), which survives a rename where
the URI does not. Dismissal is finished-only and never deletes documents. Version values are decimal strings.

Catalog pending-flag clearing uses Context's exact-file reconciliation. It
reserves publication ordering without changing namespace observations for
unrelated siblings. Bulk planning reconciles live manifest membership once
per chunk, not once per placeholder.
