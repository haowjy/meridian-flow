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
(`thread.aiWriteMode`) with the switch view's intents laid over it
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
facts plus this device's unanswered intents:

- **Records.** `RunStateRecord = { version, mode, items }` is the server's state at `version`: the
  applied write mode and the unacknowledged inbox, which holds the queued switch as a control row.
  `receiveRecord` replaces the current record only if `compareSeq` says the new one is newer.
  Nothing else compares versions.
- **Where a record comes from** (`thread-controls/switch-record.ts`, which design A's server record
  replaces): the accepted snapshot (`nextSeq - 1` as version, `thread.aiWriteMode`,
  `liveState.pending.items`, read in one transaction); an `inbox.changed` frame at K
  (`{ ...current, version: K, items }`); a `write_mode.switched` frame at K
  (`{ ...current, version: K, mode }`); and a switch's answer, which carries `seq`, `mode` and
  `pending` (the current items with every write-mode control row replaced by `pending`). A frame
  before the first snapshot has no record to extend and is ignored; `subscribed` is never a source.
- **Intents.** A `switch` intent is a journal record the writer chose; a `withdraw` intent is a
  Withdraw in flight. An intent with an `answer` leaves once the record's version is at or after it;
  an unanswered one leaves only by `dropIntent` (the journal record vanished unstamped, a refusal
  withdrawn, a Withdraw the server never had). Another tab's stamp (below) answers a record this tab
  chose, so a hidden driving tab cannot strand the choosing tab's row.
- **The fold** (`fold-switches.ts`, a selector): starting from the record's applied mode and its
  queued switch, the switch intents in `(order, id)` order apply the server's enqueue rule (a switch
  to the mode the chat is heading to changes nothing; the other mode withdraws the queued one). The
  toolbar shows the mode the chat is heading to. A row the server lists is `queued`; one only this
  device holds is `sending` (Retry only if posted and not refused); a failed or refused one shows
  Retry and is left out of the fold. An unanswered intent is laid over the record even if the record
  already includes it: the effect is bounded by the answer, which brings the state at its `seq`.
- **The bridge row** is the transcript layer's, not the view's: an applied switch whose divider
  has not rendered keeps a queued-looking row, keyed by the `write_mode.switched` frame's turn,
  until that turn renders.

No client path writes a write mode into a cache: a snapshot may insert a project-list row with its
mode but never rewrites an existing row's, and a `switched` frame invalidates the Works query and
the project thread lists instead.

One view host per chat per tab. The desktop shell keeps a single `ChatSurface` and moves it
between the center and the dock, so a chat has one mounted `ChatView` and one view; mobile has its
own lifetime. A dev-only registry in `useSwitchView` warns when a second view mounts for a chat that
already has one.

One hook speaks it: "Switch to … queued" when a switch the server lists is newly above the first
record's version, "Switched to …" for a `switched` frame above it. The first record, a replay and a
snapshot are never news. A failure stays with the journal owner's keyed announcement, cleared on
Retry and when the record is withdrawn.

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
