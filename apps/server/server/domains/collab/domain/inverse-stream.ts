/**
 * One inverse's ordered steps over one document (D76): each selected original edit becomes one
 * step, text or tree, planned against the history and states the steps before it leave. The
 * model's undo, redo and revert, the turn card and a reply's rollback all plan through it, and
 * the commit runs the steps in this order.
 */
import { randomUUID } from "node:crypto";
import type { ComputedInverseEdit } from "@meridian/agent-edit/integration";
import {
  advanceStates,
  type PlannedTreeInverse,
  plannedTransition,
  type StoredTreeEntry,
  type TreeStates,
  treeKey,
} from "./tree-inverse.js";
import type { InverseDocument } from "./turn-inverse-service.js";

/** One step: the action its row joins, and `at`, its original's place on the history axis. */
export type InverseStep = { actionId: string; at: number } & (
  | { kind: "text"; edit: ComputedInverseEdit }
  | { kind: "tree"; planned: PlannedTreeInverse }
);

/** Who a simulated row says made it, as the committed row will. */
export type SimulatedRowIdentity = Pick<
  StoredTreeEntry,
  "threadId" | "turnId" | "responseId" | "editScopeId" | "actor"
>;

/**
 * The document as the steps planned so far leave it: its tree history with a row per planned
 * tree step, its destinations' states, and one clock for the ids of simulated text parts and
 * tree rows alike, so a later step orders them as the database will.
 */
export function simulateInverse(
  document: InverseDocument,
  options: { rolledBack?: ReadonlySet<string>; identity: SimulatedRowIdentity },
) {
  const tree = [...document.tree];
  const rolledBack = new Set(options.rolledBack);
  let states: TreeStates = document.treeStates;
  let clock = Math.max(0, ...document.history.map((part) => part.id), ...tree.map((row) => row.id));
  let steps = 0;
  return {
    tree,
    rolledBack,
    get states() {
      return states;
    },
    nextId: () => ++clock,
    nextStep: () => steps++,
    /**
     * Whether the live document is removed at this point, so live text can't be reversed: a
     * restore planned earlier brings it back, a delete planned earlier takes it away.
     */
    liveRemoved: () => (states.live ? !states.live.living : document.removal !== null),
    /** Records a planned tree step as the row it commits, and advances the states past it. */
    recordTree(
      planned: PlannedTreeInverse,
      row: { kind: "undo" | "redo" | "revert" | "rollback"; actionId: string; consumes: string[] },
    ) {
      const target = { editId: planned.entry.editId, direction: planned.direction };
      tree.push({
        ...options.identity,
        id: ++clock,
        editId: randomUUID(),
        documentId: document.documentId,
        wId: null,
        kind: row.kind,
        actionId: row.actionId,
        consumes: row.consumes,
        targets: [target],
        tree: {
          ...plannedTransition(planned),
          op: planned.op,
          shownAt: planned.entry.tree.shownAt,
          seq: clock,
          targets: [target],
        },
      });
      if (row.kind === "rollback") rolledBack.add(treeKey(planned.entry.editId));
      states = advanceStates(states, planned);
    },
  };
}
