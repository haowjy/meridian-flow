# Composer write mode

## Binding

`ProjectView` resolves the displayed thread's Work once and passes that identity to
`DraftReviewProvider` and `ChatView`, so the dock and composer control share one
binding. Project chat always has a Work, named or No Work, looked up from
`snapshot.noWork` rather than `works.find`. There is no first/default-Work fallback.

Only the writer rebinds, through `ComposerWorkControl`; Work management, navigation
and the model's `work switch` never call this path
([rule](../../../../../server/server/domains/runtime/.context/tools.md#permissions)).

The toolbar's placement and focus are in the
[composer-toolbar contracts](../../../components/app/composer-toolbar/.context/CONTEXT.md).

## The value and the switch

In an existing chat the value is the record's mode, else
`thread.effectiveAiWriteMode` from the project thread list, else the Work's default,
with the switch view's intents laid over it. `effectiveAiWriteMode` is the queued
switch's mode, so a reload shows a pending switch before the snapshot lands. A
choice dispatches a `write_mode` control through the chat's submission journal,
posted in order with the messages around it. In the new-chat composer, `aiWriteMode`
is sent with the first message only if the writer picked one there.

Each assistant turn records the chat's write mode when it is created. Tool
vocabulary and receipts read that recorded mode, so a later switch can't rewrite
history after reload.

The switch view reads the chat's run-state slice; the mechanics are in the headers
of `run-state-slice.ts`, `run-state-view.ts` and `fold-switches.ts`. What shapes
callers:

- The first record is always a snapshot. A frame or answer before it extends
  nothing, so a failed first load shows no rows and announces nothing.
- An unanswered intent is laid over the record even if the record already includes
  it; the answer's record version bounds the effect.
- One reducer decides what is news. A pending switch learned from a live frame or
  answer after the first record is announced once; a snapshot, a replayed frame and
  the apply are silent.
- One view host per chat per tab. The desktop shell moves a single `ChatSurface`
  between main and the side, and a dev-only registry in `useSwitchView` warns when a
  second view mounts.

A pending switch reads "Switch to … queued" only when its record item's
`deliveryState` is `waiting`; `awaiting_run` reads "Switched to …", because the next
run applies it. It sits at the transcript tail, except that an `awaiting_run` switch
goes before a Retry's stand-in, where its turn lands (`controlSlot`). An applied
switch's `write_mode.switched` frame carries its anchor; if the anchor isn't in the
transcript the turn is held out and the subscriber's gap-only refresh brings both.

No client path writes a write mode into a cache. Queue, cancel and `switched` events
invalidate the Works query and project thread lists instead, and `useSwitchView`
does the same when another tab changes the record's `write_mode` item ids.

"Drafts (3)" counts the Work's pending document drafts while the draft dock lists
only this chat's changes, so "Drafts (2)" beside a one-document dock is correct. The
read carries no mode gate because the count matters most from Auto-apply. While the
dock projection loads, its count and availability are `null`, distinct from loaded
zero/false, so loading never implies nothing is pending.

## Placeholder and sizing

`selectPagePlaceholders()` advances localStorage once per page load, and re-renders
don't consume another entry. `useSyncExternalStore` supplies a stable first
descriptor during SSR.

The Chat landing and chat detail keep different radius and input-height geometry
because the landing entry is not the chat footer. Don't flatten them for shared
code, or add a landing-only shadow.

The base `Textarea` applies `field-sizing-content`, but Composer's JavaScript resize
loop needs `field-sizing: fixed`. Keep that override inline: Tailwind merge doesn't
reliably deduplicate `field-sizing-*`.
