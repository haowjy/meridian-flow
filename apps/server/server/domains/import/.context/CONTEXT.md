# Import protocol

The imports row is the transaction fence. Plan chunks and landing commits take
its shared row lock; ready admission and Finish take its exclusive lock. Ready
admission is its own transaction that rechecks planning and preparation; a
shared fence is never upgraded, since two resumes would deadlock. Namespace locks precede
entry-row locks. A parent that changes source during lock acquisition retries
in a new transaction. The parent capability belongs to Context, not this domain.

Every planned folder, entry and unreadable id is derived, never random: the server
digests `(projectId, importId, rootId, kind, path)` with `importNodeId` from
contracts (`planWithDerivedIds`), and the browser derives the same ids. A plan
persists the complete identity graph before creating anything. Chunks
track preparation separately from creation: folders and prose/DOCX notes exist
after planning, while binaries and code documents only have allocated names.
Chunks process one parent at a time and use the live listing plus the import's
own uncreated allocations. The same selection resumes by content, independent
of client numbers/order. A different selection conflicts. `POST .../resume` (no
body) runs a stored plan's remaining chunks, then the automatic finish, and
answers the status in any state; it is also what a re-POST of the manifest does.

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
write only when creation uses exactly that id.

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
identity or destination. `convertNote` returns that one immutable template with its
occurrence targets; `respell` computes the hrefs once, after the batch location
lookup. No readable Markdown copy exists, and link resolution returns only the
chosen target (ranking and tie-breaks decide it; nothing explains the choice).
The scanner recognizes links, embeds, escapes and comments only; callouts,
highlights, tags and footnotes are plain text.

Binaries and code have no row until they land. The binder receives them as
pending ids: one already live binds to itself, otherwise it mints an ahead ref
whose registry row persists the awaited id (`awaited_document_id`). No other
document settles that row, whether it was at the address before registration
or arrives after; the registry settles it when the target arrives (or at
registration, if the target is already live), wherever the target landed, so
a file at the address only makes the target count up. Import keeps no mirror
of the relation: it supplies awaited ids while binding and releases them. Finish (or Stop here) releases
rows awaiting files that never landed; from then on they are ordinary ahead
refs and settle at once to a document already at their address. Binding registers in
its own transaction before the fenced commit, so a landing that finds the import finished
releases its pending ids too: no awaited row outlives a finished import.

A single selected folder with a valid meridian-export.json routes Manuscript/,
Knowledge Base/ and Unfiled/ to their area roots; planning chunks group by
area as well as parent, and Works/ is skipped as export_works.

Finish clears pending flags on unfinished placeholders, leaves ordinary empty
documents, and marks unfinished entries not imported. There is no Remove,
Restore, staging tree, ZIP extraction or automatic model sort in this domain
(the future sort is its own command, see FUTURE.md; the manifest carries no flag for it).

The API probe is pnpm exec tsx apps/server/scripts/probe-import.mjs PROJECT URI
PATH... [--files]. It builds a manifest with the shared frontmatter
splitter and uses ./mf api for every request.

The performance probe is pnpm probe:db
apps/server/scripts/probe-import-performance.ts --out FILE.ndjson
[--notes 2000] [--fixture plain|linked] [--batch 1]. It runs the production
composition on a throwaway migrated database and records plan, chunk and landing
timings plus port-call counters, with the machine. `linked` notes carry aliases
and wiki-links; a batch above 1 lands through multipart receives. Keep
its output in the work directory, not the repository. It is not part of the
correctness gate.

## Landing and storage

A multipart receive prepares its selection once (`domain/prepared-selection.ts`):
link candidates, the link index, root settings and pending ids, all immutable plan
data shared by its Markdown landings. Direct `land` prepares the same context lazily.
Binary, code and DOCX landings never load other entries. Current addresses are read
per landing through batched `currentUris`, so hrefs follow moves; the context holds
only the allocation seen at preparation.

`import_entries` has one owner per field. Columns own identity, order, version,
state, planned kind, entry id, parent id and area, prepared, created, lease, storage,
uri and sweep state, so every query filters on a typed column. `spec` is the typed
`ImportEntryPayload` (the remaining planned node fields plus prependOnRetry). `ImportEntryPatch` is the only mutable surface, split into payload and
column fields at the repository boundary; a column field is never written to `spec`.

## Reports and activity

Failure and skip reasons are the typed codes/params in contracts/imports; there
are no per-entry findings or finding counts. Raw
failures go to server observability only. Unreadable selections are skipped,
with the reader's code in reasonParams. They never acquire a document row, so
their paths keep the source names (a name Meridian refuses, like `Who?.md`, is
reported rather than refusing the selection); only bounds, empty, dot and
control-character segments are checked.

The status (`ImportStatus`) carries the plan's folders and each entry's planned
parent, scheme, stored allocated name and extension. The status carries no address and no
presence: `import_entries.uri` is the internal planned address (link ranking and the
fallback ahead href) and never goes on the wire; hrefs follow live locations
through Context's canonical batch loaders, never a scalar ancestry walk. Each
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
unfinished imports only (a finished one is read by id); each names its
destination folder by id (null at an area root), which survives a rename where
the URI does not. A finished import simply leaves the open list. Version values are decimal strings.

Catalog pending-flag clearing uses Context's exact-file reconciliation. It
reserves publication ordering without changing namespace observations for
unrelated siblings. Bulk planning reconciles live manifest membership once
per chunk, not once per placeholder.
