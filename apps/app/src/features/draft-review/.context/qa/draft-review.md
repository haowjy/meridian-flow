# QA: text-derived draft review

The writer's room decides the review. Apply freezes a click; text Discard is a
local undoable edit. Only a browser run proves what the writer sees.

Ownership: [review runtime and commands](../draft-review.md).
Use [`./mf`](../../../../../../../docs/debugging.md) for setup and durable readback.

## Setup

Start `MODEL_PROVIDER=mock pnpm dev` in the owned checkout and discover its
HTTPS routes with `pnpm portless:list`. Use `./mf` to create an owned Work,
chat, and three-paragraph manuscript, then script one replacement in Draft
mode. Use `agent-browser` at desktop and 393 × 852; set up a coarse pointer
when checking the phone surface. Capture screenshots and console errors.

For ordering cases, install a page-owned request interceptor before the click,
filtered to the exact Work, document, and id. Check the request, answer, and
room-record order; a sleep alone does not prove that no request is pending.

## Content rebase runner

Run the production content-rebase probe:

```sh
pnpm exec tsx tools/qa/probes/draft-review-r/run.mts
```

The runner creates and drops a scratch PostgreSQL database and drives draft
creation, writer and agent appends, debounced pulls, committed-live reads, the
effect job, and inverse actions. All acceptance rows must pass:

1. Two writers queue behind a held 50,000-word rebase; both writers' typing
   survives a low-similarity rewrite and a paragraph wrapped in a quote.
2. Already committed writer and agent typing in a block the live document
   wrapped in a quote survives once; the draft keeps its own paragraph.
3. A pre-rebase frame followed by a later character extends beside the quote;
   resending the reconnect state writes nothing.
4. Typing under another writer's deleted paragraph is not recovered.
5. Live acquires the draft's only change and the rebase drops `has_effect`
   without a key.
6. Reconnect with unsent typing and server-owned base tombstones is admitted.
7. Model Undo on the fresh-seeded draft leaves the base once, with no live
   duplication.
8. Deletion-only incremental frames and a contained separator deletion are
   handled without losing newer recovered typing.

The runner's append, wait, and lock observations are diagnostic output. A
separate browser check covers rendering and native keyboard history.

## Review is a function of text

1. Open a change from the chat dock and from the Changes source. Counts, list, stepper,
   and paint agree. Removed text is red and struck; new text is green. Unknown
   authorship does not hide the change or invent a byline. An empty paragraph
   holding a red removal does not also show “Start writing…”.
2. Put changes far apart. Next and Previous scroll the focused passage into the
   editor, wrap at both ends, and follow a selected change from the list. Check
   the passage, not only the stepper, `change=` URL, or emphasis. Repeat with
   Show changes off, reduced motion, and after switching documents; only the
   presented editor scrolls.
3. Type inside and beside a change, cut and paste its paragraph, drag a block,
   and use Ctrl+Z. Paint follows the text after the 120 ms projection. Alt+Down
   an AI paragraph before Discard, then Undo and Redo; the original text, paint,
   and byline return once. Writer Undo does not create AI attribution or draft
   restoration provenance.
4. Bold a word and change a heading beside a prose edit. Both remain red/green
   changes, and a one-character substitution narrows to that character.
5. Edit live in another tab. The draft receives base and prose together with no
   flash, lost focus, or stale mark. A scheduled list refresh survives a rebind.
6. Type offline, reconnect, and reload with a held upload. Local text returns
   and reaches server readback. An unopened unsynced row has no Discard; a
   previously synced held room can Discard offline.
7. Have a draft reply create a hidden document containing a link to a live
   document and a link to an unavailable target. Open it, insert a live link
   with `@`, and verify its stored destination and opening behavior. The
   unavailable target says it does not exist yet, never “That link could not be
   checked.” Remote checks use the draft holder's document id and review-row
   address.
8. Have a draft reply edit and delete one document. Its open draft shows
   “Deleted in this draft” with Apply and Discard and no text-change rows. Work
   Files and the dock retain one Deleted row. Apply removes the live document;
   Discard removes the delete and returns remaining text changes to review.

## Local Discard

| Action | Required result |
|---|---|
| Discard an editor change | Text reverts immediately; one Ctrl+Z restores it with restoration provenance and bylines. |
| Discard the document draft (band) | All pending changes revert, the draft id stays, the page goes Live, and "Draft of ‹name› discarded." takes the review line above the toolbar. Undo returns the page to the draft with the same marks and bylines. |
| Discard from the dock or the Changes list | The item leaves immediately; the notice takes its row's place (a dock: its footer). Undo restores the same draft and bylines. |
| Discard, open another document, come back | The Changes or dock notice is still there; Undo restores the draft and main does not move. |
| Discard, then type in that draft or let a reply write to it | The notice goes without a word; editor Ctrl+Z undoes the typing, never the Discard. |
| A second Discard or an Apply by the same Work | It replaces the notice. |
| Reload | The notice ends; discarded text persists. |
| Discard all / the dock's Discard with only text drafts | No question; one notice "N drafts discarded."; one Undo restores every room. |
| Discard a new document, a move or delete | No question; the notice shows, and Undo brings back the document, the move or delete and its text. |
| Discard a trashed chat's draft | It asks once ("This can't be undone.") in place of its controls, and shows no notice. |
| Discard all with a move and text, then Undo | Both come back as pending; a document drafted again meanwhile keeps its newer draft, and the notice says how many couldn't come back. |
| Discard the draft of a chapter another session deleted | Main goes back at once to the document opened before (never "This destination is unavailable"); the notice shows there; Undo returns main to the draft. |
| AI A's removal discarded, then AI B removes the written-back words | No byline names A. |
| A reply writes through Discard | It continues in the same draft; later edits are new changes. |
| Discard several selected files | Every selected row leaves before write-back; the final notice paints once. |
| Notice Undo before deferred write-back | The row returns and no Yjs update is emitted. |
| Peer text arrives before deferred Discard | The stale Discard refuses with its item failure; intervening text survives and the row returns. |

Repeat the notice cells in the Changes source, including an opening room and Undo after
the server pending list omitted the discarded item. A per-change Discard inside
a hidden created text document is local; whole-created-document Discard is the
removal case below.

After Apply, type outside a replacement, Discard that insertion, and Undo. No
schema-repair notice appears and restored text is green. As a positive control,
apply a foreign Yjs update containing an unsupported `sidebar` node: the
binding removes it and shows a live repair notice with the recovered prose.

## Frozen Apply FIFO

Each document has one FIFO and one in-flight command; documents are independent.
Work Apply all freezes one click per text draft, each in its own FIFO, and sends them as one
command (`POST …/branches/:branchId/apply`) once every member is its queue's head.

| Controlled schedule | Required result |
|---|---|
| Click successive changes, including a middle click while the first waits | Only clicked occurrences leave. Requests keep the original snapshot, ids, and one base-view delta. |
| Apply, type beside it, then Discard before the answer | Applied words stay in the optimistic base; the new typing reverts. |
| Apply a deletion before the first answer | The base ends at the applied text; the deletion does not reappear. |
| Room record before answer, then answer before record | No flicker or duplicate insertion; each head settles once. |
| Refuse the middle click | Its change returns with an item failure, then the next frozen click sends. |
| Refuse `{status:"refused",reason:"not_found"}` at desktop, narrow desktop, and coarse-pointer phone | The focused bar, identity row, Changes source status, and dock show the failure exactly once; paragraph and row tops do not move. |
| Drop the answer | The same body and id retry after 1, 2, and 4 seconds; then the item shows Retry and no successor sends. |
| Slow ten clicks | Groups leave together; Applying uses reserved space after 500 ms and completion is FIFO. |
| Navigate to the Changes source during the head | The owner receives the answer and record and settles without a mounted editor. |
| Hold the final draft update, click Apply, archive the Work in another tab | The unsent click refuses silently, with no failure or Applying/Retry limbo. Unarchive and reopen: a fresh Apply works. |
| Sent Apply loses its answer and the session rebuilds | The sent id remains pending until retry, lookup, or its room record; unsent successors refuse. |
| Reload with queued clicks | The sent head may finish; unsent clicks return as draft work. |
| Disconnect before the record, close from another tab, reconnect | The head settles from its durable answer; queued clicks cancel without Retry. |
| Live rebase before landing | Both edits survive the merge; no stale refusal or re-cut occurs. |

## Removal and terminal closure

- A hidden created-document Discard removes the item without Undo and ends its
  presentation to the Work. A later model write is refused; creating again gets a new id.
  A per-change Discard never takes this route.
- In a three-tab close race, Work Discard all removes `item` and `change` from
  the review URL and shows the exact live document. The pending list is empty,
  live prose is unchanged, and the retired `draft:<id>` IndexedDB database
  disappears after all holders release. Unknown metadata or availability reads
  must not redirect to live.
- Work Discard all removes every bound editor, including an empty active draft
  absent from the pending list. Failure returns the item with its reason.
- Another-tab deletion closes live and draft rooms with `4208 document-deleted`,
  drops their cache, and shows the removal reason and actor. Unsent removed-
  document text is not retained.
- `4205 discarded` is terminal. Drop that room's cache and go to live; any
  unacknowledged text remains selectable for copying. `4409 access-changed` and
  `4207 draft-prefix-missing` are nonterminal.

## Attribution and provenance

Use a mock-model write to an existing manuscript draft and open it from Work
Files. Capture the `draft/provenance` request: its body is exactly `roomName`
and `writerRanges`; the response supplies the snapshot and writers needed to
cover the visible write. A wrong Work or file cannot return evidence, and a
malformed room or clock range returns 400.

Type locally inside and beside a change: “You” appears without one provenance
request per keystroke. A new unresolved remote range requests evidence; an
Apply or restoration-root revision refreshes it. A delayed response released
after switching rooms must not publish in the new room.

Replace only the first paragraph of a draft after a model removal. After the
live pull, the full replacement is red, the remover's byline is present, and
Apply/Discard are enabled. Check the name and conversation button inside the
change card's `region "Change"`, not with a page-wide match.

Review groups come from text alone. A mixed-author group stays one row and one
red/green box. Known bylines retain “You”, accessible full names, and links in
the +N menu on desktop, phone, and Show changes off.

## Wire checks

`draft/apply` accepts `commandId`, optional `draftId`, optional snapshot,
`baseViewDelta`, `groupIds`, `restore`, and `tree` with its revision. Malformed
input and a snapshot whose insertions or deletions are not committed refuse
before a claim. An unknown id has no result; a landed id replays its result;
changed body or scope under the same id conflicts.

Text Discard sends ordinary Yjs updates. Server Discard handles a hidden
creation or Work Discard all. The addressed metadata lookup resolves empty
active drafts without opening a Yjs room.

## Addressed metadata and creations without rooms

The addressed GET `…/works/:work/documents/:document/draft?itemKey=…` returns
`active` with the stable draft id, room, and item even after local Discard makes
it unlisted. It returns `gone` for an old item key and `tree-only` for a draft
without a room. A different Work or project cannot read it.

For a hidden creation without a text room, Apply omits `snapshot` and sends
empty `groupIds` and `baseViewDelta`. It reveals the same document id, removes
the pending item, and a same-id replay returns `applied`. The same empty click
on a text draft or already revealed item is malformed. A text-room creation
uses the ordinary frozen text click.

## Editor Undo of Apply

Open a draft with two separated changes and a move.

1. Type before a change, Apply it, type after it, and press Ctrl+Z three times.
   Typing, Apply, and the first typing reverse in order; Ctrl+Shift+Z restores
   them. Repeat with toolbar Undo and Redo.
2. Apply text and a move. Undo returns the text as a pending change while the
   document stays moved; Redo applies only the frozen text.
3. Edit landed text from a second client, then Undo. Untouched groups return
   pending and the edited group stays unchanged.
4. Press Undo before Apply sends, including while acknowledgement is held. No
   Apply or Un-Apply lands; Redo sends one new Apply.
5. Delay or drop an Apply answer, then press Undo and Redo while typing. Commands
   settle in order, typing remains enabled, and the review does not flash back
   before its authoritative room update.
6. Refuse Un-Apply. The restored change shows the error and Retry with the same
   command id. Chat-side, tree-only, and delete-short-circuit Apply do not enter
   editor history.

After each case, inspect the draft room and live document with `./mf`. Reversed
Apply records are absent, skipped records remain, and replaying either command
id returns its stored result. Compact the live journal between Apply and Undo;
the durable effect receipt still resolves.
