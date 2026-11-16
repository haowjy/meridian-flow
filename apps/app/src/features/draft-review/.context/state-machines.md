# Draft review state machines

## Apply click command

One Apply or Undo click on a draft change, from the click to the server's answer
(`ApplyClickQueue` in `apply-click-queue.ts`). Apply lands a draft's change on the live
document; Undo here takes an Apply back. Commands for one item run strictly in order:
only the head is ever sent. How the queue fits review is in [draft-review.md](draft-review.md).

```mermaid
stateDiagram-v2
  [*] --> queued: click
  queued --> cancelled: the click is taken back before it is sent
  queued --> sent: it is the head, and nothing else is in flight
  sent --> settled: applied (its own text landed and recorded, or settled), or a final refusal
  sent --> sent: a timeout, or the server says the first request is still running
  sent --> retrying: no usable answer
  retrying --> sent: after 1, 2, then 4 seconds, with the same body
  retrying --> stalled: three retries used
  stalled --> sent: the writer retries
  sent --> cancelled: the queue was closed and a lookup says the server never saw it
  settled --> [*]
  cancelled --> [*]
```

- **A click can be taken back only before it is sent.** Once `sent`, the server may have it,
  and the same command id is resent until the server answers.
- **A timeout is not a failure.** The request is sent again under the same id at once, and
  again for as long as the server answers `running` (the first request still holds the id);
  the head stays `sent`, shown as Applying. Only a resend that times out too, or any other
  lost answer, moves to `retrying`.
- **No answer is not a refusal.** A thrown request, or an answer for another command id, keeps
  the head where it is. A stalled head holds every later command behind it, because sending
  them around it would apply changes out of order.
- **A frozen Apply settles when the server's record shows it**, not on the answer, when its own
  item's text landed. The server keeps a row for each applied command, and the command settles
  once its id is among them. A click with no frozen cut (a tree cut alone, or a whole-draft cut
  sent with no room open) settles on the answer: no room here records it. An answer whose entry
  for this item (`itemOf`, by the queue's node) says its text was settled, or carried no text,
  settles at once, whatever a sibling of the same command landed. An Undo settles when the rows it
  reversed are gone.
- **An Undo waits for the Apply it takes back** and is sent when either half of that Apply
  landed; when neither did, the Undo ends `cancelled` without a request.
- **`landed`** means the rows show the Apply happened but its answer was never read, or the
  queue was destroyed while the command waited on its rows. The writer sees a success.
- A closed queue stops sending and only looks up what its sent head became.
- **A member of an Apply of several is `sent` by its group** (`group-apply.ts`): its send waits
  until every member is its own queue's head, then the group posts the one command, and each
  member's queue settles from its own entry in the same answer.

The pattern:
[a command that may have landed](../../../../../../.context/state-machines/command-that-may-have-landed.md).

## Draft end and reopen

One draft's end, as this tab's `DraftCommandOwner` holds it (`ended` on `DraftCommandState`,
keyed by draft id). It decides what every surface showing the draft does: the review owner, the
route, the page's paint and the editor's status pill each read `ended`, and nothing else.

```mermaid
stateDiagram-v2
  [*] --> open
  open --> checking: its room closed (4205 or 4208), or its metadata answered gone
  open --> here: the close follows this tab's own Discard
  checking --> open: the server holds the draft open (a restore arrived before the close)
  checking --> in_trash: a Discard in Trash names the draft
  checking --> document: its document is in Trash
  checking --> other: anything else (a purge, a Work's branch closed)
  checking --> checking: the read failed, or the document's place isn't read yet: ask again
  in_trash --> open: fresh metadata shows it active (a restore, here or anywhere)
  document --> open: fresh metadata shows it active
  here --> open: fresh metadata shows it active
  other --> open: fresh metadata shows it active
  document --> other: its document left Trash (restored), which brings back no draft
```

- **`checking` asks the server, never the order things arrived in** (`resolveEnd`, answered by
  `AccountFeatureLifetime`): fresh draft metadata first, then Trash's Discard list, then where
  the document stands. A restore whose answer beat the old close restarts the kept session in
  place (`reopenDraftRoom`) instead of ending it. A failed read, or a document whose place
  isn't read yet, decides nothing: the page keeps the draft and asks again, backing off from 1s
  to 30s while a surface shows it, and on its next `gone` metadata answer.
- **An answer speaks for when its read started** (`DraftMetadataAnswer.readAt`): the cache
  takes a direct read only if it started after the stored answer, and `metadataActive` compares
  `readAt` with `endedAt`, so a read in flight across a Discard can't reopen the draft.
- **`in_trash` and `document` stay on screen** (`staysOnScreen`): the draft's text, read-only,
  with the status pill's Restore (the Discard's, or the document's). `here` and `other` leave
  for Live; `here` has its notice's Undo.
- **Reopening needs an answer newer than the end** (`metadataActive` compares the answer's time
  with `endedAt`): a cached active answer read before the close can't undo it. Two readers
  deliver it: a surface holding the draft's room (`useRoomBindings`), and admission of a page
  that names the draft (`reconcileClosed`), so a draft the writer's own Discard closed opens again
  after a restore even when nothing held its room.
- Apply sets `hidden` while it is queued, which leaves the review at once whatever `ended` turns
  out to be.

## Loads, not machines

`ReviewState` in `review-runtime.ts` (`ready` false until the room has synced and projected)
and `DraftChangesData` in `draft-changes.ts` (`idle`, `loading`, `error`, `ready`, `gone`) are
[load status](../../../../../../.context/state-machines/load-status.md). The one rule beyond the
pattern: an `error` must never be shown as an empty list of changes.
