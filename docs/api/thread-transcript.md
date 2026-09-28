# Paged thread transcript API

`GET /api/threads/:threadId/transcript` returns one authenticated keyset page of
a live thread's transcript. The target thread must belong to the caller and a
live project. Fork reads may follow a trashed source because the source is
needed only for inherited history.

| Query | Values | Default |
|---|---|---|
| `order` | `newest_first`, `oldest_first` | `newest_first` |
| `unit` | `item`, `turn` | `item` |
| `limit` | integer from 1 to 200, counted in the selected unit | `40` |
| `range` | `effective`, `inherited` | `effective` |
| `cursor` | opaque, versioned keyset cursor returned by this endpoint | omitted |

`inherited` returns only the cutoff owner's effective history through the
fork's cutoff. It returns an empty page for a non-fork. `turn` pages contain
whole turns. `item` pages contain one block per item, or a blockless settled
turn at sequence `-1`. Entries are always chronological within the page.

The response contains `entries` (`turn`, page-sliced `blocks`, and
`ownerThreadId`), `owners` (including whether each source is trashed), the
opening `segment`, `segmentBoundary`, `hasMore`, and an optional `nextCursor`.
Only a cursorless `newest_first` effective read can include `unsettledTail`;
that live preview is not part of the cursor chain. A segment is opened by a
complete turn with a prompt-bake pointer, including compaction and undo-marker
turns. Pages never cross segment boundaries.

Malformed cursors and cursors for another thread, order, unit, or range return
HTTP 400. Missing, trashed, wrong-owner, or wrong-project target threads return
HTTP 404. Block payloads use the same client sanitizer as thread snapshots.
