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
  type Held,
  type TreeFact,
  type Unapplied,
  undoApply,
  waitsForClosed,
} from "@/core/project-tree/tree-undo";
import type { TreeListSession } from "@/core/tree-list/tree-list-session";
import type { ApplyCommandHandle } from "./apply-click-queue";
import { unappliedOf } from "./draft-notices";

/** The histories of the live sessions this tab holds for the Apply's documents, read now. */
export type LiveHistories = () => readonly (DocumentHistory | null)[];

type Answer = Unapplied | { taken: "failed" };

/**
 * How an Apply is taken back and applied again: through its review's item queue while the review
 * shows the draft, else by the server's answer alone.
 */
export type ApplyPort = {
  /** The Apply's command now: a Redo applies the same changes again as a new command. */
  commandId(): string;
  /** Sends the Un-Apply; a resend after no answer names the same one. */
  unapply(): Promise<Answer>;
  /**
   * Applies again what the last Un-Apply took back (`undone`: whether it took anything). The
   * queue takes it at once and narrows or cancels it on the answer; the server's port waits.
   * False when the Apply sent again didn't land: nothing is left to undo.
   */
  reapply(undone: Promise<boolean>): Promise<boolean>;
};

/** What a press from an editor answered, said where the writer pressed. */
export type PressSaid = { from: DocumentHistory; answer: Answer; step: AppliedCommand };

/**
 * One Apply in the history of every live session of its documents while it is in force. Ctrl+Z
 * in any of them takes it back and the others hide it: no second Un-Apply goes, and a later press
 * there takes that history's own step. Whenever it comes back into force (a Redo, an Un-Apply
 * that didn't happen or was held), every history shows it again at its place, and a live history
 * that never had it gets it.
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
          undo: () => this.apply.press(history).then(happened),
          redo: () => this.apply.redo(),
          passedOver: () => this.apply.passedOver(),
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

  /** Whether it is passed over changed: each history reads what its Undo offers again. */
  restate(): void {
    for (const entry of this.entries.values()) entry.restate();
  }

  /** Every history lets go of it, but `kept`, which holds it for its Redo. */
  keepOnly(kept: DocumentHistory | null): void {
    for (const [history, entry] of this.entries) {
      if (history === kept) continue;
      entry.remove();
      this.entries.delete(history);
    }
  }

  end(): void {
    this.ended = true;
    for (const entry of this.entries.values()) entry.remove();
    this.entries.clear();
  }
}

/**
 * An editor's press happened unless it didn't reach the server or nothing of it was taken back
 * because it waits for a closed owner: then its entry goes back to Undo at its place.
 */
const happened = (answer: Answer | null) =>
  answer !== null &&
  answer.taken !== "failed" &&
  !(answer.taken === "nothing" && answer.held.length > 0);

/**
 * One Apply, the one owner of whether it is in force, being asked back, taken back, held or ended.
 * Every Undo of it is `press`: the sidebar's Ctrl+Z, an applied row's or chat card's Undo, and
 * Ctrl+Z in an editor showing one of its documents. The sidebar's stack holds it as its step (a
 * band's Apply is on no stack until it hands over what it held), and each live history of its
 * documents shows it (`SharedApply`): they read its state, they keep none. An answer that held
 * something keeps it in force, in its place, passed over while every owner it waits for is closed.
 */
export class AppliedCommand implements ApplyStep {
  readonly kind = "apply";
  text: boolean;
  tree: { command: string; restores: readonly string[] } | null;
  sources: readonly string[];
  name: string;
  nodes: readonly string[];
  facts: ReadonlyMap<string, TreeFact>;
  held: readonly Held[] = [];
  /** An Un-Apply is out: the histories wait for its answer. */
  private asking = false;
  /** The history whose press the Un-Apply out is. */
  private from: DocumentHistory | null = null;
  /** Whether the last Un-Apply took something back, which a Redo brings again. */
  private undone: Promise<boolean> = Promise.resolve(false);
  /** The Redo on its way: a press waits for the Apply it brings. */
  private reapplied: Promise<unknown> = Promise.resolve();
  private over = false;
  private readonly shared: SharedApply;
  /** While something is held: the histories hear an owner reopen or close. */
  private stopHearing = () => {};
  /** Hears it leave the sidebar's stack: the watch on its tree half and its notice end. */
  leftStack: () => void = () => {};
  /**
   * A band's Un-Apply took the text back and held a tree fact: the sidebar's stack takes the fact
   * as a step of its own, which is where tree changes are undone. The one hand-over.
   */
  handOff: (held: readonly Held[]) => void = () => {};

  constructor(
    init: Pick<ApplyStep, "text" | "tree" | "sources" | "name" | "nodes" | "facts">,
    private port: ApplyPort,
    histories: LiveHistories,
    private readonly hooks: {
      closed: ClosedOwners;
      /** The sidebar list whose stack holds it; null for a band's. */
      stack: TreeListSession | null;
      /** A press from an editor answered: say it where the writer pressed. */
      said?(said: PressSaid): void;
      /** Nothing is left for its Undo or Redo. */
      over?(): void;
    },
  ) {
    this.text = init.text;
    this.tree = init.tree;
    this.sources = init.sources;
    this.name = init.name;
    this.nodes = init.nodes;
    this.facts = init.facts;
    this.shared = new SharedApply(histories, this);
  }

  get commandId(): string {
    return this.port.commandId();
  }

  /** In force with something held, and every owner it waits for still closed. */
  passedOver(): boolean {
    return !this.asking && waitsForClosed(this, this.hooks.closed);
  }

  /** The Apply's port from now on: a band's review let go of its room. */
  switchPort(port: ApplyPort): void {
    this.port = port;
  }

  /**
   * Takes the Apply back, from `from` (an editor's Ctrl+Z) or from no history. On the sidebar's
   * stack it goes as the stack's press (`undoApply`), so the rows say what it answered. Null: a
   * press from elsewhere took it first.
   */
  press(from: DocumentHistory | null): Promise<Answer | null> {
    return this.reapplied.then(() => {
      if (this.over || this.asking) return null;
      this.from = from;
      const { stack } = this.hooks;
      return stack ? undoApply(stack, this) : this.unapply();
    });
  }

  /** The sidebar's stack asks the server for it: see `press`. */
  async unapply(): Promise<Answer> {
    const from = this.from;
    this.from = null;
    this.asking = true;
    this.shared.hide(from);
    const answer = await this.port.unapply();
    this.asking = false;
    this.answered(answer, from);
    if (from) this.hooks.said?.({ from, answer, step: this });
    return answer;
  }

  private answered(answer: Answer, from: DocumentHistory | null): void {
    if (answer.taken === "failed") {
      this.undone = Promise.resolve(false);
      this.shared.enter();
      return;
    }
    const took = answer.taken === "all" || answer.taken === "partly";
    this.undone = Promise.resolve(took);
    this.holding(answer.held);
    if (this.held.length > 0 && took && !this.hooks.stack) {
      // The text went back: what is held is the sidebar's from now on.
      this.handOff(this.held);
      this.holding([]);
    }
    if (this.held.length > 0) this.shared.enter();
    else if (took && from) this.shared.keepOnly(from);
    else this.end();
  }

  /** What it waits for: while it waits, an owner reopening shows it in Undo again. */
  private holding(held: readonly Held[]): void {
    this.held = held;
    this.stopHearing();
    this.stopHearing = held.length
      ? this.hooks.closed.subscribe(() => this.shared.restate())
      : () => {};
  }

  /** The Redo of the press that took it back: the same changes applied again as a new command. */
  redo(): void {
    this.reapplied = this.port.reapply(this.undone).then((landed) => {
      if (!landed) this.end();
    });
  }

  /**
   * Back in force as a new command (a Redo landed): every history shows it again, and the stack
   * holds it once more.
   */
  reentered(
    init: Pick<ApplyStep, "text" | "tree" | "sources" | "name" | "nodes" | "facts">,
    port: ApplyPort,
  ): void {
    Object.assign(this, init);
    this.port = port;
    this.holding([]);
    this.undone = Promise.resolve(false);
    this.shared.enter();
  }

  /**
   * It left the sidebar's stack: its Un-Apply was answered, or a watch saw it taken back elsewhere
   * (a card's Undo of its rename), which leaves nothing for an editor's Undo either.
   */
  ended = (): void => {
    this.leftStack();
    if (this.asking || this.held.length > 0) return;
    void this.undone.then((back) => {
      if (!back) this.end();
    });
  };

  /** Nothing is left for its Undo or Redo: every history lets it go. */
  end(): void {
    if (this.over) return;
    this.over = true;
    this.holding([]);
    this.shared.end();
    this.hooks.over?.();
  }
}

const SPENT: Unapplied = { taken: "already", treeLeft: [], held: [] };

/**
 * A band's Apply through its item queue while the review shows the draft's room, so the review
 * shows its Un-Apply and Redo at once. A refused Un-Apply leaves nothing to take back; one the
 * queue never sent the Apply for took it all.
 */
export function queuePort(handle: ApplyCommandHandle): ApplyPort {
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
    reapply: () => {
      handle.redo();
      return Promise.resolve(true);
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
    reapply: async (undone) => {
      if (!(await undone)) return true;
      const body = { ...again, commandId: crypto.randomUUID() };
      applyCommandId = body.commandId;
      try {
        return (await port.send(body)).status === "applied";
      } catch {
        // Lost on the way: the next Un-Apply asks the server, which answers for one never applied.
        return true;
      }
    },
  };
}
