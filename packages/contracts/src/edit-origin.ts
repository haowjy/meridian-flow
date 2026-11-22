/**
 * Immutable receipt origin: Live. `seq` is the Yjs journal row the edit's update was stored in,
 * for an edit made before the move to Loro; a Loro edit's update is its part's own `update`.
 */
export type EditOrigin = { kind: "live"; seq?: number };
