# surfaces/peer-marks

The popover a peer mark opens. The marks are
[`PeerMarkerExtension.ts`](../../../../core/editor/extensions/PeerMarkerExtension.ts).

Dormant: no server code sends `change_event`, so no mark renders and nothing here runs in
the app. The lane waits for the history feature, which will decide what marks show and where
their data comes from
([KB](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/architecture/collaboration/turn-receipts.md#the-receipt-is-a-record-of-what-the-turn-wrote)).
Don't extend it for new work, and don't delete it.

- `PeerMarkSurface` reads the press the plugin writes and listens to no DOM event of its
  own. A press is not a marker: the marker is looked up live on every render, so a mark the
  writer's own edit cleared closes the popover instead of freezing its state.
- Evidence is read, never reversed: the receipt is the only place an AI change is undone.
- Focus goes back through the popover's `returnFocus`, not a timer. A
  `requestAnimationFrame` loses: the layer's own hand-back lands a frame later and puts the
  caret in the prose.
- Nothing is handed back when another surface opened, because restoring would pull focus
  out of a form on the frame it appeared. That guard is the layer's, which is why the return
  runs there.
- The rect is asked for, never captured. Every remote write rebuilds the decorations, and a
  held span measures as a rect of zeros.

Popover focus and receipt rules: [`../../.context/CONTEXT.md`](../../.context/CONTEXT.md).
