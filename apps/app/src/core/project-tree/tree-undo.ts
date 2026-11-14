/**
 * Sidebar Undo: the writer's tree changes made in this browser, newest last, one stack per list
 * copy, read a source at a time. A step is the record ids one gesture appended and the view it
 * was made in, or an Apply, which the server takes back whole by its command id; nothing else is
 * stored. Whether a step can still be taken is read from the list at the press (`undoChange`: by
 * history), or asked of the server for an Apply, and a step that no longer fits is skipped for
 * the one before it. There is no Redo: an Undo's own records go on no stack.
 */
import {
  isSourceRoot,
  LIVE,
  listRecords,
  sourceIdOf,
  type TreeProjection,
  TreeWriter,
  undoChange,
  type View,
  viewRecords,
} from "@meridian/project-tree";
import type { TreeListSession } from "@/core/tree-list/tree-list-session";

export type UndoStep = TreeStep | ApplyStep;

export type TreeStep = {
  kind: "tree";
  /** The records the gesture appended, in order. */
  records: readonly string[];
  /** The view it was made in: a press takes back only steps of the view on screen. */
  draft: string | null;
  /** The sources the gesture's nodes showed in after it: each source's stack holds it. */
  sources: readonly string[];
  /** The nodes it acted on, for the notice. */
  nodes: readonly string[];
};

/**
 * An Apply, one step whichever view is on screen: it changed live and the Work's tree alike.
 * `unapply` asks the server; `skipped` is its answer that something changed since.
 */
export type ApplyStep = {
  kind: "apply";
  /** The sources its nodes show in; none known, every source's stack holds it. */
  sources: readonly string[];
  /** What it applied, for the notice: "Ch 3 and Outline", "4 changes". */
  name: string;
  unapply(): Promise<"unapplied" | "skipped" | "failed">;
};

export type Skipped = { kind: "tree" | "apply"; name: string };

export type UndoOutcome =
  | { kind: "undone"; skipped: readonly Skipped[] }
  | { kind: "nothing"; skipped: readonly Skipped[] }
  /** An Apply's Un-Apply didn't reach the server: the step stays on the stack. */
  | { kind: "failed"; skipped: readonly Skipped[]; name: string };

const stacks = new WeakMap<TreeListSession, UndoStep[]>();

function stackOf(session: TreeListSession): UndoStep[] {
  let stack = stacks.get(session);
  if (!stack) {
    stack = [];
    stacks.set(session, stack);
  }
  return stack;
}

/** The source a node shows in: the top of its parent chain. */
export function shownSourceOf(projection: TreeProjection, node: string): string | null {
  let at = projection.nodes.get(node);
  for (let hops = 0; at && hops < 10_000; hops += 1) {
    if (isSourceRoot(at.parent)) return sourceIdOf(at.parent);
    at = projection.nodes.get(at.parent);
  }
  return null;
}

export function pushUndoStep(session: TreeListSession, step: UndoStep): void {
  if (step.kind === "apply" || step.records.length > 0) stackOf(session).push(step);
}

const holds = (step: UndoStep, source: string | null, view: View) =>
  (step.kind === "apply" || step.draft === view.draft) &&
  (source === null || step.sources.length === 0 || step.sources.includes(source));

/**
 * Takes back the latest step of `source` (null: any) made in `view`, by opposite records, or an
 * Apply by the server's Un-Apply. A step that can't be taken back any more is dropped, named in
 * `skipped`, and the press goes on to the one before it. A record whose change was since
 * applied is in force live, so its opposite record is written live. The caller runs one press
 * at a time: while an Un-Apply is asked, steps only join the top of the stack.
 */
export async function undoLatest(
  session: TreeListSession,
  source: string | null,
  view: View,
  actor: string,
  pendingText?: ReadonlySet<string>,
): Promise<UndoOutcome> {
  const stack = stackOf(session);
  const skipped: Skipped[] = [];
  for (let at = stack.length - 1; at >= 0; at -= 1) {
    const step = stack[at] as UndoStep;
    if (!holds(step, source, view)) continue;
    stack.splice(at, 1);
    if (step.kind === "apply") {
      const answer = await step.unapply();
      if (answer === "unapplied") return { kind: "undone", skipped };
      if (answer === "failed") {
        stack.splice(at, 0, step);
        return { kind: "failed", skipped, name: step.name };
      }
      skipped.push({ kind: "apply", name: step.name });
      continue;
    }
    const { doc } = session.getSnapshot();
    const writer = new TreeWriter(doc, "local", (asked) =>
      asked.draft === null
        ? session.replay(LIVE)
        : asked.draft === view.draft
          ? session.replay(asked, pendingText)
          : null,
    );
    const names = step.nodes.flatMap(
      (node) => session.replay(view, pendingText).nodes.get(node)?.displayName ?? [],
    );
    let undone = 0;
    // One update per opposite record: each is judged against the replay the one before it left.
    for (const record of [...step.records].reverse()) {
      const answer = undoChange(writer, inForceView(writer, view, record), actor, record);
      if (typeof answer !== "string") undone += 1;
    }
    if (undone > 0) return { kind: "undone", skipped };
    skipped.push({ kind: "tree", name: names[0] ?? "" });
  }
  return { kind: "nothing", skipped };
}

/** Live when the record's change was applied (its family's last record in force is live). */
function inForceView(writer: TreeWriter, view: View, id: string): View {
  if (view.draft === null) return view;
  const named = listRecords(writer.doc).find((record) => record.id === id);
  const root = named?.carries ?? id;
  const last = viewRecords(writer.doc, view)
    .filter((record) => (record.carries ?? record.id) === root)
    .pop();
  return last && last.draft === null ? LIVE : view;
}
