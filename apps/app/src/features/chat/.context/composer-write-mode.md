# Composer write mode

This page defines the Work-scoped composer write-mode and sizing contracts.

The compact current-value write-mode trigger lives in the composer footer beside
Agent and Work because write mode is a property of the conversation, not
workspace navigation. It opens the toolbar's write-mode page for the Draft and
Auto-apply choices instead of spending persistent width on both choices.
`ProjectView` resolves the displayed thread’s Work once at the project
composition boundary and passes that same Work identity to `DraftReviewProvider`
and `ChatView`; the dock and composer control therefore share one binding.
Project chat always has a Work: named or No Work, looked up from
`snapshot.noWork`, never `works.find`. `ChatView` renders picker plus write mode
for that Work. There is no first/default-Work fallback.

`useComposerWorkBinding` owns Work interaction, mutation presentation, and
Undo. `useThreadDurableProjections` owns transport projection, while
`convergeThreadWorkBinding` owns all cache effects. `ComposerWorkControl`
renders the measured inline/overflow entry only in the composer; headers remain
chat identity surfaces. Work management and navigation never call this explicit
rebind path.

The row passes Agent, Draft / Auto-apply, and Work descriptors to the shared
measured `ComposerToolbar`. It observes the actual flex allocation left beside
Send and every mounted control's intrinsic width. Controls move behind one
compact ellipsis in Work, write-mode, then Agent order. Feature controllers
retain their state while the framework migrates their panel between inline and
overflow hosts. Chat headers display only chat identity. The Work controller
owns mutation, error, and live-convergence state, never placement. Switching
back is an ordinary picker selection; the toolbar has no sibling Undo action.

The shared toolbar owns popup topology, trigger policy, placement, and page-aware
focus; feature controls own domain state and page content. See the
[composer-toolbar contracts](../../../components/app/composer-toolbar/.context/CONTEXT.md).

`ComposerWorkControl` can rebind an idle existing thread. The controller carries
that behavior through cache convergence and durable projection. Only the writer
rebinds; the model's `work switch` never does
([rule](../../../../../server/server/domains/runtime/.context/tools.md#permissions)).

The neutral `useWriteModeToolbarControl` shows a value and reports a choice:
no dialog, no draft query. In an existing chat the value is the chat's mode
(`thread.aiWriteMode`) with the ledger's switches laid over it
(`useThreadControls().writeMode`), and a choice dispatches a `write_mode`
control: a record in the chat's submission journal, posted in order with the
messages around it. In the new-chat composer the value is the selected Work's
`defaultAiWriteMode`, and `aiWriteMode` is sent with the first message only if
the writer picked one there. Switching never touches drafts: the dock keeps
showing pending changes in either mode, and its generating state reads the
running turn's own mode.

The **switch ledger** (`thread-controls/switch-ledger.ts`, pure; `useSwitchLedger` is its
hook) is the one owner of a switch on screen. Each tab keeps one per chat, keyed by control
id; each entry carries its mode, the order its journal first held it in (`held`) and a state
that only moves forward. The journal's own `seq` orders only the records it holds together: it
allocates above them, so a retired record's number is reused, and the ledger counts instead:

| State | Entered on |
| --- | --- |
| `sending` | A journal record, not posted |
| `posted` | A journal record marked posted, no answer yet |
| `queued` | An answer with `pending`, the inbox listing the id, or a snapshot's pending inbox listing it |
| `applied` | An answer with a turn id, or any divider naming the id |
| `gone` | Terminal evidence (below) |

`failed` (the record was refused or lost) is a flag on `sending` or `posted`. A record
leaving the journal, or the id leaving the inbox, is not terminal: the entry stays where it
was and the hook asks for a snapshot. Terminal evidence:

- `applied` retires once the transcript this tab renders holds the divider naming the id.
- `gone` comes from a `null`/`null` answer for its own id (a cancel-out), a server Withdraw
  answering `withdrawn`, a server 404 for an entry the journal no longer holds (the server never
  had it), a local Withdraw the driver allowed (never posted, or refused), or a snapshot whose
  request began after the entry's last observation and shows the id neither pending nor as a
  divider.
- A cancel-out is evidence about its own id only. The answer carries no ids, so the switch the
  server cancelled is predicted: the entry the journal held just before the answered one, of
  the other mode, still `posted` or `queued`, is marked **cancel-predicted**. It is hidden from
  rows and the overlay and not terminal. Only a snapshot whose request began after the mark's
  watermark settles it: one that lists the id clears the mark, one that doesn't makes it `gone`.
  A socket inbox frame listing it, or an older snapshot, clears nothing: either can predate the
  cancel. An answer never touches
  an entry the journal doesn't hold, so another device's newer switch survives a delayed answer.
- **Watermark.** Every source that shows an entry raises its `observedAt` to the larger of the
  old value and the new reading: the journal, inbox and answer by the request counter at
  observation, a snapshot that lists it by its `request`. An absent snapshot proves absence
  only with `request > observedAt`. The counter (`snapshotRequestCount`) is read when a
  fetch starts, and `threadSnapshotQueryOptions` stamps every fetch of the snapshot key.
- **One guarded observer.** `useThreadSnapshotSync` is the only observer of the snapshot key,
  so its guarded options (identity, older than live changes) are the only ones Query keeps and a
  rejected response never becomes cached data. The ledger reads only the snapshot the host
  accepted (`ChatView`'s `snapshot` prop). Every other reader of the key (`useDisplayedThread`,
  the missing-chat fallback, the ledger's fetch state) uses `useThreadSnapshotCache`, an
  observer-free cache subscription.
- **Proof loop.** While the ledger holds an entry only a snapshot can settle (`proofNeed`),
  `useProofLoop`, the chat's one owner, drives acquisitions from completion: an insufficient
  success (request not above the bar) is followed at once by one fresh fetch, which qualifies;
  an error is followed after 3 s, doubling to 30 s; offline and hidden pause it, and reconnect
  or showing the page resumes it.

Display derives from the ledger alone. Rows are every entry that is not `gone`, not
cancel-predicted, not withdrawing, not retired, and not folded by a predicted switch back (a
switch back before its answer hides both rows, only against a predecessor the server has said
it holds `queued`: one still `sending` or `posted` may have been applied on arrival, as an idle
chat does, and an `applied` one stays a row, so the later switch shows). `sending` and
`posted` show as sending, `queued` and not-yet-rendered `applied` as queued (so no frame lacks
both the row and the divider). A failed row shows Retry; Withdraw shows unless the server may
hold it (posted and not refused). Entries are ordered causally, as a merge of two chains: the
journal's (`held` order) and the server's (transcript position, else inbox order). An entry on
both anchors them together; a journal-only entry stays right after its journal predecessor.
Lifecycle state never reorders either chain; only between entries no anchor relates does an
applied one with no divider yet go before what the server still holds queued. The mode is the rendered snapshot's
`thread.aiWriteMode` with each entry laid over it in that order, the last winning, until a
snapshot holding the entry's divider has rendered. No client path writes a write mode into a
cache: a snapshot may insert a project-list row with its mode but never rewrites an existing
row's, and an applied entry or a newly rendered divider invalidates the Works query and the
project thread lists instead.

One ledger host per chat per tab. The desktop shell keeps a single `ChatSurface` and moves it
between the center and the dock, so a chat has one mounted `ChatView` and one ledger; mobile
has its own lifetime. A dev-only registry in `useSwitchLedger` warns when a second ledger
mounts for a chat that already has one.

One hook speaks it: "Switch to … queued" when an entry becomes queued, "Switched to …" when a
divider renders. Entries and dividers present when the first successful history load lands
(mount, reload; an error does not count) are silent, and a cancel-out is silent. A failure stays
with the journal owner's keyed announcement, cleared on Retry and when the record is withdrawn.

The dock projection is tri-state while its query loads: pending count and review
availability are `null`, distinct from loaded zero/false; loading client state
must never imply that nothing is pending.

The shared Work picker and selected-Work write-mode presentation live in the
neutral `components/app/work-composer-controls` boundary. The Chat landing and
chat detail adapt that presentation to different commands: the landing edits
prospective creation state, while chat detail can durably rebind an idle existing
thread. The landing's write-mode control edits prospective creation state. Draft
review launch behavior is injected by each project-shell adapter rather than
imported into the neutral controls.

Each assistant turn durably records the chat's write mode read when that turn is
created. Tool vocabulary and receipt interpretation use the turn's recorded
mode, not the chat's current mode, so a later switch cannot rewrite history
after reload.

### Composer placeholder and sizing contracts

`placeholders.ts` owns the per-page-load compose and interject prompt pools as
Lingui `msg` descriptors. `selectPagePlaceholders()` advances localStorage once
per page load and freezes that selection; component re-renders do not consume
another entry. `useSyncExternalStore` supplies a stable first descriptor during
SSR and the rotated descriptor on the client, while locale resolution happens
inside the hook. Composer owns rotation; its `placeholder` prop remains the
explicit override used by the Chat landing.

The Chat landing and chat detail share a neutral, shadowless Composer surface.
Their different placements intentionally retain different radius and
input-height geometry: the landing entry is not the chat footer. Do not add a
landing-only shadow or flatten those placement-specific geometry differences in
the name of shared implementation.

The base `Textarea` applies `field-sizing-content`, but Composer's JavaScript
resize loop requires `field-sizing: fixed`. Keep that override inline:
Tailwind merge does not reliably deduplicate `field-sizing-*` utilities.

For the shared pending projection and draft-review lifecycle, see
[draft review](draft-review.md).
