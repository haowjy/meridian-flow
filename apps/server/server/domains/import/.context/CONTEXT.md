# Import protocol

The imports row is the transaction fence. Plan chunks and landing commits take
its shared row lock; Finish takes its exclusive lock. Namespace locks precede
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
Unreceipted puts are overwritten on retry. The periodic object sweep deletes
terminal entries' keys only after outstanding leases expire, including late
puts that finish after Stop here.

The isolated binder binds prose by existing placeholder id. Link-free code
can bind to its planned id before its row exists; Context admits that bound
write only when creation uses exactly that id. Recorded ahead refs and binary
receipts serialize on the target entry row. Settlement is compare-and-set;
captured addresses are findings, never reassigned.

Finish clears pending flags on unfinished placeholders, leaves ordinary empty
documents, and marks unfinished entries not imported. There is no Remove,
Restore, staging tree, ZIP extraction or automatic model sort in this domain.

The API probe is pnpm exec tsx apps/server/scripts/probe-import.mjs PROJECT URI
PATH... [--files]. It builds a manifest with the shared Obsidian frontmatter
splitter and uses ./mf api for every request.
