# Table chrome — contracts

## Verb matrix

Read-only and schema-fenced state outranks structural reasons. Inserts, deletes, alignment, header toggle
and placement aren't blocked by merged spans; row and column moves are. Reflecting verbs may be active while
blocked so the writer can turn a state off. Alignment with no explicit value is `null`, not an implicit left
choice.

## Targets

Axis and swept targets hold `NodeHold` cell identity; selection targets hold nothing. Materialize a held
target into a `CellSelection` only for evaluation or the command call, and don't cache a position or
selection across peer transactions.

The cell-menu claim is the last context rung. `claimedSweptCells` answers the actual cells covered by a
rectangle, not its `from..to` range, so a link, object or grip keeps priority. Nested-table reconcile lets a
held inner cell keep reveal while the pointer stays in its zone; a fresh unrelated cell wins.

## Geometry

The pane clips chrome, so there are no viewport fit tests or clamping rules. The expanded `tableHoverZone` owns
the gaps needed to reach a grip.

The add-row tab sits 6px inside the frame's bottom edge because the gap between blocks (about 14px) is smaller
than the tab; check any change to either number against `.ProseMirror > * + *`. A grip appears at the hovered
row at once, with no position transition and no scroll-driven re-measurement: it labels the row rather than
travelling to it.

`NodeHold` plus `useAnchorRect` follows cell identity and geometry separately. The selected table menu reads
kernel context rather than a per-keystroke local subscription.

Spanned or multi-block cells use the markup codec's escalated table representation.
