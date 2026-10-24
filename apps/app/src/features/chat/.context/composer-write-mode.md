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
(the record's mode when the record is there, else `thread.effectiveAiWriteMode` from the
project thread list, else the Work's default; `effectiveAiWriteMode` is the queued switch's mode,
else the applied `aiWriteMode`, so a reload shows a pending switch before the snapshot lands)
with the switch view's intents laid over it
(`useThreadControls().writeMode`), and a choice dispatches a `write_mode`
control: a record in the chat's submission journal, posted in order with the
messages around it. In the new-chat composer the value is the selected Work's
`defaultAiWriteMode`, and `aiWriteMode` is sent with the first message only if
the writer picked one there. Switching never touches drafts: the dock keeps
showing pending changes in either mode, and its generating state reads the
running turn's own mode.

The **switch view** is a read of the chat's run-state slice (`@meridian/thread-client`'s `run-state/run-state-slice.ts`;
`thread-controls/useSwitchView.ts` is its hook). Every server fact about a switch is a whole
`RunState` record, and the view is a function of the latest record plus this device's unanswered
intents. The mechanics live in the module headers: `run-state-slice.ts` (what is news, and what has
been spoken), `thread-client`'s `run-state/run-state-view.ts` (records, intents, answers) and
`run-state/fold-switches.ts` (the fold the toolbar and rows read). The constraints that shape callers:

- The first record is always a snapshot. A frame or answer before it extends nothing, so a failed
  first load shows no rows and announces nothing.
- An unanswered intent is laid over the record even if the record already includes it; the
  answer's record version bounds the effect.
- A row the server lists is `queued`; one only this device holds is `sending`; a failed or refused
  one shows Retry and is left out of the fold.
- One reducer decides what is news. A pending switch learned from a live frame or an answer after
  the first record is announced once; a snapshot, a replayed frame and the apply are silent. A
  failure stays with the journal owner's keyed announcement.
- One view host per chat per tab. The desktop shell keeps a single `ChatSurface` and moves it
  between the center and the dock; mobile has its own lifetime. A dev-only registry in
  `useSwitchView` warns when a second view mounts for a chat.
- Ordering within a chat belongs to the submission driver's per-chat lock, so a switch is posted
  in order with the messages around it.

**The notice.** `thread-controls/WriteModeNotice.tsx` is a quiet, one-line writer-action notice with
an icon for the mode (no compaction mark, rule or icon). It is the pending switch and the applied switch turn. A pending switch reads "Switch to … queued" only when its record item's
`deliveryState` is `waiting` (a reply that already held the chat when it was made has to finish
first), and "Switched to …" otherwise (`awaiting_run`: the next run applies it, whether or not a
reply is running when you look). The row and the announcer read that same fact; before the server
lists the switch (the `sending` row) a running reply is the only fact, and it is not announced. Stop
is on the row from its first frame, disabled while the switch's post is unanswered.
A pending switch sits at the transcript tail, except when the record says it applies at the next
run's start (`awaiting_run`) and a Retry's reply stand-in is showing: `viewTranscript`'s
`controlSlot` puts it before that stand-in, where its turn lands. Both carry **Stop**, not Withdraw, as do queued compactions; Stop cancels like a switch back, and
the Work default follows the writer's latest choice, Stop included. An applied switch has no row of its own:
the `write_mode.switched` frame carries the switch turn's anchor (`prevTurnId`, `position`) and the
shared reducer inserts the turn right after that turn. When the anchor is not in the transcript the
turn is held out and the subscriber's gap-only refresh brings both.

No client path writes a write mode into a cache: a snapshot may insert a project-list row with its
mode but never rewrites an existing row's, and a queued or cancelled switch (the control's POST) and a `switched` frame invalidate the Works query
and the project thread lists instead (the chat feed is not among them: it waits for the switch turn). So does a change in the ids of the record's `write_mode`
items (another tab's queue, cancel or withdrawal): `useSwitchView` compares that key between
records, taking the first record as its baseline, and calls `invalidateWriteModeReads`.

The composer control shows the number of documents waiting as "Drafts (3)", from the
Work's drafts list, in the trigger (while in Draft) and the menu option (in either mode); with none it reads "Draft".
The count matters most from Auto-apply, when the writer is about to switch into draft mode, so the
`useWorkBranchDrafts` read carries no mode gate. It counts the Work's pending document drafts, while the draft dock (`DraftDock`)
lists only this chat's changes, so "Drafts (2)" beside a one-document draft dock is correct.

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
[draft review](../../draft-review/.context/draft-review.md).
