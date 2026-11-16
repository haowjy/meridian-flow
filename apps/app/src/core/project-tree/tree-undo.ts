/**
 * Sidebar Undo: the writer's tree changes made in this browser, newest last, one stack per list
 * copy, read a source at a time. A step is the record ids one gesture appended and the view it
 * was made in, or an Apply, which the server takes back whole by its command id; nothing else is
 * stored. Whether a step can still be taken is read from the list at the press (`undoChange`:
 * by the changes in force), or asked of the server for an Apply, and a step that no longer fits
 * is skipped for the one before it. A notice's Undo (`undoStep`) takes back the same step a press would. There is
 * no Redo: an Undo's own records go on no stack.
 *
 * Each list also holds the notice its rows show (`treeNotice`): the writer's latest gesture with
 * its Undo, or what a press skipped or couldn't take back. It ends at the next gesture or press,
 * or when its step leaves the stack. Beside it, the writer's changes the server bounced since
 * (`treeBounces`: their Work was closed), each said on the row it was made on; they end at the
 * writer's next gesture, press or action elsewhere in the list, as the notice does.
 */
import {
  type DroppedRecord,
  deleteStands,
  isSourceRoot,
  LIVE,
  sourceIdOf,
  type TreeProjection,
  TreeWriter,
  undoChange,
  type View,
} from "@meridian/project-tree";
import type { TreeListSession } from "@/core/tree-list/tree-list-session";

export type UndoStep = TreeStep | ApplyStep;

/** What the writer did; a create shows no notice (the new row says it). */
export type TreeGesture = "create" | "rename" | "move" | "delete" | "restore";

export type Was = {
  name: string;
  kind: "folder" | "document";
  /** The folder's name, null at the top of a source. */
  folder: string | null;
  /** The folder's or the source's id: the parent the tree's rows are listed under. */
  parent: string;
  /** The siblings listed before it, nearest first. */
  after: readonly string[];
};

export type TreeStep = {
  kind: "tree";
  gesture: TreeGesture;
  /** Each node as it was before the gesture: what its notice says, and where a gone row stays. */
  was: ReadonlyMap<string, Was>;
  /** The records the gesture appended, in order. */
  records: readonly string[];
  /** The view it was made in: a press takes back only steps of the view on screen. */
  draft: string | null;
  /** The sources the gesture's nodes showed in after it: each source's stack holds it. */
  sources: readonly string[];
  /** The nodes it acted on, for the notice. */
  nodes: readonly string[];
  /** Hears the step leave the stack, taken back or skipped: a notice holding its Undo ends. */
  ended?: () => void;
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
  /** The nodes it took, whose rows say what an Undo of it couldn't do. */
  nodes: readonly string[];
  unapply(): Promise<{ answer: "unapplied" | "skipped" | "failed" }>;
};

export type Skipped = { kind: "tree" | "apply"; name: string; nodes: readonly string[] };

/**
 * What a list's rows say: the latest gesture, whose rows offer its Undo, or what the latest press
 * has to say about the steps it couldn't take back, each on that step's rows.
 */
export type TreeNotice = { kind: "step"; step: TreeStep } | { kind: "said"; said: readonly Said[] };

export type Said =
  | { kind: "skipped"; of: Skipped["kind"]; name: string; nodes: readonly string[] }
  /** An Apply's Un-Apply didn't reach the server; `step` is still on the stack. */
  | { kind: "failed"; name: string; nodes: readonly string[]; step: ApplyStep };

/**
 * A change of the writer's that the server bounced (it changed a Work that was closed): the row
 * stands as it was before it, and says so.
 */
export type Bounce = {
  record: DroppedRecord["record"];
  /** What Copy takes: a created document's typed text, or a rename's name; null when there is none. */
  typed: string | null;
  /** A create's row as the writer made it, which stays struck through where it was. */
  made?: Was;
};

export type UndoOutcome =
  | {
      kind: "undone";
      skipped: readonly Skipped[];
      /** What the step taken back acted on: where the focus follows it. */
      nodes: readonly string[];
    }
  | { kind: "nothing"; skipped: readonly Skipped[] }
  /** An Apply's Un-Apply didn't reach the server: the step stays on the stack. */
  | { kind: "failed"; skipped: readonly Skipped[]; name: string; step: ApplyStep };

function saidOf(outcome: UndoOutcome): TreeNotice | null {
  const said: Said[] = [
    ...outcome.skipped.map(({ kind, ...each }) => ({
      kind: "skipped" as const,
      of: kind,
      ...each,
    })),
    ...(outcome.kind === "failed"
      ? [
          {
            kind: "failed" as const,
            name: outcome.name,
            nodes: outcome.step.nodes,
            step: outcome.step,
          },
        ]
      : []),
  ];
  return said.length ? { kind: "said", said } : null;
}

const stacks = new WeakMap<TreeListSession, UndoStep[]>();
const notices = new WeakMap<TreeListSession, TreeNotice>();
const bounces = new WeakMap<TreeListSession, readonly Bounce[]>();
const listeners = new Set<() => void>();
let revision = 0;

/** Changes whenever any list's notice does. */
export const treeNoticeRevision = () => revision;

export function treeNotice(session: TreeListSession | null): TreeNotice | null {
  return (session && notices.get(session)) ?? null;
}

export function subscribeTreeNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function changed() {
  revision += 1;
  for (const listener of [...listeners]) listener();
}

function show(session: TreeListSession, notice: TreeNotice | null) {
  if (notice === (notices.get(session) ?? null)) return;
  if (notice) notices.set(session, notice);
  else notices.delete(session);
  changed();
}

/** The writer's changes the server bounced since their last action in the list, oldest first. */
export function treeBounces(session: TreeListSession | null): readonly Bounce[] {
  return (session && bounces.get(session)) ?? [];
}

/** The server bounced these changes of the writer's: their rows say so until the writer acts. */
export function addBounces(session: TreeListSession, added: readonly Bounce[]): void {
  if (added.length === 0) return;
  bounces.set(session, [...treeBounces(session), ...added]);
  changed();
}

/** The writer acted in the list: what its rows said of bounced changes ends. */
function actedIn(session: TreeListSession) {
  if (bounces.delete(session)) changed();
}

/** The writer acted elsewhere in the list (opened a document): its notice ends. */
export function endTreeNotice(session: TreeListSession): void {
  actedIn(session);
  show(session, null);
}

/** Ends the notice when it is `step`'s: the step left the stack. */
function endStepNotice(session: TreeListSession, step: UndoStep) {
  const notice = notices.get(session);
  if (notice?.kind === "step" && notice.step === step) show(session, null);
}

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
  if (step.kind === "tree" && step.records.length === 0) return;
  stackOf(session).push(step);
  actedIn(session);
  // A gesture in the list is the writer's next action there; an Apply is made in Changes.
  if (step.kind === "tree")
    show(session, step.gesture === "create" ? null : { kind: "step", step });
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
  actedIn(session);
  show(session, null);
  const outcome = await takeLatest(session, source, view, actor, pendingText);
  show(session, saidOf(outcome));
  return outcome;
}

async function takeLatest(
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
    if (step.kind === "tree") step.ended?.();
    if (step.kind === "apply") {
      const { answer } = await step.unapply();
      if (answer === "unapplied") return { kind: "undone", skipped, nodes: step.nodes };
      if (answer === "failed") {
        stack.splice(at, 0, step);
        return { kind: "failed", skipped, name: step.name, step };
      }
      skipped.push({ kind: "apply", name: step.name, nodes: step.nodes });
      continue;
    }
    const names = step.nodes.flatMap(
      (node) => session.replay(view, pendingText).nodes.get(node)?.displayName ?? [],
    );
    if (takeBack(session, step, view, actor, pendingText))
      return { kind: "undone", skipped, nodes: step.nodes };
    skipped.push({ kind: "tree", name: names[0] ?? "", nodes: step.nodes });
  }
  return { kind: "nothing", skipped };
}

/**
 * A row's Undo: takes back `step` if it is still on the stack, as a press would, and says so as a
 * press does. False when a press took it first or nothing of it can be taken back any more.
 */
export async function undoStep(
  session: TreeListSession,
  step: UndoStep,
  actor: string,
  pendingText?: ReadonlySet<string>,
): Promise<boolean> {
  if (step.kind === "apply") return (await undoApply(session, step)) === "unapplied";
  const stack = stackOf(session);
  const at = stack.indexOf(step);
  if (at < 0) return false;
  stack.splice(at, 1);
  actedIn(session);
  show(session, null);
  step.ended?.();
  const view = step.draft === null ? LIVE : { draft: step.draft };
  const name = step.nodes.flatMap((node) => step.was.get(node)?.name ?? []).at(0) ?? "";
  const undone = takeBack(session, step, view, actor, pendingText);
  show(
    session,
    undone
      ? null
      : saidOf({ kind: "nothing", skipped: [{ kind: "tree", name, nodes: step.nodes }] }),
  );
  return undone;
}

/**
 * An applied row's Undo: the server's Un-Apply of `step`, if it is still on the stack, as Ctrl+Z
 * would take it, said on its rows as a press says it. Its answer, or null when a press took it
 * first.
 */
export async function undoApply(
  session: TreeListSession,
  step: ApplyStep,
): Promise<"unapplied" | "skipped" | "failed" | null> {
  const stack = stackOf(session);
  const at = stack.indexOf(step);
  if (at < 0) return null;
  stack.splice(at, 1);
  show(session, null);
  const { answer } = await step.unapply();
  if (answer === "failed") stack.splice(Math.min(at, stack.length), 0, step);
  show(
    session,
    saidOf(
      answer === "failed"
        ? { kind: "failed", skipped: [], name: step.name, step }
        : answer === "skipped"
          ? { kind: "nothing", skipped: [{ kind: "apply", name: step.name, nodes: step.nodes }] }
          : { kind: "undone", skipped: [], nodes: step.nodes },
    ),
  );
  return answer;
}

/**
 * Ends the delete `step` when none of its records can be undone any more (their Trash entries
 * are gone: restored by anyone, or purged): a notice offers an Undo that no longer applies. A
 * folder's other children still in the entry keep it standing. Returns the stop for the watch.
 */
export function endWhenRestored(session: TreeListSession, step: TreeStep): () => void {
  const view: View = step.draft === null ? LIVE : { draft: step.draft };
  const stop = session.subscribe(() => {
    const writer = writerOf(session, view);
    if (step.records.some((record) => deleteStands(writer, view, record))) return;
    stop();
    const stack = stackOf(session);
    const at = stack.indexOf(step);
    if (at < 0) return;
    stack.splice(at, 1);
    endStepNotice(session, step);
    step.ended?.();
  });
  return stop;
}

function writerOf(session: TreeListSession, view: View, pendingText?: ReadonlySet<string>) {
  const { doc } = session.getSnapshot();
  return new TreeWriter(doc, "local", (asked) =>
    asked.draft === null
      ? session.replay(LIVE)
      : asked.draft === view.draft
        ? session.replay(asked, pendingText)
        : null,
  );
}

/** Writes the step's opposite records; true when any was written. */
function takeBack(
  session: TreeListSession,
  step: TreeStep,
  view: View,
  actor: string,
  pendingText?: ReadonlySet<string>,
): boolean {
  const writer = writerOf(session, view, pendingText);
  let undone = 0;
  // One update per opposite record: each is judged against the replay the one before it left.
  for (const record of [...step.records].reverse()) {
    const answer = undoChange(writer, view, actor, record);
    if (typeof answer !== "string") undone += 1;
  }
  return undone > 0;
}
