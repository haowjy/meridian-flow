# domains/context/uploads — authoritative upload intake

`UploadIntake` owns upload identity from idempotency reservation through
finalization or deletion. Ownership and addressing are in the [upload
decision][uploads].

## Contract

The browser sends the file to the store, not through the server. A chat attach and a file
dropped into a document (see Source uploads) share the routes' flow.

1. `start` takes name, exact size, type and `intakeId` (a UUID; a type that is not
   `type/subtype` becomes `application/octet-stream`). It refuses a name finish would
   refuse (`invalid_filename`, final: the client does not retry it), writes a `reserved` row (no
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
   decide nothing. Text is decoded strictly: UTF-8, or UTF-16 with a byte-order mark. Bytes
   that decode as neither (GBK, Latin-1) stay a stored file through `keptAsFile`, whole. A
   tracked file with bytes but no text read from them is a failure, never an empty document. Then `claim` records the type
   (`reserved → object_stored`, guarded on `reserved`), then preview, the name, bind, and one
   transaction of persist and `finalized`. Afterwards the incoming object goes, and a
   tracked document's final object too (its text lives in the document).

Nothing is compensated. A finish that fails after the claim leaves `object_stored` and
the checked object, and a retry reclassifies from it and resumes. A finish that finds no
incoming object answers `not_uploaded` and keeps the row. Delete during finish: `deleteDraft`
always releases both keys, and a finish that then finds the row `deleted` (at the claim or
under the final lock) releases what it made and answers `idempotency_conflict`. The delete
route authorizes by the chat's uploads container, not the document, because an unfinished
upload has none, and `deleteDraft` matches the intake to that project and chat. Work purge
releases both the final and the incoming key of each upload.

`sweepAbandoned` (scheduler lane `upload-sweep`, hourly) drops `reserved` and `object_stored`
rows untouched for 24 hours, in batches of 50 until one comes back short, behind a partial index.
The row goes first and the objects only if that delete won: its condition is atomic against
`claim`, `finalize` and the `start` that touches the row, so a finish or start that lands after
the sweep listed the row keeps it and its objects. (Releasing the objects first once let a
finish complete between the two steps and lose its file.) A tab that closed after its PUT is
dropped the same way and its chip reads gone. A bucket lifecycle rule on `incoming/` should also
expire stray objects (late PUTs, crashes).

Known limits, accepted:
- A take-back (an undo, a delete, closing the Composer) aborts the browser's PUT and keeps it
  from calling finish, but a finish the server has already received cannot be called back: the
  file lands, and nothing in the text links to it. The client stops waiting; the server does not
  stop finishing.
- Two overlapping finishes can copy different bytes over the final key after the first read
  it, and a late PUT plus a slow finish can rewrite the final object of a `finalized` row. The
  signed length still holds and a project has one owner, so only the writer's own file is
  affected; the client's own retry sends the same bytes. The fix is an attempt-scoped copy key chosen at `claim`.
- A crash between the finish commit and the release of the incoming object, or a failed
  delete in `release` (it reports and does not throw), leaves an object no row names: up to
  5 MiB for tracked text, whose document holds the text, and the writer cannot see it. The
  sweep only lists unfinished rows, so a lifecycle rule on `uploads/` is no help either.

Text above 5 MiB is stored as a binary row that keeps its extension, so the model can't read it
(`Cannot read binary file as markdown`) and the writer isn't told. Nothing shows that yet.
The NUL check only applies to a declared `application/octet-stream`: Markdown declared as
`text/markdown` stays tracked with a NUL in it. Binding cost grows with line count, not bytes,
and runs on the event loop; the 5 MiB cap doesn't bound it.

The owner is a primary thread's id; a subagent resolves to its top primary. It
may be a thread id whose row does not exist yet (a New-chat attach), with no
foreign key, as for lineage Scratch.

The `(projectId, intakeId)` key binds the actor, chat, name and size, and the lifecycle
`reserved → object_stored → finalized → deleted`. Reservation allocates the stable
document ID, object key, owner chat, and location revision once; the flat
collision-safe filename is chosen at finish. The address is derived from the owner's handle, never frozen
before the chat row exists. Tracked text seeds through ContextFS and collab;
binary content remains object-backed. A same-key retry returns
the original result only when the actor, chat, name and size match the row.

## Source uploads

A file dropped into a document, or a picture, is a source upload: the same start and finish routes
as a chat attach, with any scheme but `uploads` (`POST /context/<scheme>/upload` and `/upload/finish`,
plus `workId` for a Work's Scratch). A chat lineage's Scratch refuses (403): only the model creates
there. It belongs to no chat: `owner_thread_id` and `context_source_id` are null, and the `source`
destination carries the scheme, authority and port the route resolved for the host. The client mints
the document id and sends it as the intake id (a UUID that no `documents` row holds, else
`idempotency_conflict`), so the link to the file stands in the document before the file exists, and
the door starts the upload before it inserts the chip.

Every upload is named where it lands, when finish places it: a chat's in its flat `uploads`, a
source upload in `<scheme>://assets/<name>`. Finish lists the folder once (`UploadContentPort.names`)
and picks the first free name against that, so the number of copies costs nothing per finish; it
binds and persists, and on a `conflict` from either (another writer took the name since the list)
adds the name to the taken set and goes again, at most 100 times, so a text file's bound path
always matches the one it lands at. The chat port reports a taken `uploads://` name as a conflict
like any other, for text and stored files alike, which is why no name is reserved earlier. `finish.failed` logs a fixed `reason`, never
writer text. A file's own extension stays its extension (`notes (2).zip`). `finalize` records the name
it took.

`start` also answers `name`: the name finish would give the file if it ran now, by the same rule
(one list, the first free name, the type guessed from the name and declared type). The door labels
a dropped file's chip with it, so a second `notes.zip` reads `notes (2).zip`. Finish still names
the file itself, so two uploads of one name started before either finishes both hear `notes.zip`,
and the one that finishes second lands as `notes (2).zip` under a chip labelled `notes.zip` (its
link still finds it). A guess that the bytes overrule (text past the text cap kept as a file) can
differ the same way. The label is never rewritten after the file lands: a chip's words are the
writer's once it stands (link identity decision). `assets/` is created by that write wherever it has gone missing. Chat-only paths
(`lockForDelete`, `consume`, `lookupUpload`) skip these rows.

The server does not say whether a source upload is still being sent: a `doc:` ref that names
nothing yet resolves `gone`. The sending tab announces it over presence, and other tabs' chips
read "Uploading" from that (`apps/app/src/core/uploads/upload-store.ts`).

A source intake is never released through the delete route, which is a chat attach's undo and is
scoped to the chat (`ChatUploadOwner`). A writer's undo mid-upload aborts the PUT and leaves the row
`reserved` for the sweep; once finalized the file is an ordinary document in `assets/` and is
deleted as one. A name `start` refuses (`invalid_filename`) is final, on the client too
(`UploadRefusedError`); the name loop only renumbers on a collision, so it never changes a name
`start` accepted into one it would refuse.

A project has no delete path today (only soft delete), so nothing releases a project's objects.
`upload_intakes` rows cascade with their project; a project purge added later must release the
objects of its intakes first, as Work purge does.

Uploads are flat and cannot be created through general ContextFS operations.
Catalog visibility and finalized intake state commit in the ambient ContextFS
transaction. `consume()` is the singular admission seam for defeating
delete-after-send races, and explicit delete is identity-bound so it cannot
target a replacement at the same path. When admission and delete race, the loser
gets a factual refusal: `already_used` (a sent message consumed it) or
`already_deleted`.

[uploads]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/chat/composer/context-upload-intake.md
