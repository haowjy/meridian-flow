# features/import

Upload first. The browser lists paths, sizes and modified times, uploads bytes,
then a durable server job organizes and reveals everything atomically. Nothing
but one pending folder root exists in the tree before reveal. Loose files and
routed exports have no pending rows. Documents are born complete.

`ImportsProvider` at the authenticated root owns one account-lifetime coordinator;
project `ImportProvider` owns only pick/drop doors. Navigation never stops an
upload. File handles are private and ephemeral. The open list is server truth;
BroadcastChannel only nudges a refresh.

Work on one import is an `UploadAttempt` (`upload-attempt.ts`): begin, Continue,
Retry and Import without them each open one, and it ends when its sends and hash
report settle, when another attempt supersedes it, or when the import finishes or
stops. The attempt owns its abort signal and the tab's presence lease, so "this
tab is working" is one predicate (`UploadPresence.working`), used for the Web Lock
and for `beforeunload` alike. The lease is requested before the attempt it
replaces is released and is held through reading, creating and matching, so the
lock never lapses between phases. Upload presence is the Web Lock
`import-upload:<id>` (`upload-presence.ts`). Every refresh reads
`navigator.locks.query()`, so a tab without File handles says "Uploading in another
window" only while another tab holds the lock, and offers Continue once that tab
closes, crashes or pauses. `publish()` derives `local.elsewhere` from the last query
minus this tab's own leases; nothing else writes it. A stalled or missing-files tab
holds no lease; a timer heartbeat cannot do this because background tabs throttle
timers.

Continue reads fresh detail and pairs awaiting and received entries by root
name, kind and path. Size and modified time break ties
between duplicate candidates; a changed awaiting file is sent as it is now and
marked in `X-Import-Changed-Entries`. A received entry is never sent again:
when its re-pick differs, or it is already marked changed, the browser hashes
just that file and posts the hash with its size and time. Two facts come back and
stay apart: `changedAfterUpload` ("Edited after it uploaded. The imported copy is
the earlier version.") is the disk differing from the receipt, set and cleared by
each report alone; `changed_after_pick` is the receive-time mark, and a report
clears it only when the file is the originally picked one and equals the receipt.
The need-a-look list shows both sentences when both hold.

The owed hash report is the record's obligation (`record.picked`), discharged by
the attempt (`attempt.reporting`) beside the upload queue, four files at a time.
The server takes hashes only while the import is uploading, so everything that can
end the upload waits for the report: the queue's gate holds the batch that takes the
last file, and Import without them awaits it before its skip. A report that fails
keeps the error and stays owed (Retry repeats it) without changing the card while
sends are in flight; a 4xx refusal drops it, because the marks are advisory. Local
reads are bounded: a file that does not answer in time is unreadable, so a send skips
it and a report leaves its marks. Missing files stay awaiting until the writer chooses
"Import without them". Starting an upload still never hashes or sniffs files.

The browser mints the import id before reading; every create replay uses that id.
Creation knowledge (`local`, `uncertain`, `created`), not the toast phase, decides
what dismissal can do. Only an import no create could have committed closes
locally. Later refusals and an empty open list cannot erase an unanswered start;
Stop replays uncertain create before cancelling. Response revisions and upload
attempts fence late answers; polling never overwrites an in-flight command or
clears its error. Catalog/receipt progress cannot regress on an old response.

`toast-presentation.ts` owns the state table; `ImportToasts` renders its controls. Stop in any
phase before reveal discards everything; a reveal winning the race reports that
it finished. Failed organize offers Try again or Stop, never partial import.
`import_finished` clears confirmation and records the lost Stop race before any
optional detail read. Stop stays hidden, and Adding counts organized as well as
prepared files until the server says finished. A clean completion acknowledges
only after six visible seconds. Local refusals
close locally; durable terminal acknowledgements apply across tabs.

`pending-roots.ts` is the five-rule projection. Catalog identity wins; historical
`root.created` is not liveness. The coordinator remembers observed roots across
account-lifetime navigation. The 30-second catalog bridge starts when it learns
creation, not when a tree remounts. Pending roots have no URI or document capabilities: activating
one reveals its toast, never opens an editor. No import state enters the replica.
A pending root takes the slot its folder will land in (`withPendingRoots`): default-order position in a default
parent, last in a manual one, so it does not jump at reveal.

Copy goes through Lingui and `reason-copy.ts`; server codes are not sentences.
See [deferred browser coverage](.context/TODO.md) and the [runtime recipe](../../../../../docs/qa/README.md#import).
