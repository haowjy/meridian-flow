# Draft review lifecycle reference

This reference covers review scope, command admission, generation-addressed
observations, room/editor projection, and draft-only settlement. The key rule
is that commands, rooms, paint, and delivery are separate owners.

## Scope and authority

The presented document and review address come from the project review owner.
The session reducer owns selected review, shown generation, retained completion,
and focus; the controller owns navigation effects. Branch command records own
per-draft claims, intent queues, failures, and read fences. The executor owns
typed admission, answer recording, and refresh ordering. Work commands retain
their creation-bound Work and thread authority. Chat and Work lists own no
review reducer, room or focus observer, and there is no per-list review scope.
`useAiDraftLauncher.openReviewFile` is the one listed-file launch adapter for
Work rows, chat Review, and the live Draft chip.

Draft lifecycle status is not review evidence. The server's
`domain/branch-review-items.ts` classifier supplies review membership, content-draft count
and the mode-switch apply plan; the client never authorizes Draft-to-Auto-apply
transitions or counts bookkeeping-only drafts as changes. Files order by name,
then path basename, then document ID; update time never reorders them.

Changes group by the server's `closureClassId`, ordered by earliest hunk. Send
every operation in the class, never a representative. Unclassified hunks and
classes flagged `canApplyOrDiscard: false` show no selective controls; the chat
strip skips incomplete classes and the whole-draft header commands cover them.

The room owner acquires eligible generations and presence leases. Editor
adapters own construction, marks, paint readiness, and active binding. Draft-only
lifecycle owns cross-container promotion/removal. Writer delivery is account
and session lifetime, not review lifetime: outbox or pending carry is
generation-tagged changes evidence, not permission to adopt an empty reset, and
leaving review cannot gate delivery.

## Command admission

A command claim is bound to the account epoch and the draft identity. Batch
submission pins creation-bound Work, admits each target into its own queue, and
aggregates results; there is no Work lease, reservation, local lock, or hide-only
batch queue. Offline clicks refuse without replay on reconnect, sending nothing
and removing no draft-only tab. Account revocation stops the next send;
already-sent requests cannot be rolled back. A command never routes to the
Editor merely to make its answer visible. Archived Works lock dispositions;
Review stays available.

Per-change clicks queue per draft: each hides its change at once and is sent one
at a time, found again by its stable member set. Rows disable only for a
whole-draft command on the same draft or an archived Work, never for another
change's command.

Anything that must outlive a generation (queued clicks, held failures, hidden
sets, focus, the navigation a writer made under a cover) is keyed by
`operationKey`, the server's stable edit part key, not `operationId`, which a
re-fork renames. Text excerpts are display, never identity.
`draft-projection.ts` is the only place intents are applied to an observation;
raw preview and list reads stay raw, and local hiding never becomes server
omission.

Accepted per-change commands retain an immutable member set, operation keys,
revision tokens, and admission evidence. Each operation in the class is sent.
An identical actionable stale answer may receive one fresh-cut retry; transport
ambiguity, permission failure, and incomplete classes do not retry. Whole-draft
commands settle the current server draft, and synthetic class keys never reach
the server. Apply and Discard are server commands, not browser mutation history.

Failures are classified from typed status/connectivity evidence, never message
text: offline, typed refusal, bare server error, or unknown sent-without-answer.
Unknown never reports success or closes a review. Only applied/discarded answers
supply closure; empty lists and list omission do not. Only offline wording asks
the writer to check their connection; bare HTTP errors say to try again, and
unknown means the answer was lost, not that the command was rejected.

## Generation and completion

Reads and answers carry draft identity and generation. Older observations cannot
mask a newer proposal; a same-generation fresh read may replace proposal
content. The reducer retains completion for the open review: a covering claim
predicts pending, an `itemClosed` answer supplies closed, and a non-closing or
released claim withdraws pending while closed remains sticky for that review.
Opening a later review adopts current evidence, not an old closing answer. The
shown generation never moves backwards. Whole Apply stays in generation G;
whole Discard and last-selection disposition reset the draft to G+1. Revision
tokens are stale fences, never room identity.

What the writer sees at completion: a pending last Discard shows the warm live
text inert and restores the review on refusal; a pending last Apply keeps the
review editor with marks gone until the answer; closed completion holds the
finished state until explicit Next draft or Back to live. Lists close on the
last disposition and finished Work files leave Changes to review. A file failure
belongs to its rendered change row, else the single-file summary or multi-file
header. Whole-draft header navigation is an explicit admitted-click effect, not
a consequence of a selection's closure.

Absence is a typed observation, never an independent UI exit. With no retained
completion the review ends on absence unless the newest preview lists changes at
the shown generation or above, or the session layer still holds writer updates
for this draft (an outbox or pending successor carry). `ReviewAddressOwner`
exits only when the presented address leaves the document, not when a list
omits the draft.

An empty preview is not settlement evidence. List omission is a typed
absence observation and is not enough until a fresh entry preview/catalog
observation agrees. A gone/404 preview keeps a draft-only error destination,
rather than proving remote Discard. Room reset for a superseded generation
clears the room and rereads while review remains open.

## Review editor and focus

A review editor is the document's one tab in its review Work, never a second
tab. Construction and marks readiness are addressed by mount identity and
session GUID; retired construction cannot affect a successor. The adapter
waits for construction/marks or its bounded deadline, then projects body and
chrome. Paint continuity belongs to `PaintHold`, and only finished paint
replaces its snapshot.

Focus reconciliation is a pure reader and runs once per scope. It restores the
stable selected class from the presenting address once the current preview is
ready; a missing class selects the first remaining change. Addressed focus
cannot target another review. Layout belongs to components; controllers are
passed as props/callbacks.

## Draft-only lifecycle

A new document has server document/Yjs state without live catalog membership.
Its draft-only tab carries the document, Work, draft item, and tab instance
identity, is not persisted, and is the document's one workspace tab. Closing
review is container-local and does not discard the draft.

Apply promotes through the existing live presentation only when document, Work,
and draft match; promotion or route failure cannot undo server success.
Admitted whole Discard removes the draft before dispatch; refusal keeps the
draft and tab. A gone/404 preview is not remote Discard evidence.

`DraftOnlySettlement` observes each represented Work independently of Editor
or Chat selection. After list omission it starts a fresh live catalog
observation: membership promotes, fresh absence means remote Discard and closes,
and failed reads preserve the presentation. Active local commands suppress
remote classification. Settlement creates no tab. The Editor delegates exact
tab removal/route repair to the context removal coordinator; the dock settles
its stored occupant. Both adapters are account-epoch fenced.

A live document with branches exposes one document-level hint, while the selector
maps that hint to the current review address. New-document Discard also removes
its Work-manifest entry, and a later Apply lands that manifest as well as
content. Promotion happens once per document whichever Work's observer saw it.
Draft-only Editor tabs are never persisted and are skipped by durable route
continuity (Editor persistence strips `reviews`). The dock persists its review
address and its one `reviews` entry, the only record that a restored tab is
draft-only rather than a live document under review; restore admits the address
with the server, not from the draft list, and settlement removes a stale entry
once a fresh catalog cut shows the draft gone or the document live. The dock keeps only the selected review's entry, so it lists
one presentation and Discard is that address alone, while becoming live is
document-wide. See the parent [draft-review guide](../AGENTS.md) for surface
ownership.

## Durable decisions and verification

- [Inline review product decision][inline]
- [Editable draft authority][editable]
- [Server command authority][authority]
- [Apply is done at server confirmation][confirmation] (admission, the one
  executor and its rejected layouts)
- [Review follows its document into the dock][follows]
- [Runtime verification recipes](../../../../../../docs/qa/draft-review.md)
- Writer-delivery follow-ups: [handoff][handoff], [admission][admission], and
  [tab-close loss][loss] issues.

[inline]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/review/draft-review-inline-track-changes.md
[editable]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/review/draft-review-editable-branch.md
[authority]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/review/draft-review-command-authority.md
[confirmation]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/review/draft-apply-done-at-server-confirmation.md
[follows]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/writer-ux/interaction/documents/review-follows-presented-document.md
[handoff]: https://github.com/haowjy/meridian-flow/issues/731
[admission]: https://github.com/haowjy/meridian-flow/issues/738
[loss]: https://github.com/haowjy/meridian-flow/issues/739
