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
(the snapshot's record, else `thread.effectiveAiWriteMode` from the project thread list: the
queued switch's mode, else the applied `aiWriteMode`) with the switch view's intents laid over it
(`useThreadControls().writeMode`), and a choice dispatches a `write_mode`
control: a record in the chat's submission journal, posted in order with the
messages around it. In the new-chat composer the value is the selected Work's
`defaultAiWriteMode`, and `aiWriteMode` is sent with the first message only if
the writer picked one there. Switching never touches drafts: the dock keeps
showing pending changes in either mode, and its generating state reads the
running turn's own mode.

The **switch view** is the one owner of a switch on screen (`client/run-state/`, pure, importing
only `@meridian/contracts`; `thread-controls/useSwitchView.ts` is its hook). Every server fact
about a switch carries one clock, the thread's event `seq`, and the view is a function of those
facts plus this device's unanswered intents. The mechanics live in the module headers:
`switch-record.ts` (where a record comes from), `switch-reducer.ts` (the one reducer, and what is
news), `run-state/run-state-view.ts` (records, intents, answers) and `run-state/fold-switches.ts`
(the fold the toolbar and rows read). The constraints that shape callers:

- The first record is always a snapshot. A frame, stamp or answer before it extends nothing, so a
  failed first load shows no rows and announces nothing. `subscribed` is never a source.
- Another tab's stamp answers a record this tab chose, so a hidden driving tab cannot strand the
  choosing tab's row. An unanswered intent is laid over the record even if the record already
  includes it; the answer's `seq` bounds the effect.
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
an icon for the mode (no compaction mark, rule or icon). It is the pending switch at the
transcript tail and the applied switch turn. A pending switch reads "Switched to …" while no reply
holds the chat (it applies when the next run is admitted) and "Switch to … queued" while one does.
"Holds the chat" is a server fact, never the client's running-reply flag: the row reads the record
item's `deliveryState === "waiting"` (the server lists the switch behind a run that held the chat
first), and the announcer reads the same fact. Only the unlisted `sending` row, which has no record
item yet, falls back to the flag.
Both carry **Stop**, not Withdraw, as do queued compactions; Stop cancels like a switch back, and
the Work default follows the writer's latest choice, Stop included. The bridge row is the
transcript layer's: an applied switch whose turn has not rendered shows the notice with no Stop,
keyed by the `write_mode.switched` frame's turn, until that turn renders.

No client path writes a write mode into a cache: a snapshot may insert a project-list row with its
mode but never rewrites an existing row's. Instead the control's POST, Stop's withdraw and a
queued-switch transition in the pending inbox (`queuedSwitchKey` in `pending-inbox.ts`, so another
tab's included) call `invalidateWriteModeReads` (thread and Works reads), and a `switched` frame
invalidates the project thread data. The queue POST does not invalidate the chat feed.

The composer control shows the number of documents waiting beside Draft ("Draft (3)"), from the
Work's draft list, in the trigger and the menu option; with none it reads "Draft".

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
