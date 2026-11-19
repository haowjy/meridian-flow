/**
 * Sidebar Undo: the writer's tree changes made in this browser, newest last, one stack per list
 * copy, read a source at a time. A step is the record ids one gesture appended and the view it
 * was made in, or an Apply, which the server takes back whole by its command id; nothing else is
 * stored. Whether a tree step can still be taken is read from the list at the press (`takeBackAll`:
 * by the changes in force), and one that no longer fits is skipped for the one before it. An Apply
 * is asked of the server, and its press is spent once the server answers, whatever it took back. A
 * tree step that waits for a closed owner (an archived or deleted Work, a chat in Trash) keeps its
 * place, and a press passes over it until the owner reopens (`waitsForClosed`). So does a delete that hides
 * nothing now (`rests`: what it took shows again, kept standing by an Apply or a create), until it
 * hides something again. A notice's Undo
 * (`undoStep`) takes back the same step a press would. There is no Redo: an Undo's own records go
 * on no stack.
 *
 * Each list also holds the notice its rows show (`treeNotice`): the writer's latest gesture with
 * its Undo. It ends at the next gesture or press, or when its step leaves the stack. Beside it, the writer's changes the server bounced since
 * (`treeBounces`: their Work was closed), each said on the row it was made on; they end at the
 * writer's next gesture, press or action elsewhere in the list, as the notice does.
 */
import type { ClosedOwnerWhy } from "@meridian/contracts/commands";
import {
  appliedNodes,
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
  /**
   * The closed sources its last press found every record waiting for: it keeps its place, and a
   * press passes over it while they are all closed.
   */
  waits?: readonly string[];
  /** Hears the step leave the stack, taken back or skipped: a notice holding its Undo ends. */
  ended?: () => void;
  /**
   * Hears a delete's step start to rest: a notice away from its rows, which can't hide its Undo
   * for now, ends; the rows and a press keep it.
   */
  rested?: () => void;
};

/** An archived or deleted Work, or a chat in Trash, named when the tab knows its name. */
export type ClosedOwner = { why: ClosedOwnerWhy; owner?: string };

/**
 * Which owners this tab reads as closed now, from the Works and chats it holds. A tree step some of
 * whose records are in them waits: a press passes over it while they are all closed.
 */
export type ClosedOwners = {
  /** The closed owner of a source's notes; null when it is open or the tab can't tell. */
  source(sourceId: string): ClosedOwner | null;
};

export const NOTHING_CLOSED: ClosedOwners = { source: () => null };

/**
 * An Apply, one step whichever view is on screen: it changed live and the Work's tree alike. A
 * press sends its Un-Apply (`undo`: false when the request didn't reach the server, which the
 * writer is told; the step stays). It is on the stack from when it landed until an Un-Apply took
 * something back or nothing is left of it, and a Redo that lands puts it back on top. Its tree
 * half also ends when nothing of it stands in live any more (`endWhenTakenBack`).
 */
export type ApplyStep = {
  kind: "apply";
  /** Some text of it landed. */
  text: boolean;
  /** Its tree half, while something of it stands in live: the command and the restores it made. */
  tree: { command: string; restores: readonly string[] } | null;
  /** The sources its nodes show in; none known, every source's stack holds it. */
  sources: readonly string[];
  /** The nodes it took, where the focus goes after an Undo. */
  nodes: readonly string[];
  undo(): Promise<boolean>;
};

/** What a list's rows say: the latest gesture, whose rows offer its Undo. */
export type TreeNotice = { kind: "step"; step: TreeStep };

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
      /** What the step taken back acted on: where the focus follows it. */
      nodes: readonly string[];
    }
  | { kind: "nothing" };

const stacks = new WeakMap<TreeListSession, UndoStep[]>();
const notices = new WeakMap<TreeListSession, TreeNotice>();
const bounces = new WeakMap<TreeListSession, readonly Bounce[]>();
const listeners = new Set<() => void>();
let revision = 0;

/** Changes whenever any list's notice does. */
export const treeNoticeRevision = () => revision;

/** The list's notice; a delete's step that rests shows none until it hides something again. */
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

/** Takes `step` off the stack, if it is there: an Apply that left it. */
export function dropUndoStep(session: TreeListSession, step: UndoStep): void {
  const stack = stackOf(session);
  const at = stack.indexOf(step);
  if (at >= 0) stack.splice(at, 1);
}

export function pushUndoStep(session: TreeListSession, step: UndoStep): void {
  if (step.kind === "tree" && step.records.length === 0) return;
  stackOf(session).push(step);
  actedIn(session);
  // A gesture in the list is the writer's next action there; an Apply is made in Changes.
  if (step.kind === "tree")
    show(session, step.gesture === "create" ? null : { kind: "step", step });
}

/**
 * Something of the tree step waits for closed owners, every one of which the tab reads as closed still:
 * a press passes over it. Its place is kept, and the press after the owners reopen takes it.
 */
function waitsForClosed(step: TreeStep, closed: ClosedOwners): boolean {
  const waits = step.waits ?? [];
  return waits.length > 0 && waits.every((source) => closed.source(source) !== null);
}

/** The step is one a press in `view` on `source` (null: any) would take, waiting or not. */
const fits = (step: UndoStep, source: string | null, view: View) =>
  (step.kind === "apply" || step.draft === view.draft) &&
  (source === null || step.sources.length === 0 || step.sources.includes(source));

/**
 * Takes back the latest step of `source` (null: any) made in `view`, by opposite records, or an
 * Apply by the server's Un-Apply. A tree step that can't be taken back any more is dropped and the press
 * goes on to the one before it, as it does past an Apply whose Un-Apply is out. A step whose records or Apply wait for closed owners keeps its place, and a
 * press passes over it while they are closed (`waitsForClosed`). A record whose change was since
 * applied is in force live, so its opposite record is written live. The caller runs one press
 * at a time: while an Un-Apply is asked, steps only join the top of the stack.
 */
export async function undoLatest(
  session: TreeListSession,
  source: string | null,
  view: View,
  actor: string,
  closed: ClosedOwners,
  pendingText?: ReadonlySet<string>,
): Promise<UndoOutcome> {
  actedIn(session);
  show(session, null);
  return takeLatest(session, source, view, actor, closed, pendingText);
}

async function takeLatest(
  session: TreeListSession,
  source: string | null,
  view: View,
  actor: string,
  closed: ClosedOwners,
  pendingText?: ReadonlySet<string>,
): Promise<UndoOutcome> {
  const stack = stackOf(session);
  for (let at = stack.length - 1; at >= 0; at -= 1) {
    const step = stack[at] as UndoStep;
    if (!fits(step, source, view)) continue;
    if (step.kind === "apply") {
      return (await step.undo()) ? { kind: "undone", nodes: step.nodes } : { kind: "nothing" };
    }
    if (waitsForClosed(step, closed) || rests(session, step)) continue;
    stack.splice(at, 1);
    const back = takeBack(session, step, view, actor, closed, pendingText);
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

/**
 * A row's Undo: takes back `step` if it is still on the stack, as a press would, and says so as a
 * press does. False when a press took it first or nothing of it can be taken back any more.
 */
export async function undoStep(
  session: TreeListSession,
  step: UndoStep,
  actor: string,
  closed: ClosedOwners,
  pendingText?: ReadonlySet<string>,
): Promise<boolean> {
  if (step.kind === "apply") return step.undo();
  const stack = stackOf(session);
  const at = stack.indexOf(step);
  if (at < 0 || rests(session, step)) return false;
  stack.splice(at, 1);
  actedIn(session);
  show(session, null);
  const view = step.draft === null ? LIVE : { draft: step.draft };
  const back = takeBack(session, step, view, actor, closed, pendingText);
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

/**
 * Tells the Apply `step` once nothing of its tree half stands in `lists` (`appliedNodes`): a
 * card's Undo, or another tab's Un-Apply, took it back. Only a half seen standing ends, so a list
 * still catching up with the Apply's copies ends nothing. Returns the stop for the watch.
 */
export function endWhenTakenBack(
  lists: readonly TreeListSession[],
  step: ApplyStep,
  taken: () => void,
): () => void {
  const half = step.tree;
  if (!half) return () => undefined;
  const stands = () =>
    lists.some(
      (list) => appliedNodes(list.getSnapshot().doc, half.command, half.restores).length > 0,
    );
  let seen = stands();
  const stops = lists.map((list) =>
    list.subscribe(() => {
      if (stands()) {
        seen = true;
        return;
      }
      if (!seen) return;
      stop();
      taken();
    }),
  );
  const stop = () => {
    for (const each of stops) each();
  };
  return stop;
}

/**
 * A delete's step whose records are in force but hide nothing now: what it took shows again,
 * kept standing by an Apply or a create in its folder. A press passes over it, and its rows offer
 * no Undo, until one of them hides something again.
 */
function rests(session: TreeListSession, step: TreeStep): boolean {
  if (step.gesture !== "delete") return false;
  const view: View = step.draft === null ? LIVE : { draft: step.draft };
  const writer = writerOf(session, view);
  return (
    step.records.some((record) => deleteStands(writer, view, record)) &&
    !step.records.some((record) => deleteHides(writer, view, record))
  );
}

/**
 * Ends the delete `step` when none of its records is in force any more (lifted by anyone's
 * restore or Undo, or purged): a notice offers an Undo that no longer applies. While it stands, a
 * change in whether it rests shows on its rows, and its start ends a notice away from them
 * (`rested`). Returns the stop for the watch.
 */
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

/**
 * Writes the step's opposite records that land: `undone` when any did, else the closed sources the
 * records wait for (none: nothing of it can be taken back any more).
 */
function takeBack(
  session: TreeListSession,
  step: TreeStep,
  view: View,
  actor: string,
  closed: ClosedOwners,
  pendingText?: ReadonlySet<string>,
): "undone" | string[] {
  const writer = writerOf(session, view, pendingText);
  // One walk: each record is judged against the list the one before it left, and the records that
  // land go into the list as one update. A record into a source the tab reads as closed is not
  // written; admission drops one into a source closed since, when the update reaches the server.
  const walked = takeBackAll(
    writer,
    actor,
    [...step.records].reverse().map((id) => ({ id, view })),
    (source) => closed.source(source) !== null,
    pendingText,
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
