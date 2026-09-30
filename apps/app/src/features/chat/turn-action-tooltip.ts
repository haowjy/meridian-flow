/**
 * Where a turn's action-row tooltips open: below their buttons. The row sits
 * under the message it acts on (writer bubble, reply text, compaction divider),
 * so a label opened upward would cover that message. Collision handling still
 * flips it upward near the viewport bottom.
 */
export const TURN_ACTION_TOOLTIP_SIDE = "bottom" as const;
