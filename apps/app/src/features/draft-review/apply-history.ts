import type {
  ApplyClick,
  ApplyClickAnswer,
  UnapplyClick,
  UnapplyClickAnswer,
} from "@meridian/contracts/branches";
import type { DocumentApplyEntry, DocumentHistory } from "@/core/editor/editor-history";
import {
  type ApplyStep,
  type ClosedOwners,
  firstPassOver,
  type Held,
  type Unapplied,
  undoApply,
} from "@/core/project-tree/tree-undo";
import type { TreeListSession } from "@/core/tree-list/tree-list-session";
import type { ApplyClickOutcome, ApplyCommandHandle } from "./apply-click-queue";
import { itemOf, unappliedOf } from "./draft-notices";

/** The histories of the live sessions this tab holds for the Apply's documents, read now. */
export type LiveHistories = () => readonly (DocumentHistory | null)[];

export type Answer = Unapplied | { taken: "failed" };

/** What an Apply is, as its rows and notices name it, and its two halves. */
export type ApplyInit = Pick<ApplyStep, "text" | "tree" | "sources" | "name" | "nodes" | "facts">;

/**
 * What a Redo became: a new Apply command in force (`init`: what it landed, when that changed),
 * `cancelled` because the Un-Apply it follows didn't leave the Apply taken back, or `lost`: nothing
 * of it landed, so nothing is left to undo.
 */
export type Reapplied =
  | { kind: "landed"; init?: ApplyInit }
  | { kind: "cancelled" }
  | { kind: "lost" };

/**
 * How an Apply is taken back and applied again: through its review's item queue while the review
 * shows the draft, else by the server's answer alone. A port carries requests and their data; the
 * Apply's state (`AppliedCommand`) decides what each answer does.
 */
export type ApplyPort = {
  /** The Apply's command in force: a Redo that lands replaces it with a new one. */
  commandId(): string;
  /** Sends the Un-Apply; a resend after no answer names the same one. */
  unapply(): Promise<Answer>;
  /**
   * Applies again what the Un-Apply whose answer is `answer` took back, once it is `takenBack`.
   * The queue takes it at once and narrows or cancels it on the answer; the server's ports wait.
   */
  reapply(answer: Promise<Answer>): Promise<Reapplied>;
};

/**
 * One Apply's state, the one every surface reads:
 * - `in_force`: its Undo would ask the server; `failed` too, after a press that didn't reach it;
 * - `held`: in force, with parts a closed owner keeps (`parts`), asked at `askedAt`;
 * - `unapplying`: Un-Apply attempt `attempt` is out, pressed in `from` (null: no editor);
 * - `taken`: taken back, with its Redo in the editor that pressed;
 * - `reapplying`: Redo attempt `attempt` is out, chained on Un-Apply attempt `after` (-1: none);
 * - `ended`: nothing is left for its Undo or Redo.
 */
export type ApplyState =
  | { kind: "in_force" }
  | { kind: "failed" }
  | { kind: "held"; parts: readonly Held[]; askedAt: number }
  | {
      kind: "unapplying";
      attempt: number;
      from: DocumentHistory | null;
      answer: Promise<Answer>;
      askedAt: number;
    }
  | { kind: "taken"; from: DocumentHistory; answer: Unapplied }
  | { kind: "reapplying"; attempt: number; after: number; done: Promise<void> }
  | { kind: "ended" };

/** What a press from an editor answered, said where the writer pressed. */
export type PressSaid = { from: DocumentHistory; answer: Answer; step: AppliedCommand };

/** The answer leaves the Apply taken back: something went, and nothing stayed for a closed owner. */
export const takenBack = (answer: Answer): boolean =>
  (answer.taken === "all" || answer.taken === "partly") && answer.held.length === 0;

const SPENT: Unapplied = { taken: "already", treeLeft: [], held: [] };
const CANCELLED: Reapplied = { kind: "cancelled" };
const LOST: Reapplied = { kind: "lost" };
const noop = () => {};

/**
 * One Apply in the history of every live session of its documents. A press hides it in every
 * history but the one pressed in; while it is in force each shows it at its place, and a live
 * history that never had it gets it. The entries read the Apply's state and keep none.
 */
class SharedApply {
  private readonly entries = new Map<DocumentHistory, DocumentApplyEntry>();
  private ended = false;

  constructor(
    private readonly histories: LiveHistories,
    private readonly apply: AppliedCommand,
  ) {
    this.enter();
  }

  enter(): void {
    if (this.ended) return;
    for (const history of this.prune()) {
      const entry = this.entries.get(history);
      if (entry) {
        entry.show();
        continue;
      }
      this.entries.set(
        history,
        history.captureApply({
          undo: () => this.apply.press(history).then(() => !this.apply.inForce()),
          redo: () => this.apply.redo(),
          passedOver: () => this.apply.waits(),
          passed: () => this.apply.passedBy(history),
        }),
      );
    }
  }

  /** Lets go of the histories whose sessions are gone, and returns the live ones. */
  private prune(): Set<DocumentHistory> {
    const live = new Set(this.histories().filter((history) => history !== null));
    for (const [history, entry] of this.entries) {
      if (live.has(history)) continue;
      entry.remove();
      this.entries.delete(history);
    }
    return live;
  }

  /** Hides it in every history but `kept`, whose own press moved it to its Redo. */
  hide(kept: DocumentHistory | null): void {
    for (const [history, entry] of this.entries) if (history !== kept) entry.hide();
  }

  /** Its state changed: each history reads what its Undo offers again. */
  restate(): void {
    for (const entry of this.entries.values()) entry.restate();
  }

  end(): void {
    this.ended = true;
    for (const entry of this.entries.values()) entry.remove();
    this.entries.clear();
  }
}

/**
 * One Apply and the one state machine of its Undo (`ApplyState`). Every Undo of it is `press`: the
 * sidebar's Ctrl+Z, an applied row's or a chat card's Undo, and Ctrl+Z in an editor showing one of
 * its documents; every Redo is `redo`. The sidebar's stack holds it as its step while it is in
 * force, each live history of its documents shows it (`SharedApply`), and the rows, the cards and
 * the band's line read `state` and `waits` and keep no copy.
 */
export class AppliedCommand implements ApplyStep {
  readonly kind = "apply";
  text: boolean;
  tree: { command: string; restores: readonly string[] } | null;
  sources: readonly string[];
  name: string;
  nodes: readonly string[];
  facts: ApplyStep["facts"];
  /** Changes with every transition, and with what the tab knows of a held Apply's owners. */
  revision = 0;
  private current: ApplyState = { kind: "in_force" };
  private attempts = 0;
  /** The history whose press `unapply` is about to send. */
  private pressedIn: DocumentHistory | null = null;
  private readonly listeners = new Set<() => void>();
  /** While held: hears the tab's view of its owners change. */
  private stopHearing = noop;
  private readonly shared: SharedApply;
  /** The sidebar list whose stack holds it; null for a band's until it holds a tree change. */
  private stack: TreeListSession | null;
  /** Hears it leave the sidebar's stack: the watch on its tree half and its notice end. */
  leftStack: () => void = noop;
  /** A band's Apply came to hold a tree change: the sidebar's stack, where tree changes are undone, takes it. */
  joinStack: () => void = noop;

  constructor(
    init: ApplyInit,
    private port: ApplyPort,
    histories: LiveHistories,
    private readonly hooks: {
      closed: ClosedOwners;
      stack: TreeListSession | null;
      /** A press from an editor answered: say it where the writer pressed. Returns its end. */
      said?(said: PressSaid): () => void;
      /** It ended. */
      over?(): void;
      /** A Redo landed: it is back in force, and the sidebar's stack holds it again. */
      entered?(): void;
    },
  ) {
    this.text = init.text;
    this.tree = init.tree;
    this.sources = init.sources;
    this.name = init.name;
    this.nodes = init.nodes;
    this.facts = init.facts;
    this.stack = hooks.stack;
    this.shared = new SharedApply(histories, this);
  }

  get state(): ApplyState {
    return this.current;
  }

  get commandId(): string {
    return this.port.commandId();
  }

  get held(): readonly Held[] {
    return this.current.kind === "held" ? this.current.parts : [];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Held, and every owner it waits for is closed: a press passes over it. An owner reads closed
   * when the tab reads it so, or when the tab hasn't read it since the press the server held.
   */
  waits(): boolean {
    const held = this.current;
    if (held.kind !== "held") return false;
    const { closed } = this.hooks;
    return held.parts.every(
      (part) => closed.owner(part.ownerKey) || closed.readAt(part.ownerKey) < held.askedAt,
    );
  }

  /** In force: its changes stand, whether or not a press would ask for them now. */
  inForce(): boolean {
    const { kind } = this.current;
    return kind === "in_force" || kind === "failed" || kind === "held";
  }

  /** Its Undo would act now: in force and not passed over. */
  offersUndo(): boolean {
    return this.inForce() && !this.waits();
  }

  /**
   * An editor's Ctrl+Z passed over it for an older step: the first time for what it waits for
   * now, that editor's document says who it waits for (`firstPassOver`).
   */
  passedBy(from: DocumentHistory): void {
    if (!firstPassOver(this)) return;
    this.say({ from, answer: { taken: "nothing", treeLeft: [], held: this.held }, step: this });
  }

  /** The Apply's port from now on: a band's review let go of its room. */
  switchPort(port: ApplyPort): void {
    this.port = port;
  }

  /** It holds a tree change of a band's: the sidebar's stack holds it from now on. */
  placeOn(stack: TreeListSession, init: Partial<ApplyInit>): void {
    Object.assign(this, init);
    this.stack = stack;
  }

  /**
   * Takes the Apply back, pressed in `from` (an editor's Ctrl+Z) or elsewhere. Only in force does
   * a press ask the server; a press while a Redo is out waits for it, one while an Un-Apply is
   * out hears its answer, and one on an Apply passed over answers what holds it without asking.
   */
  press(from: DocumentHistory | null): Promise<Answer> {
    const state = this.current;
    if (state.kind === "reapplying") return state.done.then(() => this.press(from));
    if (state.kind === "unapplying") return state.answer;
    if (state.kind === "taken" || state.kind === "ended") return Promise.resolve(SPENT);
    if (this.waits()) return Promise.resolve({ taken: "nothing", treeLeft: [], held: this.held });
    this.pressedIn = from;
    // On the sidebar's stack it goes as the stack's press, so the rows say what it answered.
    return this.stack ? undoApply(this.stack, this, this.hooks.closed) : this.unapply();
  }

  /** The server's Un-Apply of what is in force: one attempt, whose answer moves the state. */
  async unapply(): Promise<Answer> {
    const from = this.pressedIn;
    this.pressedIn = null;
    const attempt = ++this.attempts;
    const askedAt = Date.now();
    const answer = this.port.unapply();
    this.shared.hide(from);
    this.set({ kind: "unapplying", attempt, from, answer, askedAt });
    const said = await answer;
    this.answered(said, attempt, from, askedAt);
    if (from) this.say({ from, answer: said, step: this });
    return said;
  }

  /**
   * Un-Apply attempt `attempt` answered. A Redo pressed before the answer goes on only when the
   * answer took the Apply back; otherwise the Apply that is still in force is the one it says.
   */
  private answered(
    answer: Answer,
    attempt: number,
    from: DocumentHistory | null,
    askedAt: number,
  ): void {
    const state = this.current;
    const chained = state.kind === "reapplying" && state.after === attempt;
    if (!chained && !(state.kind === "unapplying" && state.attempt === attempt)) return;
    if (answer.taken === "failed") {
      this.set({ kind: "failed" });
      this.shared.enter();
      return;
    }
    if (answer.held.length > 0) {
      this.set({ kind: "held", parts: answer.held, askedAt });
      this.hooks.closed.refresh([...new Set(answer.held.map((part) => part.ownerKey))]);
      this.shared.enter();
      if (!this.stack && answer.held.some((part) => part.tree)) this.joinStack();
      return;
    }
    if (chained && takenBack(answer)) return;
    if (takenBack(answer) && from) this.set({ kind: "taken", from, answer });
    else this.end();
  }

  /** The Redo of the press that took it back: the same changes applied again as a new command. */
  redo(): void {
    const state = this.current;
    if (state.kind !== "unapplying" && state.kind !== "taken") return;
    const attempt = ++this.attempts;
    const answer = state.kind === "unapplying" ? state.answer : Promise.resolve(state.answer);
    const done = this.port.reapply(answer).then((result) => this.reapplied(attempt, result));
    this.set({
      kind: "reapplying",
      attempt,
      after: state.kind === "unapplying" ? state.attempt : -1,
      done,
    });
  }

  /** Back in force as a new command: every live history shows it again at its place. */
  private reapplied(attempt: number, result: Reapplied): void {
    const state = this.current;
    // Cancelled: the Un-Apply's answer already said what is in force (`answered`).
    if (state.kind !== "reapplying" || state.attempt !== attempt || result.kind === "cancelled")
      return;
    if (result.kind === "lost") {
      this.end();
      return;
    }
    if (result.init) Object.assign(this, result.init);
    this.set({ kind: "in_force" });
    this.shared.enter();
    this.hooks.entered?.();
  }

  /**
   * It left the sidebar's stack: a press answered, or a watch saw it taken back elsewhere (a
   * card's Undo of its rename). Still in force, nothing of it is left for an editor's Undo either.
   */
  ended = (): void => {
    this.leftStack();
    if (this.inForce()) this.end();
  };

  /** Nothing is left for its Undo or Redo: every history lets it go. */
  end(): void {
    if (this.current.kind === "ended") return;
    this.set({ kind: "ended" });
    this.shared.end();
    this.hooks.over?.();
  }

  private set(next: ApplyState): void {
    this.current = next;
    this.stopHearing();
    this.stopHearing =
      next.kind === "held"
        ? this.hooks.closed.subscribe(() => {
            this.shared.restate();
            this.changed();
          })
        : noop;
    this.shared.restate();
    this.changed();
  }

  private changed(): void {
    this.revision += 1;
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Says `said` where it was pressed. A line naming who it waits for lasts while the Apply waits,
   * and isn't said when an owner reopened while the press was out.
   */
  private say(said: PressSaid): void {
    const naming = said.answer.taken !== "failed" && said.answer.held.length > 0;
    if (naming && !this.waits()) return;
    const unsay = this.hooks.said?.(said);
    if (!unsay || !naming) return;
    const stop = this.subscribe(() => {
      if (this.waits()) return;
      stop();
      unsay();
    });
  }
}

/** Every Apply this tab can still take back or apply again, and each one's state as it changes. */
export class AppliedCommands {
  private readonly all = new Map<AppliedCommand, () => void>();
  private readonly listeners = new Set<() => void>();
  revision = 0;

  add(command: AppliedCommand): void {
    if (this.all.has(command)) return;
    this.all.set(command, command.subscribe(this.changed));
    this.changed();
  }

  delete(command: AppliedCommand): void {
    const stop = this.all.get(command);
    if (!stop) return;
    stop();
    this.all.delete(command);
    this.changed();
  }

  /** The Apply whose command in force is `commandId`. */
  find(commandId: string): AppliedCommand | undefined {
    for (const command of this.all.keys()) if (command.commandId === commandId) return command;
    return undefined;
  }

  values(): AppliedCommand[] {
    return [...this.all.keys()];
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private readonly changed = (): void => {
    this.revision += 1;
    for (const listener of [...this.listeners]) listener();
  };
}

/** A Redo the queue answered: landed when its item's text or tree landed. */
const replayLanded = (outcome: ApplyClickOutcome, node: string): Reapplied => {
  if (outcome.status === "landed") return { kind: "landed" };
  if (outcome.status !== "applied") return LOST;
  const item = itemOf(outcome, node);
  return item?.text?.landed || item?.tree?.landed ? { kind: "landed" } : LOST;
};

/**
 * A band's Apply through its item queue while the review shows the draft's room, so the review
 * shows its Un-Apply and Redo at once. A refused Un-Apply leaves nothing to take back; one the
 * queue never sent the Apply for took it all.
 */
export function queuePort(handle: ApplyCommandHandle, node: string): ApplyPort {
  return {
    commandId: () => handle.replay().applyCommandId,
    unapply: () =>
      handle
        .undo()
        .then((answer) =>
          answer.status === "unapplied"
            ? unappliedOf(answer)
            : answer.status === "cancelled"
              ? { ...SPENT, taken: "all" as const }
              : SPENT,
        ),
    reapply: (answer) => {
      const replay = handle.redo();
      return Promise.all([answer, replay]).then(([said, outcome]) =>
        takenBack(said) ? replayLanded(outcome, node) : CANCELLED,
      );
    },
  };
}

export type BandPort = {
  send(body: ApplyClick): Promise<ApplyClickAnswer>;
  unapply(body: UnapplyClick): Promise<UnapplyClickAnswer>;
};

/**
 * A band's Apply once its review let go of the room: the queue settles an Un-Apply only by
 * watching that room, so from here the server's answer alone settles it. `replay` is what the
 * queue last held: the Apply in force and the click a Redo sends again.
 */
export function serverBandPort(
  port: BandPort,
  replay: { applyCommandId: string; again: ApplyClick },
): ApplyPort {
  let { applyCommandId, again } = replay;
  // A press after a lost answer resends the same Un-Apply: the server answers it once.
  let unapplyId: string | null = null;
  return {
    commandId: () => applyCommandId,
    unapply: async () => {
      unapplyId ??= crypto.randomUUID();
      let answer: UnapplyClickAnswer;
      try {
        answer = await port.unapply({ commandId: unapplyId, applyCommandId });
      } catch {
        return { taken: "failed" };
      }
      unapplyId = null;
      if (answer.status !== "unapplied") return SPENT;
      if (answer.reversedGroupIds.length) again = { ...again, groupIds: answer.reversedGroupIds };
      return unappliedOf(answer);
    },
    reapply: async (answer) => {
      if (!takenBack(await answer)) return CANCELLED;
      const body = { ...again, commandId: crypto.randomUUID() };
      let landed: boolean;
      try {
        landed = (await port.send(body)).status === "applied";
      } catch {
        // Lost on the way: the next Un-Apply asks the server, which answers for one never applied.
        landed = true;
      }
      if (!landed) return LOST;
      applyCommandId = body.commandId;
      return { kind: "landed" };
    },
  };
}
