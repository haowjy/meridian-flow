# surfaces/peer-marks — what a writer meets a peer's change through

One summoned surface: the popover a peer mark opens, with the attribution, the
time, the Before/After disclosure, and the door into the conversation that made
the change. The marks themselves — the decorations, the anchors, the self-clear
reducer — are
[`core/editor/extensions/PeerMarkerExtension.ts`](../../../../core/editor/extensions/PeerMarkerExtension.ts).

## Mental model

**The lane opens its own surface.** A click or an Enter on a mark is answered
inside the plugin that draws the marks, which writes a press
([`peer-mark-press.ts`](../../../../core/editor/extensions/peer-mark-press.ts)):
the mark's `changeId`, which door the writer came through, and the caret they
left behind. `PeerMarkSurface` reads that press and renders; it listens to no
DOM event of its own.

**A press is not a marker.** The marker is looked up live from the projection on
every render, so a mark the writer's own edit cleared closes the popover instead
of freezing the state it had at press time.

**Evidence is read, never reversed.** Detail comes from the shared trail cache
in [`features/change-trail`](../../../change-trail/AGENTS.md), and the receipt is
the only place an AI change is undone. While a first read is genuinely in flight
the actions row is withheld rather than drawn half-empty.

## Key rules

- **Focus goes back the way it came**, through the popover's `returnFocus` and
  never a timer of this lane's own. A pointer press leaves the caret in the
  sentence the writer was reading (`focusOnOpen="prose"`) and close restores the
  held selection; the keyboard door takes focus into the popover and close hands
  it back to the mark's current span, queried rather than remembered. Racing
  Radix's teardown from a `requestAnimationFrame` looks right and loses: the
  layer's own hand-back lands a frame later and puts the caret in the prose.
- **Nothing is handed back when another surface opened.** The kernel replaces the
  open transient, so Mod+K reaches this surface as a close: the caret then
  belongs to whatever opened, and restoring it would pull focus out of a form on
  the frame it appeared. That guard is the layer's, which is the whole reason the
  return runs there.
- **The rect is asked for, never captured.** Marks are decorations and every
  remote write rebuilds them; a held span measures as a rect of zeros.

→ [`../../chrome/AGENTS.md`](../../chrome/AGENTS.md) — the primitives and the
  layer contract
→ [`../../.context/CONTEXT.md`](../../.context/CONTEXT.md) — the popover's copy
  and evidence rules
