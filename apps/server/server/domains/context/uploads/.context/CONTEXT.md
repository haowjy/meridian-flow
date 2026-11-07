# domains/context/uploads — authoritative upload intake

`UploadIntake` owns upload identity from idempotency reservation through
finalization or deletion. Ownership and addressing are in the [upload
decision][uploads].

## Contract

The browser sends the file to the store, not through the server. Chat only: pictures
and source destinations move with the file door.

1. `start` takes name, exact size, type and `intakeId`, writes a `reserved` row (no
   name or file type yet) and returns `documentId`, `locationRevision` and a signed PUT
   to `incoming/<projectId>/<documentId>`. A size over `MAX_UPLOAD_BYTES` (200 MiB,
   `packages/contracts`) is refused with `too_large`. Calling it again resumes by state:
   `reserved` re-signs (and counts as activity for the sweep), `object_stored` answers
   `stored` (finish, no PUT), `finalized` returns the result, `deleted` is
   `idempotency_conflict`.
2. The browser PUTs the bytes (`uploadFileDirect`, `apps/app/src/client/api/direct-upload.ts`).
3. `finish` copies `incoming/…` to the object key first, then reads only the final key,
   because a repeated PUT through the URL can still change the incoming object. It checks
   the size against the declared one (`size_mismatch` deletes both objects and leaves the
   row `reserved`), reads the first 8 KiB, classifies, and reads whole only text up to
   `TRACKED_TEXT_MAX_BYTES` (5 MiB) and pictures the browser can't draw up to the
   preview cap. Type and text come from the stored bytes alone: the declared name and type
   decide nothing, and a tracked file with bytes but no text read from them is a failure,
   never an empty document. Then `claim` picks the name under the source lock
   (`reserved → object_stored`, guarded on `reserved`), then preview, bind, and one
   transaction of persist and `finalized`. Afterwards the incoming object goes, and a
   tracked document's final object too (its text lives in the document).

Nothing is compensated. A finish that fails after the claim leaves `object_stored` and
the checked object, and a retry reclassifies from it and resumes. A finish that finds no
incoming object answers `not_uploaded` and keeps the row. Delete during finish: `deleteDraft`
always releases both keys, and a finish that then finds the row `deleted` (at the claim or
under the final lock) releases what it made and answers `idempotency_conflict`. The delete
route authorizes by the chat's uploads container, not the document, because an unfinished
upload has none.

`sweepAbandoned` (scheduler lane `upload-sweep`, hourly) drops `reserved` and `object_stored`
rows untouched for 24 hours with both objects, in batches of 50, behind a partial index. A tab
that closed after its PUT is dropped the same way and its chip reads gone. A bucket lifecycle
rule on `incoming/` should also expire stray objects (late PUTs, crashes).

Text above 5 MiB is stored as a binary row that keeps its extension, so the model can't read it
(`Cannot read binary file as markdown`) and the writer isn't told. Nothing shows that yet.
The NUL check only applies to a declared `application/octet-stream`: Markdown declared as
`text/markdown` stays tracked with a NUL in it. Binding cost grows with line count, not bytes,
and runs on the event loop; the 5 MiB cap doesn't bound it.

The owner is a primary thread's id; a subagent resolves to its top primary. It
may be a thread id whose row does not exist yet (a New-chat attach), with no
foreign key, as for lineage Scratch.

The `(projectId, intakeId)` key binds a normalized fingerprint and the lifecycle
`reserved → object_stored → finalized → deleted`. Reservation allocates the stable
document ID, object key, owner chat, and location revision once; the flat
collision-safe filename is chosen at finish. The address is derived from the owner's handle, never frozen
before the chat row exists. Tracked text seeds through ContextFS and collab;
binary content remains object-backed. A same-key retry returns
the original result only when the actor/owner/name/size fingerprint matches.

## Source uploads

A file dropped into a document is a source upload: the same route with any scheme but `uploads`
(`POST /context/<scheme>/upload?documentId=…&filename=…`, plus `workId` or `rootThreadId` for
Scratch). It belongs to no chat: `owner_thread_id` and `context_source_id` are null, and the
`source` destination carries the port the route resolved for the host's scope. The client mints
the document id and it doubles as the intake id, so the link to the file stands in the document
before the file exists. A second intake under an id with another name or size is refused
(`idempotency_conflict`); an id some document already holds fails at `persist` and releases the object.
Reservation fixes no name. `persist` writes `<scheme>://assets/<name>` through the port and, on
`conflict`, takes the next free copy (`name (2).ext`, the file's own extension kept), then
`finalize` records the name it took. `assets/` is created by that write wherever it has gone
missing, so renaming it mid-upload only makes a new one. Chat-only paths (`lockForDelete`,
`consume`, `lookupUpload`) skip these rows.

`inFlight` answers which document ids are unfinished uploads (reserved or object-stored, touched
within two hours) of the asking account; the link resolve route turns a `doc:` ref that names
nothing into `uploading` with it. A crash leaves a row no one sweeps; the two-hour window is what
stops its chip saying `uploading` forever.

Uploads are flat and cannot be created through general ContextFS operations.
Catalog visibility and finalized intake state commit in the ambient ContextFS
transaction. `consume()` is the singular admission seam for defeating
delete-after-send races, and explicit delete is identity-bound so it cannot
target a replacement at the same path. When admission and delete race, the loser
gets a factual refusal: `already_used` (a sent message consumed it) or
`already_deleted`.

[uploads]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/chat/composer/context-upload-intake.md
