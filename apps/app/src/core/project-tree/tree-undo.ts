import type { ClosedOwnerWhy } from "@meridian/contracts/commands";
import {
  type DroppedRecord,
  deleteHides,
  deleteStands,
  isSourceRoot,
  LIVE,
  sourceIdOf,
  type TreeProjection,
  TreeWriter,
  takeBackAll,
  type View,
} from "@meridian/project-tree";
import type { TreeListSession } from "@/core/tree-list/tree-list-session";

export type UndoStep = TreeStep | PressStep;

export type TreeGesture = "create" | "rename" | "move" | "delete" | "restore";

export type Was = {
  name: string;
  kind: "folder" | "document";
  folder: string | null;
  parent: string;
  after: readonly string[];
};

export type TreeStep = {
  kind: "tree";
  gesture: TreeGesture;
  was: ReadonlyMap<string, Was>;
  records: readonly string[];
  draft: string | null;
  sources: readonly string[];
  nodes: readonly string[];
  waits?: readonly string[];
  ended?: () => void;
  rested?: () => void;
};

export type ClosedOwner = { why: ClosedOwnerWhy; owner?: string };

export type ClosedOwners = {
  source(sourceId: string): ClosedOwner | null;
};

export const NOTHING_CLOSED: ClosedOwners = { source: () => null };

export type PressStep = {
  kind: "press";
  sources: readonly string[];
  nodes: readonly string[];
  undo(): Promise<boolean>;
};

export type TreeNotice = { kind: "step"; step: TreeStep };

export type Bounce = {
  record: DroppedRecord["record"];
  typed: string | null;
  made?: Was;
};

export type UndoOutcome =
  | {
      kind: "undone";
      nodes: readonly string[];
    }
  | { kind: "nothing" };

const stacks = new WeakMap<TreeListSession, UndoStep[]>();
const notices = new WeakMap<TreeListSession, TreeNotice>();
const bounces = new WeakMap<TreeListSession, readonly Bounce[]>();
const listeners = new Set<() => void>();
let revision = 0;

export const treeNoticeRevision = () => revision;

export function treeNotice(session: TreeListSession | null): TreeNotice | null {
  const notice = (session && notices.get(session)) ?? null;
  return session && notice?.kind === "step" && rests(session, notice.step) ? null : notice;
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

export function treeBounces(session: TreeListSession | null): readonly Bounce[] {
  return (session && bounces.get(session)) ?? [];
}

export function addBounces(session: TreeListSession, added: readonly Bounce[]): void {
  if (added.length === 0) return;
  bounces.set(session, [...treeBounces(session), ...added]);
  changed();
}

function actedIn(session: TreeListSession) {
  if (bounces.delete(session)) changed();
}

export function endTreeNotice(session: TreeListSession): void {
  actedIn(session);
  show(session, null);
}

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

export function shownSourceOf(projection: TreeProjection, node: string): string | null {
  let at = projection.nodes.get(node);
  for (let hops = 0; at && hops < 10_000; hops += 1) {
    if (isSourceRoot(at.parent)) return sourceIdOf(at.parent);
    at = projection.nodes.get(at.parent);
  }
  return null;
}

export function dropUndoStep(session: TreeListSession, step: UndoStep): void {
  const stack = stackOf(session);
  const at = stack.indexOf(step);
  if (at >= 0) stack.splice(at, 1);
}

export function pushUndoStep(session: TreeListSession, step: UndoStep): void {
  if (step.kind === "tree" && step.records.length === 0) return;
  stackOf(session).push(step);
  actedIn(session);
  if (step.kind === "tree")
    show(session, step.gesture === "create" ? null : { kind: "step", step });
}

function waitsForClosed(step: TreeStep, closed: ClosedOwners): boolean {
  const waits = step.waits ?? [];
  return waits.length > 0 && waits.every((source) => closed.source(source) !== null);
}

const fits = (step: UndoStep, source: string | null, view: View) =>
  (step.kind === "press" || step.draft === view.draft) &&
  (source === null || step.sources.length === 0 || step.sources.includes(source));

export async function undoLatest(
  session: TreeListSession,
  source: string | null,
  view: View,
  actor: string,
  closed: ClosedOwners,
): Promise<UndoOutcome> {
  actedIn(session);
  show(session, null);
  return takeLatest(session, source, view, actor, closed);
}

async function takeLatest(
  session: TreeListSession,
  source: string | null,
  view: View,
  actor: string,
  closed: ClosedOwners,
): Promise<UndoOutcome> {
  const stack = stackOf(session);
  for (let at = stack.length - 1; at >= 0; at -= 1) {
    const step = stack[at] as UndoStep;
    if (!fits(step, source, view)) continue;
    if (step.kind === "press") {
      return (await step.undo()) ? { kind: "undone", nodes: step.nodes } : { kind: "nothing" };
    }
    if (waitsForClosed(step, closed) || rests(session, step)) continue;
    stack.splice(at, 1);
    const back = takeBack(session, step, view, actor, closed);
    if (back === "undone") {
      step.ended?.();
      return { kind: "undone", nodes: step.nodes };
    }
    if (back.length > 0) {
      step.waits = back;
      stack.splice(at, 0, step);
      return { kind: "nothing" };
    }
    step.ended?.();
  }
  return { kind: "nothing" };
}

export async function undoStep(
  session: TreeListSession,
  step: UndoStep,
  actor: string,
  closed: ClosedOwners,
): Promise<boolean> {
  if (step.kind === "press") return step.undo();
  const stack = stackOf(session);
  const at = stack.indexOf(step);
  if (at < 0 || rests(session, step)) return false;
  stack.splice(at, 1);
  actedIn(session);
  show(session, null);
  const view = step.draft === null ? LIVE : { draft: step.draft };
  const back = takeBack(session, step, view, actor, closed);
  if (back === "undone") {
    step.ended?.();
    show(session, null);
    return true;
  }
  if (back.length > 0) {
    step.waits = back;
    stack.splice(Math.min(at, stack.length), 0, step);
    return false;
  }
  step.ended?.();
  return false;
}

function rests(session: TreeListSession, step: TreeStep): boolean {
  if (step.gesture !== "delete") return false;
  const view: View = step.draft === null ? LIVE : { draft: step.draft };
  const writer = writerOf(session, view);
  return (
    step.records.some((record) => deleteStands(writer, view, record)) &&
    !step.records.some((record) => deleteHides(writer, view, record))
  );
}

export function endWhenRestored(session: TreeListSession, step: TreeStep): () => void {
  const view: View = step.draft === null ? LIVE : { draft: step.draft };
  let resting = rests(session, step);
  const stop = session.subscribe(() => {
    const writer = writerOf(session, view);
    if (step.records.some((record) => deleteStands(writer, view, record))) {
      if (rests(session, step) === resting) return;
      resting = !resting;
      if (resting) step.rested?.();
      changed();
      return;
    }
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

function writerOf(session: TreeListSession, view: View) {
  const { doc } = session.getSnapshot();
  return new TreeWriter(doc, "local", (asked) =>
    asked.draft === null
      ? session.replay(LIVE)
      : asked.draft === view.draft
        ? session.replay(asked)
        : null,
  );
}

function takeBack(
  session: TreeListSession,
  step: TreeStep,
  view: View,
  actor: string,
  closed: ClosedOwners,
): "undone" | string[] {
  const writer = writerOf(session, view);
  // One walk: each record is judged against the list the one before it left, and the records that
  // land go into the list as one update. A record into a source the tab reads as closed is not
  // written; admission drops one into a source closed since, when the update reaches the server.
  const walked = takeBackAll(
    writer,
    actor,
    [...step.records].reverse().map((id) => ({ id, view })),
    (source) => closed.source(source) !== null,
  );
  const answers = [...walked.values()];
  if (answers.some((back) => typeof back !== "string" && !("closed" in back))) return "undone";
  return [
    ...new Set(
      answers.flatMap((back) =>
        typeof back !== "string" && "closed" in back ? [back.closed] : [],
      ),
    ),
  ];
}
