/**
 * Sidebar Undo: the writer's tree changes made in this browser, newest last, one stack per list
 * copy, read a source at a time. A step is the record ids one gesture appended and the view it
 * was made in, or an Apply, which the server takes back whole by its command id; nothing else is
 * stored. Whether a tree step can still be taken is read from the list at the press (`takeBackAll`:
 * by the changes in force), and one that no longer fits is skipped for the one before it. An Apply
 * is asked of the server, and its press is spent once the server answers, whatever it took back. A
 * step that waits for a closed owner (an archived or deleted Work, a chat in Trash) keeps its place,
 * and a press passes over it until the owner reopens (`waitsForClosed`). So does a delete that hides
 * nothing now (`rests`: what it took shows again, kept standing by an Apply or a create), until it
 * hides something again. A notice's Undo
 * (`undoStep`) takes back the same step a press would. There is no Redo: an Undo's own records go
 * on no stack.
 *
 * Each list also holds the notice its rows show (`treeNotice`): the writer's latest gesture with
 * its Undo, or what a press skipped or couldn't take back. It ends at the next gesture or press,
 * or when its step leaves the stack. Beside it, the writer's changes the server bounced since
 * (`treeBounces`: their Work was closed), each said on the row it was made on; they end at the
 * writer's next gesture, press or action elsewhere in the list, as the notice does.
 */
import type { ClosedOwnerWhy, LeftOutWhy } from "@meridian/contracts/commands";
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
 * Which owners this tab reads as closed now, from the Works and chats it holds. A step something
 * of which is held waits for them: a press passes over it while they are all closed. A held
 * answer is evidence the step keeps until a read of the owner that started after it lands
 * (`readAt`); from then on the tab's read decides, and an owner it can't tell about (its list
 * dropped from the cache) reads open, so a stale read costs one answered press. A press that
 * passes over the step reads again an owner with no read landed since (`reread`).
 */
export type ClosedOwners = {
  /** The closed owner of a source's notes; null when it is open or the tab can't tell. */
  source(sourceId: string): ClosedOwner | null;
  /** Whether the owner a key names (`work:<id>`, `lineage:<root>`) is closed. */
  owner(ownerKey: string): boolean;
  /**
   * When the latest read of the owner's state that landed started, or this tab's own change to
   * it (ms since epoch); 0 when none has. Kept for the tab's life, whatever the cache drops.
   */
  readAt(ownerKey: string): number;
  /** The server said these owners are closed: read them again. */
  refresh(ownerKeys: readonly string[]): void;
  /** Hears what the tab knows of its owners change (one reopened, one closed). */
  subscribe(listener: () => void): () => void;
};

export const NOTHING_CLOSED: ClosedOwners = {
  source: () => null,
  owner: () => false,
  readAt: () => Number.POSITIVE_INFINITY,
  refresh: () => {},
  subscribe: () => () => {},
};

/**
 * Part of an Apply an Un-Apply left applied, because taking it back would change a closed owner's
 * notes: its tree fact (`tree`), its text groups, or both. `ownerKey` is the owner it waits for.
 */
export type Held = ClosedOwner & {
  node: string;
  tree: boolean;
  groupIds: readonly string[];
  ownerKey: string;
};

/**
 * What an Un-Apply took back of its Apply: `all` of what stood, `partly`, `nothing`, or `already`
 * (an earlier Un-Apply, here or in another tab, took it all). `leftOut` names each node whose
 * change stayed for good, with why, and whether its tree fact stayed (`tree`) or only its text;
 * `held`, what stayed for a closed owner and comes back to Undo once it reopens.
 */
export type Unapplied = {
  taken: "all" | "partly" | "nothing" | "already";
  leftOut: readonly { node: string; why: LeftOutWhy; tree: boolean }[];
  held: readonly Held[];
};

/**
 * What an Apply's tree half did to a node, for what an Un-Apply that left it says, and the node's
 * name where that is said apart from its row.
 */
export type TreeFact = {
  did: "moved" | "renamed" | "restored" | "deleted" | "created" | null;
  folder: boolean;
  name?: string;
};

/** What an Un-Apply left standing, said on the rows of the Apply it took back. */
export type Left = Unapplied & {
  name: string;
  nodes: readonly string[];
  facts: ReadonlyMap<string, TreeFact>;
};

/**
 * An Apply, one step whichever view is on screen: it changed live and the Work's tree alike.
 * `ask` asks the server, and `failed` is a press that didn't reach it. It has two halves: its
 * text ends only by an Un-Apply (a press answers it, this tab's or, as `already`, another's); its
 * tree half ends when nothing of it stands in live any more (`endWhenTakenBack`). Its own state
 * puts it on the stack and takes it off: in force, or while an Un-Apply of it is out, it is
 * there, and what an Un-Apply `held` keeps it in its place.
 */
export type ApplyStep = {
  kind: "apply";
  /** Some text of it landed. */
  text: boolean;
  /** Its tree half, while something of it stands in live: the command and the restores it made. */
  tree: { command: string; restores: readonly string[] } | null;
  /** The sources its nodes show in; none known, every source's stack holds it. */
  sources: readonly string[];
  /** What it applied, for the notice: "Ch 3 and Outline", "4 changes". */
  name: string;
  /** The nodes it took, whose rows say what an Undo of it couldn't do. */
  nodes: readonly string[];
  /** What its tree half did to each node it landed on. */
  facts: ReadonlyMap<string, TreeFact>;
  /** What its last Un-Apply left for closed owners, while it waits in force. */
  readonly held: readonly Held[];
  /** Something is held and every owner it waits for is closed: a press passes over it. */
  waits(): boolean;
  /** A press passed over it: reads again each owner it waits for that the tab hasn't read since. */
  reread(): void;
  /** Its changes stand: false while an Un-Apply or Redo of it is out. */
  inForce(): boolean;
  /** A row's Undo: `ask`, with the answer said on its rows (`sayUnapplied`). */
  press(from: null): Promise<Unapplied | { taken: "failed" }>;
  /** Every Undo of it: its own state decides whether it asks the server. */
  ask(): Promise<Unapplied | { taken: "failed" }>;
  /** Nothing of its tree half stands any more: taken back elsewhere. */
  treeTaken(): void;
};

/** A tree step a press passed over: something changed it again since. */
export type Skipped = { name: string; nodes: readonly string[] };

/**
 * What a list's rows say: the latest gesture, whose rows offer its Undo, or what the latest press
 * has to say about the steps it couldn't take back, each on that step's rows.
 */
export type TreeNotice = { kind: "step"; step: TreeStep } | { kind: "said"; said: readonly Said[] };

export type Said =
  | ({ kind: "skipped" } & Skipped)
  /** An Apply's Un-Apply that left some of it, or all of it, standing. */
  | ({ kind: "left" } & Left)
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
  /** `left`: what an Apply's Un-Apply left standing. */
  | {
      kind: "undone";
      skipped: readonly Skipped[];
      /** What the step taken back acted on: where the focus follows it. */
      nodes: readonly string[];
      left?: Left;
    }
  | { kind: "nothing"; skipped: readonly Skipped[]; left?: Left }
  /** An Apply's Un-Apply didn't reach the server: the step stays on the stack. */
  | { kind: "failed"; skipped: readonly Skipped[]; name: string; step: ApplyStep };

function saidOf(outcome: UndoOutcome): TreeNotice | null {
  const said: Said[] = [
    ...outcome.skipped.map((each) => ({ kind: "skipped" as const, ...each })),
    ...(outcome.kind !== "failed" && outcome.left
      ? [{ kind: "left" as const, ...outcome.left }]
      : []),
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

/**
 * Shows `notice`, which says who each of `waiting` waits for, and ends it once one of them would
 * be taken by a press again: "Unarchive it to undo this" is stale after the unarchive, and never
 * shows when the owner reopened while the press was out.
 */
function showWaiting(
  session: TreeListSession,
  notice: TreeNotice | null,
  closed: ClosedOwners,
  waiting: readonly UndoStep[],
) {
  const stale = () =>
    notices.get(session) !== notice || !waiting.every((step) => waitsForClosed(step, closed));
  show(session, notice);
  if (!notice || waiting.length === 0) return;
  if (stale()) {
    if (notices.get(session) === notice) show(session, null);
    return;
  }
  const stop = closed.subscribe(() => {
    if (!stale()) return;
    stop();
    if (notices.get(session) === notice) show(session, null);
  });
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
 * Something of the step waits for closed owners, every one of which the tab reads as closed still:
 * a press passes over it. Its place is kept, and the press after the owners reopen takes it.
 */
export function waitsForClosed(step: UndoStep, closed: ClosedOwners): boolean {
  if (step.kind === "apply") return step.waits();
  const waits = step.waits ?? [];
  return waits.length > 0 && waits.every((source) => closed.source(source) !== null);
}

/** What each step waits for that a press already said it passed over. */
const toldWaiting = new WeakSet<readonly unknown[]>();

/**
 * True the first time a press passes over the step while it waits for what it waits for now: the
 * writer is told once why an older change went instead, and never again for the same wait.
 */
export function firstPassOver(step: UndoStep): boolean {
  const waits = step.kind === "apply" ? step.held : step.waits;
  if (!waits || toldWaiting.has(waits)) return false;
  toldWaiting.add(waits);
  return true;
}

/** What a step a press passed over waits for, said once on its rows (`firstPassOver`). */
function passedOverLeft(step: UndoStep, closed: ClosedOwners): Left | null {
  if (!firstPassOver(step)) return null;
  return step.kind === "apply"
    ? {
        taken: "nothing",
        leftOut: [],
        held: step.held,
        name: step.name,
        nodes: step.nodes,
        facts: step.facts,
      }
    : treeHeld(step, step.waits ?? [], closed);
}

/** The step is one a press in `view` on `source` (null: any) would take, waiting or not. */
const fits = (step: UndoStep, source: string | null, view: View) =>
  (step.kind === "apply" || step.draft === view.draft) &&
  (source === null || step.sources.length === 0 || step.sources.includes(source));

/**
 * Takes back the latest step of `source` (null: any) made in `view`, by opposite records, or an
 * Apply by the server's Un-Apply. A tree step that can't be taken back any more is dropped, named
 * in `skipped`, and the press goes on to the one before it, as it does past an Apply whose
 * Un-Apply is out. A step whose records or Apply wait for closed owners keeps its place, and a
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
  const passed: Left[] = [];
  const waiting: UndoStep[] = [];
  const outcome = await takeLatest(
    session,
    source,
    view,
    actor,
    closed,
    { passed, waiting },
    pendingText,
  );
  const said = saidOf(outcome);
  // A step passed over for the first time says, on its rows, who it waits for.
  const told = passed.map((left) => ({ kind: "left" as const, ...left }));
  showWaiting(
    session,
    told.length
      ? { kind: "said", said: [...told, ...(said?.kind === "said" ? said.said : [])] }
      : said,
    closed,
    waiting,
  );
  return outcome;
}

async function takeLatest(
  session: TreeListSession,
  source: string | null,
  view: View,
  actor: string,
  closed: ClosedOwners,
  /** `passed`: what the steps passed over for the first time say; `waiting`: each step said to wait. */
  { passed, waiting }: { passed: Left[]; waiting: UndoStep[] },
  pendingText?: ReadonlySet<string>,
): Promise<UndoOutcome> {
  const stack = stackOf(session);
  const skipped: Skipped[] = [];
  for (let at = stack.length - 1; at >= 0; at -= 1) {
    const step = stack[at] as UndoStep;
    if (!fits(step, source, view)) continue;
    if (waitsForClosed(step, closed)) {
      if (step.kind === "apply") step.reread();
      const left = passedOverLeft(step, closed);
      if (left) {
        passed.push(left);
        waiting.push(step);
      }
      continue;
    }
    if (step.kind === "tree" && rests(session, step)) continue;
    if (step.kind === "apply") {
      if (!step.inForce()) continue;
      const answer = await step.ask();
      if (answer.taken !== "failed" && answer.held.length > 0) waiting.push(step);
      return unappliedOutcome(step, answer, skipped);
    }
    stack.splice(at, 1);
    const names = step.nodes.flatMap(
      (node) => session.replay(view, pendingText).nodes.get(node)?.name ?? [],
    );
    const back = takeBack(session, step, view, actor, closed, pendingText);
    if (back === "undone") {
      step.ended?.();
      return { kind: "undone", skipped, nodes: step.nodes };
    }
    if (back.length > 0) {
      step.waits = back;
      stack.splice(at, 0, step);
      waiting.push(step);
      return { kind: "nothing", skipped, left: treeHeld(step, back, closed) };
    }
    step.ended?.();
    skipped.push({ name: names[0] ?? "", nodes: step.nodes });
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
  closed: ClosedOwners,
  pendingText?: ReadonlySet<string>,
): Promise<boolean> {
  if (step.kind === "apply") return (await step.press(null)).taken !== "failed";
  const stack = stackOf(session);
  const at = stack.indexOf(step);
  if (at < 0 || rests(session, step)) return false;
  stack.splice(at, 1);
  actedIn(session);
  show(session, null);
  const view = step.draft === null ? LIVE : { draft: step.draft };
  const name = step.nodes.flatMap((node) => step.was.get(node)?.name ?? []).at(0) ?? "";
  const back = takeBack(session, step, view, actor, closed, pendingText);
  if (back === "undone") {
    step.ended?.();
    show(session, null);
    return true;
  }
  if (back.length > 0) {
    step.waits = back;
    stack.splice(Math.min(at, stack.length), 0, step);
    showWaiting(
      session,
      saidOf({ kind: "nothing", skipped: [], left: treeHeld(step, back, closed) }),
      closed,
      [step],
    );
    return false;
  }
  step.ended?.();
  show(session, saidOf({ kind: "nothing", skipped: [{ name, nodes: step.nodes }] }));
  return false;
}

/**
 * Says on `step`'s rows what its Un-Apply answered, as a press says it: an applied row's Undo, an
 * editor's Ctrl+Z, a chat card's Undo.
 */
export async function sayUnapplied(
  session: TreeListSession,
  step: ApplyStep,
  answer: Promise<Unapplied | { taken: "failed" }>,
  closed: ClosedOwners,
): Promise<void> {
  show(session, null);
  const said = await answer;
  const held = said.taken !== "failed" && said.held.length > 0;
  showWaiting(session, saidOf(unappliedOutcome(step, said, [])), closed, held ? [step] : []);
}

/** What an Un-Apply's answer says on the rows; one that didn't reach the server leaves the step. */
function unappliedOutcome(
  step: ApplyStep,
  answer: Unapplied | { taken: "failed" },
  skipped: readonly Skipped[],
): UndoOutcome {
  if (answer.taken === "failed") return { kind: "failed", skipped, name: step.name, step };
  const left: Left | undefined =
    answer.taken === "partly" || answer.taken === "nothing"
      ? { ...answer, name: step.name, nodes: step.nodes, facts: step.facts }
      : undefined;
  return answer.taken === "nothing"
    ? { kind: "nothing", skipped, left }
    : { kind: "undone", skipped, nodes: step.nodes, ...(left ? { left } : {}) };
}

/** What a tree gesture did to a node, in the words a row says it with. */
export const GESTURE_DID: Record<TreeGesture, TreeFact["did"]> = {
  create: "created",
  rename: "renamed",
  move: "moved",
  delete: "deleted",
  restore: "restored",
};

/** What a tree step whose records all wait for closed sources says on its rows. */
function treeHeld(step: TreeStep, sources: readonly string[], closed: ClosedOwners): Left {
  const owner = sources.flatMap((source) => closed.source(source) ?? [])[0] ?? {
    why: "work_archived" as const,
  };
  const facts = new Map(
    step.nodes.map((node) => [
      node,
      { did: GESTURE_DID[step.gesture], folder: step.was.get(node)?.kind === "folder" },
    ]),
  );
  return {
    taken: "nothing",
    leftOut: [],
    held: step.nodes.map((node) => ({ node, tree: true, groupIds: [], ownerKey: "", ...owner })),
    name: step.was.get(step.nodes[0] ?? "")?.name ?? "",
    nodes: step.nodes,
    facts,
  };
}

/**
 * Tells the Apply `step` once nothing of its tree half stands in `lists` (`appliedNodes`): a
 * card's Undo, or another tab's Un-Apply, took it back. Only a half seen standing ends, so a list
 * still catching up with the Apply's copies ends nothing. Returns the stop for the watch.
 */
export function endWhenTakenBack(lists: readonly TreeListSession[], step: ApplyStep): () => void {
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
      step.treeTaken();
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
