# Draft review lifecycle reference

[The ownership map](../AGENTS.md) identifies modules. This reference defines
cross-surface state, command ordering and lifecycle contracts, not surface layout.
Paths below are relative to `apps/app/src` unless otherwise noted.

## Scope and review evidence

The project shell composes one persistent review value through
`DraftReviewProvider`, for the presented document (`features/project/presented-document.ts`):
the Editor on Context, the dock document on desktop Chat/Work. Its Work is the
presented review's Work, falling back to the Editor route Work. Chat and Work
lists compose `useWorkDrafts` and `useWorkDraftCommands`; they own no review
reducer, room or focus observer, and there is no per-list review scope.
A scope change hides the departed selection in render before layout clears it,
so an old draft cannot attach to a new Work or account-query scope.

`projectWorkDraftFiles` in `client/query/work-draft-files.ts` projects the
server's reviewable list into catalog-labelled files after `projectDraftList` applies whole-Apply intents. `useWorkDrafts` exposes
`files` and `fileForDocument`; raw `drafts` remain generation/command evidence.
Live names and paths include optimistic renames; draft-only files keep their
listed labels. `sortDraftFiles` orders by name, then path basename for unnamed
files, then document ID, with ID as tie-breaker. Update time never reorders files.
`nextReviewFile` retains a removed file's place using its last name.

Branch lifecycle status is not review evidence. The server's
`work-draft-pending` classifier supplies review membership, content-branch count
and the mode-switch apply plan. The client projection does not authorize
Draft-to-Auto-apply transitions or count bookkeeping-only branches as changes.

`draftView` owns the discriminated action target (operations, draft or display) and
`reviewChangesOfPreview` exposes its shared `reviewChanges` grouping by server
`closureClassId`, ordered by earliest hunk with class ID breaking ties. Send all
operations in the class, never a representative. Only new documents become one whole-draft item, with all
mark keys and attribution retained. Its Apply/Discard use existing whole-draft
commands, never synthetic IDs in a selective request. Formatting-only edits have
server classes and whole-block decorations. Rich hunks carry semantic formatting
facts; the client localizes their one-line row description through messages.po
(provisional wording). Unchanged text is never shown struck through beside itself.
Whole claims hide the addressed
generation's preview optimistically; failures restore it.
Existing documents retain each class. Unclassified hunks and classes flagged
`canApplyOrDiscard: false` show no selective controls; other classes remain
actionable. The chat strip skips incomplete classes; whole header commands
cover them. Rows are DOM display artifacts, not editable TipTap content.

## Command admission and ordering

`client/query/draft-command-executor.ts` owns admission, selection preparation,
typed requests, addressed answers, refresh, confirmation/failure and release.
`useWorkDraftCommands` binds project, Work and thread invalidation authority at
creation. A command never routes to the Editor merely to make its answer visible.
An expanded Work row may share the presented review's list model while still using its own
Work capability. Archived Works lock dispositions; Review remains available.

`startDraftCommand` checks the one claim and both `navigator.onLine` and
`onlineManager.isOnline()` before optimistic effects. The caller navigates from
`CommandStart.sent`, not its own connectivity prediction. Requests use TanStack
`networkMode: "always"`; offline clicks never queue for reconnect. Admission
refusal sends nothing, refreshes nothing and removes no draft-only tab.

Whole commands send the draft ID without preview tokens or operation sets.
Selections send every selected operation plus the cached active preview's live
and draft revision tokens. Discard also sends the exact server-vended closure
class IDs and admission tokens; the server admits unchanged closed-row/rich-effect
evidence despite unrelated draft typing,
while Apply remains fenced by the full draft observation. The executor reads the generation and predicts
`completesDraft` from all remaining changes; no active preview refuses `stale`
without sending. The claim keeps generation, not a retained preview basis.

Settlement order is explicit:

1. An `applied`/`discarded` answer publishes closing evidence on the claim
   before cache refresh. Selections also publish their addressed answer.
2. Whole Apply confirms and projects the addressed pending list membership away
   immediately, preserving a newer generation. Catalog/list/preview refresh
   continues in the background; navigation and promotion do not decide success.
3. Whole Discard awaits refresh. Confirmed or `gone` selections retain their
   claim through awaited list/preview refresh, confirm settled keys as intents without editing raw previews. Other selection answers refresh before failure.
4. Failure is recorded on the addressed draft or selection, and the executor
   releases the claim in `finally`. No command answer survives as a claim after
   release; the open review can retain a closed completion independently.

**Per-change clicks queue.** `runDraftSelection` accepts every distinct Apply or
Discard click at once: it hides the change (the queue entry in the record store,
which also holds the caller's execution context, promise and account epoch),
and `drainClicks` sends the draft's clicks one at a time. Each is found again in
the draft as it is when its turn comes (a fresh preview read for every click after
the first, new tokens) by the immutable stable member set accepted at the click.
Current complete raw classes must have exactly those members and remain
actionable; a joined, missing or incomplete member refuses rather than changing
the command. Only the row names and cut tokens may change. An explicit `stale`
answer refreshes the cut and retries once, under the same drain and live claim,
only for identical actionable members and unchanged server admission tokens.
A second stale answer, changed membership or effect,
permission failure or transport ambiguity restores/refuses without another retry.
The drain supplies no caller authority: each intent carries its own query client
and thread invalidation context. An account change answers every unsent click
`blocked`, and the loop checks its click is still queued right after the read, so
nothing is sent or published for a dead account. Rows disable only for a
whole-draft command on that same draft or an archived Work (`changesLocked`), never for
another change's command.

**Identity across re-forks.** A selective Discard re-forks the draft, so every
survivor gets a new journal row, hence a new `operationId`. The server carries the
recorded edit part (`updateMeta.documentEdit`, `<editId>:<ordinal>`) through
the re-fork and vends it as `ReviewOperation.partKey`; class ids hash the members'
part keys, so an unchanged class keeps its id. Anything on the client that must
outlive a generation (queued clicks, held failures, hidden sets, the focus, the
"arrived" pulse, the navigation a writer made under a cover) carries
`operationKey` (in `@meridian/contracts/drafts`: the part key; `row:<id>` for a row that records no edit part, which
therefore only matches itself). Text excerpts are display, never identity.

**Presentation data and interactions.** `useOpenReviewChanges.ts` owns the
retained projected open-review data (changes, failures, status and completion).
`useReviewChanges` adds focus, stepping and commands; `useDraftView` borrows only
that presentation data for the same painted draft, paired with its own caller
capability. Listed views never construct the interactive open-review model.

**One projection.** `draft-projection.ts` is the only place intents are applied to
an observation: `projectDraft(observed, intentKeys)` gives the list/count preview,
the manuscript's inline preview (Discards in flight still drawn) and the
operations being restored. The held list re-projects the draft's last observation
under the current intents; the paint cover is its capture plus the same
projection.

**Claims are capabilities.** `beginDraftCommand` returns a `DraftClaim` bound to
the account epoch (`resetDraftCommandRecords` advances it). Answers, failures,
confirmations, cache edits and release after an await go through the claim and
land only while it is the draft's live pending claim. Batch submission pins its
creation-bound Work and account epoch, synchronously admits all targets into
their draft-local queues, then aggregates their promises. No Work lease, reservation or hide-only batch queue
exists. Refusals do not stop independent targets; account revocation stops the
next actual send (already-sent requests cannot be rolled back). Offline clicks
refuse without replaying on reconnect.

## Records, failures and freshness fences

`client/query/draft-command-record.ts` is the one cross-surface authority per
(project, Work, document, draft). It owns claims, queues, overlap-matched
selection outcomes, failures and list/preview read fences. Account changes clear
it through `bindDraftCommandAccount`. No local lock or optimistic hide supplements it.

Queued, pending and confirmed selections are hidden by the shared preview
projection; failures restore them with their reason. Matching uses shared class
or operation keys, newest overlap wins. Discards among them are `restoring`:
`useDraftPreview` hands the editor those changes still in its model (`inline`),
so the manuscript draws their original text from the click. Preview reads stay
raw. Confirmed selection keys remain account-scoped intents, since older
observations can still be cached or held by the painted review.
Work list reads stay raw too. Whole Apply retains an account-scoped generation
horizon beside the claim, rather than filtering the cache or a late read. The
same whole-command disposition projects list membership and previews; proposals
above that horizon reappear. Read-start clocks stay beside immutable observations.
A read started after confirmation can present a same-generation next proposal;
a read begun earlier stays masked, even after fresh reads land. Structural
sharing never merges equal observations across a command clock. Retaining the
intent replaces read-drain retirement, so held pre-command evidence stays masked.
List/preview failure retirement still fences at request start. The room owner
reads raw generations and projected proposal membership; local hiding never
becomes server omission.
`previewWithoutKeys` never hides an unowned hunk.

Failure classification uses error type/status, never message text:

| Evidence | Selection failure | Whole failure |
|---|---|---|
| Either connectivity signal offline at admission | `offline` | `apply-offline` / `discard-offline` |
| Typed server envelope | `refused` | `apply-refused` / `discard-refused` |
| HTTP error without typed envelope | `server-error` | `apply-server-error` / `discard-server-error` |
| Sent request with no HTTP answer | `unknown` | `apply-unknown`; unfenced whole Discard uses `discard-offline` |

Only offline wording asks the writer to check their connection. Typed refusals
retain `serverCode` and `serverReason`; `RefusalReason` in `ReviewMessageText`
localizes known codes when shown and preserves unknown server reasons.
Bare HTTP errors say to try again, not that the connection failed.
Unknown means the answer was lost, not that the command was rejected. Neither
list presence nor absence proves Apply/Discard; unknown never reports success
or promotes a draft-only tab. A later preview that omits a failed selection
retires it; a later list omitting a failed draft retires that failure.

Selection `incomplete_class` becomes `stale` and refetches; focus follows shared
operations if regrouping changed the class ID. `whole_item` refreshes as `stale` (a racing selective request cannot target a
whole-draft item). `gone` is not held: the change leaves with failure feedback.
Applied/discarded selections produce no success toast.
Only `applied`/`discarded` answers can supply closure, never refusal or stale.
Whole failures clear on the next disposition; opening Review clears only
`review-failed` (a failed launch), not a refused command. Work rows can dismiss.

`useReviewRefresh` is the open review's freshness owner. It watches the retained
branch and live sessions and invalidates preview/list after a 500 ms settled
burst, at least every 2 s during continuous writes. It does not interpret Yjs
updates or construct another model. Unopened mounted previews refresh through
`useDraftPreviews` when their list row changes; they join no room.
`useInlineReviewSync` only projects the current generation's preview into the
plugin, including refetches with unchanged tokens; it has no refresh timer.

## Retained completion and generation policy

`draftClaim` supplies the same review-facing projection on entry and on record
changes. `useReviewCommandCompletion` emits one addressed `completionObserved`
with generation and `completion | null`. A non-covering claim sends no generation
adoption; withdrawal addresses the prior covering claim's generation.
Synchronous subscription dispatch preserves entry/answer ordering in one flush,
without consulting the last rendered review identity.

`inlineReview.completion` is the reducer's retained state, not a second command
store. A covering claim predicts `pending`; `itemClosed: true` supplies `closed`.
A non-closing answer or failed/released claim withdraws pending. Closed stays
sticky while that review remains open, including after claim release. Opening
later adopts only current cache/claim evidence, not an old closing answer.
An empty list never means finished: `useReviewChanges` derives `finished` only
from closed completion, `completing` from pending, and `unlisted` for an active preview with no listed changes or command hiding them.

Pending last Discard shows warm live text inert; refusal/non-closure restores
review. Pending last Apply keeps the review editor with marks gone until the
answer. Closed completion holds “No changes left” in the existing review/path row until
explicit Next draft or Back to live. Lists close on the last disposition and
finished Work files leave Changes to review. The chat strip has no notes or
Work-page footer; one summary row holds count and commands. Expanded changes sit
directly under it for a single document; multiple documents get file headers. A file
failure belongs to its rendered change row, otherwise to the single-file summary
or multi-file header. This ownership is derived from the rendered row model.
Strip/header failures never wrap: the single line ellipsizes with full localized
copy retained in its title and accessible text. Discard confirmation replaces the
summary instead of competing with it. Change excerpts
truncate to keep attribution and actions on the same line. Whole-draft header navigation is an explicit admitted-click effect,
not an automatic consequence of a selection's closure.

Whole Apply stays in generation G. Whole Discard and last-selection disposition
reset the branch to G+1; the reset and next proposal share that room/generation.
Proposal content, not the number alone, distinguishes them. Revision tokens
change with writes and are observation/Apply stale fences, never room identity.
Discard fences current live authority and admission evidence for selected closed
rows and rich class effect instead.
The reducer owns shown generation R and completion K:

| Row | Input | Result |
|---|---|---|
| E | Enter the draft | R is the newest proposal the caches know (a cached preview that lists changes, the list row, a claim); K is the claim's if it acted on R; none known leaves R unresolved |
| C1, C2 | Claim at R begins covering the last changes, or is answered `itemClosed` | K is pending, or closed (a closed K never goes back) |
| C3 | Claim at R ends without a close | A pending K is withdrawn; a closed one stays |
| C4, C5 | Claim below R, or above it (or R unresolved) | Ignored, or re-enter the claim's generation (a claim that does not cover the last changes sends no action: it acted on a cached preview, which O3 has already taken up) |
| O1, O2 | Preview or list read below R, or at R | Ignored, or content refresh only |
| O3 | Read above R that lists changes (a list row always does) | Re-enter it, over any K (the writer's "Applying" included) |
| O4 | Read above R that lists none (the close's reset) | Nothing: a pending K waits for its answer |
| P | The room read resolves | Sets the room; R unresolved takes its generation; above R applies O3 or O4 |
| X | The Work's list omits the draft, or a preview says `gone` / 404 | An absence addressed below R is ignored. With no K the review ends, unless the newest preview lists changes at R or above, or the session layer holds writer updates for this draft at R or above (an outbox or pending successor carry); K keeps it |
| S | The editor's room is reset as `superseded` (`branch-generation-stale`, named server close or denial) | The room is cleared and read afresh; the review stays |
| L | Leave, or enter another draft | The review ends; later inputs for the draft match nothing |
| B | Whole-draft batch | Each target carries R from its own draft-local admission |

Re-entering G' sets R to G', adopts only that generation's claim completion,
clears focus and room, and shows marks. The room owner acquires again. R never
moves backwards; preview caching uses `keepNewerGeneration`. Completion, model
and room observations are addressed to the draft and generation they describe.

Absence is a typed `reviewAbsent` observation, never an independent UI exit.
List omission waits for the fresh entry preview. HTTP 404 and JSON `gone` share
a stamped cache answer with the generation horizon at request start, not answer
arrival. It is re-observed when writer evidence clears without another HTTP
read. Old absence cannot cancel a newer proposal; fresh gone at R is not vetoed
by a stale list row at R. A draft-only gone/404 keeps its error destination.
Terminal session failure uses terminal absence; other fetch failures are room
errors. `ReviewAddressOwner` exits only when the presented address leaves the
document, not when a list behind the current proposal omits it.

## Review adapter, room owner and delivery

`useReviewRoomOwner` weighs list, preview and generation-tagged writer evidence,
acquires/retains the selected session with `reviewRoomRef`, and follows pool
replacement. Superseded generation resets clear/read the room; same-room rebuilds
retain review intent. Attempts are fenced by selection and account; cancellation
retries only while the attempt is still owned. The owner supplies session and
input eligibility, with no paint state or receipt.

`EditorView` resolves live/review identities against the canonical scope, keeps
the warm live editor, and owns error, settlement, marks and paint presentation.
`SessionEditor` accepts `identity`, `session`, `surfaceOptions` and `onConstructed`;
it constructs the common editor without review subscriptions. The review-only
runtime registers/releases the editor and runs model sync and focus. One
construction receipt is addressed by mount identity plus session GUID; retired
construction/withdrawal cannot affect a successor. Marks readiness acknowledges
the current editor's projected model, not a previous editor's cache. The adapter
waits for construction and marks (or the 1.5-second deadline), then synchronizes
body/chrome through `setInlineReviewShown`. Schema notices stay explicit.

Pane continuity belongs to [shared PaintHold][paint], outside navigation and
room acquisition. Only finished paint replaces its snapshot. Desktop draft-only
errors offer Retry/Close; phone server-document errors offer return to live.
Phone draft-only hosts delegate to the desktop host's Close policy.

`useActiveReviewBinding` owns owner-token projection registration/cleanup and
the live presence lease. Desktop policy uses resolved review room; phone uses
requested review. Hosts retain their own acquisition/route/LRU responsibilities.
`MobileDocumentReview` supplies one `ReviewHeaderModel` to top and bottom chrome;
idle header models disable preview reading.

Focus belongs to the reducer. `useReconcileReviewFocus` reconciles once per
scope and restores the stable selected class from the presenting review address
once its current preview is ready. Missing classes silently select the first
remaining change. `ReviewAddressOwner` replaces (never pushes) that address as
focus changes; the Editor serializes `change` beside `draft`, and the dock stores
it on its existing review address. `resolveFocusedChange` is a pure reader. Addressed `focusReviewChange`
cannot focus another review. `useInlineReviewFocus` connects model focus, marks
visibility, mark clicks and arrival pulse to the review editor.

Writer delivery is account/session lifetime, not review lifetime. The pool and
`BranchWriterHandoff` drain released outboxes and filter replay against surviving
anchors in the synchronized successor. Outbox/pending carry is generation-tagged
changes evidence, not permission to adopt an empty reset. Leaving review cannot
gate delivery. See [editable branch authority][editable] and the separate
[handoff issue][handoff], [admission issue][admission] and [tab-close loss issue][loss].

## Launch and draft-only lifecycle

`useAiDraftLauncher.openReviewFile(file, workId, focusOperationIds?)` is the one
listed-file adapter for Work rows, chat Review and live Draft chip. Missing
addresses no-op; absent/empty focus normalizes there. The route-level handoff is
latest-wins and above shell selection. Claiming requires successful route command
and matching Work/path/document/membership; it owns no paint state.

A live document that other drafts have changes to says so from any view
(`DocumentDraftHint` under the identity row, fed by `useDocumentDraftHints`, one read per
document: `GET /documents/:d/drafts`, answering `{ draftId, itemKey, label, originWorkId }`).
`draft-hint-review.ts` holds the only two Work-shaped steps (hide the view's own Work draft,
and map a hint to today's review address); the draft selector replaces just that file. The
read re-reads on the Work draft lists' signals: commands, catalog wakes, identity changes,
focus and reconnect.

New-document drafts have server document/Yjs state but no live catalog
membership. A synthesized `draftOnly` tab carries transient `reviewWorkId` and
`reviewItemKey` in the review overlay, never durable workspace identity.
Overlay identity includes document, Work and draft; navigation consumes the
row’s own `contextLocation`, without restricting its document scheme. Hosts acquire only its
branch; phone `MobileDraftOnlyDocumentHost` delegates to `ContextEditorMountHost`.
Close review closes only the container used, without discarding the draft; it can be reopened.
Readable-address admission enriches/absorbs the overlay rather than hiding a
durable tab beneath it. Another Work cannot resolve that overlay.

`draft-only-lifecycle.ts` defines promotion/removal once over Editor-tab and dock
adapters. Both containers settle; Close is container-local. The Editor adapter
delegates exact-instance removal, promotion and route repair to
`ContextRemovalCoordinator`; the dock adapter settles its stored occupant without
claiming a revision. Both adapters are bound to the account epoch; closed epochs
cannot enumerate or settle presentations. Hidden restore candidates are not lifecycle presentations:

- Confirmed Apply promotes through `promoteAppliedDraft`, drops the marker and
  opens ordinary live hosting. Only a resolved live presentation matching the
  review’s document, Work and draft ends branch-only absence retention; a pending
  or nonmatching address is not promotion proof. Promotion/route
  failures never undo server success.
- Admitted whole Discard removes through `discardDraft` before dispatch. Later
  refusal stays on the draft row and never restores its tab or navigates back.
  Not-sent admission refusal does not remove it.
- `DraftOnlySettlement` is one project owner with one observer per represented
  Work, even if neither Editor nor chat currently selects it. After list omission,
  `acquireCatalogAfter` starts a fresh live catalog observation (never joins an
  older pre-Apply read): membership promotes; absence means remote Discard and
  closes. Failed catalog reads leave presentations intact. Active local commands suppress
  remote classification; disposal aborts settlement. Settlement creates no tab.
- List omission and empty active/reset previews leave a draft-only review selected
  while lifecycle classifies it. The room owner cannot release that intrinsic
  address before promotion/removal. A preview `gone`/404 is not this catalog evidence: it keeps the draft-only error
  destination with Retry/Close. Remote confirmed-Discard omission plus fresh
  catalog absence closes it.
- Editor overlay tabs are never persisted and are skipped by durable route
  continuity. The dock persists its review address and rebuilds the overlay from
  the Work’s draft list. `pullContextCatalogOnHint` wakes mounted draft lists after manifest
  changes so another page can classify remote Apply/Discard without reload.

Server Discard of a new document also removes its Work-manifest entry; subsequent
Apply publishes that manifest as well as content.

## Durable decisions and verification

- [Inline review product decision][inline]
- [Editable branch authority][editable]
- [Server command authority][authority]
- [Apply is done at server confirmation][confirmation] (admission, the one
  executor and its rejected layouts)
- [Review follows its document into the dock][follows]
- [Runtime verification recipes](../../../../../../docs/qa/draft-review.md)

[paint]: ../../../components/app/PaintHold.md
[inline]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/review/draft-review-inline-track-changes.md
[editable]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/review/draft-review-editable-branch.md
[authority]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/review/draft-review-command-authority.md
[confirmation]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/review/draft-apply-done-at-server-confirmation.md
[follows]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/writer-ux/interaction/documents/review-follows-presented-document.md
[handoff]: https://github.com/haowjy/meridian-flow/issues/731
[admission]: https://github.com/haowjy/meridian-flow/issues/738
[loss]: https://github.com/haowjy/meridian-flow/issues/739

Raw preview observations remain immutable. Confirmed selection keys stay in the
account-scoped intent journal so cached and held observations cannot resurrect a
settled change. They leave with the account epoch, not with a cache rewrite.
Inline input emits an addressed focus intent through the domain change index;
programmatic plugin emphasis is output only. The scope focus reconciler remains
necessary for chained regrouping (a later class can share only an intermediate
member with the originally focused class).
