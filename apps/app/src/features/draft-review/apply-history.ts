import type {
  ApplyClick,
  ApplyClickAnswer,
  UnapplyClick,
  UnapplyClickAnswer,
} from "@meridian/contracts/branches";
import type {
  DocumentApplyEntry,
  DocumentHistory,
  EditorHistoryHandle,
} from "@/core/editor/editor-history";
import { type ApplyStep, undoApply } from "@/core/project-tree/tree-undo";
import type { TreeListSession } from "@/core/tree-list/tree-list-session";
import type { ApplyCommandHandle } from "./apply-click-queue";

type ApplyAction = Parameters<EditorHistoryHandle["captureApply"]>[0];
/** The histories of the live sessions this tab holds for the Apply's documents, read now. */
export type LiveHistories = () => readonly (DocumentHistory | null)[];

/**
 * One Apply in the history of every live session of its documents while it is in force. Ctrl+Z
 * in any of them takes it back and the others hide it: no second Un-Apply goes, and a later press
 * there takes that history's own step. Whenever it comes back into force (a Redo, an Un-Apply
 * that didn't happen), every history shows it again at its place, and a live history that never
 * had it gets it.
 */
class SharedApply {
  private readonly held = new Map<DocumentHistory, DocumentApplyEntry>();
  private ended = false;

  constructor(
    private readonly histories: LiveHistories,
    private readonly action: ApplyAction,
  ) {
    this.enter();
  }

  enter(): void {
    if (this.ended) return;
    for (const history of this.prune()) {
      const held = this.held.get(history);
      if (held) {
        held.show();
        continue;
      }
      this.held.set(
        history,
        history.captureApply({
          undo: () => {
            this.release(history);
            return this.action.undo().then((happened) => {
              if (!happened) this.enter();
              return happened;
            });
          },
          redo: () => {
            this.action.redo();
            this.enter();
          },
        }),
      );
    }
  }

  /** Lets go of the histories whose sessions are gone, and returns the live ones. */
  prune(): Set<DocumentHistory> {
    const live = new Set(this.histories().filter((history) => history !== null));
    for (const [history, entry] of this.held) {
      if (live.has(history)) continue;
      entry.remove();
      this.held.delete(history);
    }
    return live;
  }

  release(kept: DocumentHistory | null = null): void {
    for (const [history, entry] of this.held) if (history !== kept) entry.hide();
  }

  end(): void {
    this.ended = true;
    for (const entry of this.held.values()) entry.remove();
    this.held.clear();
  }
}

type BandPort = {
  send(body: ApplyClick): Promise<ApplyClickAnswer>;
  unapply(body: UnapplyClick): Promise<UnapplyClickAnswer>;
};

/**
 * A band's Apply in its review's history and the live ones. While the review's room shows its
 * draft, Ctrl+Z and Redo are the item queue's, which the review shows at once. Once the review
 * lets go of the room (`release`), they settle from the server's answer alone. Either way, as a
 * card's: an Un-Apply refused, or one that reversed nothing, ends the entry; one whose answer was
 * lost puts it back; a Redo sends the Apply again as a new command.
 */
export class BandApply {
  private action: ApplyAction;
  /** The queue's handle until `release`, which lets go of it and the click it froze. */
  private queued: ApplyCommandHandle | null;
  private readonly shared: SharedApply;

  constructor(
    readonly draftId: string,
    histories: LiveHistories,
    handle: ApplyCommandHandle,
    private readonly ended: () => void,
  ) {
    this.action = handle;
    this.queued = handle;
    this.shared = new SharedApply(histories, {
      // The queue retries a lost answer itself: its `false` is a refusal.
      undo: () =>
        this.action.undo().then((happened) => {
          if (!happened && this.action === handle) this.end();
          return happened;
        }),
      redo: () => this.action.redo(),
    });
  }

  /** The review let go of the draft's room, and the queue has nothing outstanding for it. */
  release(port: BandPort): void {
    if (!this.queued) return;
    let { applyCommandId, again } = this.queued.replay();
    this.queued = null;
    this.shared.prune();
    // A press after a lost answer resends the same Un-Apply: the server answers it once.
    let unapplyId: string | null = null;
    // An entry on the redo side here was taken back by the queue: its Un-Apply landed.
    let undone: Promise<boolean> = Promise.resolve(true);
    let reapplied: Promise<void> = Promise.resolve();
    const unapply = async (): Promise<"unapplied" | "ended" | "failed"> => {
      unapplyId ??= crypto.randomUUID();
      let answer: UnapplyClickAnswer;
      try {
        answer = await port.unapply({ commandId: unapplyId, applyCommandId });
      } catch {
        return "failed";
      }
      unapplyId = null;
      if (answer.status === "unapplied" && answer.reversedGroupIds.length) {
        again = { ...again, groupIds: answer.reversedGroupIds };
        return "unapplied";
      }
      this.end();
      return "ended";
    };
    this.action = {
      undo: () => {
        const said = reapplied.then(unapply);
        undone = said.then((answer) => answer === "unapplied");
        return said.then((answer) => answer !== "failed");
      },
      redo: () => {
        reapplied = undone.then(async (back) => {
          if (!back) return;
          const body = { ...again, commandId: crypto.randomUUID() };
          applyCommandId = body.commandId;
          let answer: ApplyClickAnswer;
          try {
            answer = await port.send(body);
          } catch {
            // Lost on the way: the next Un-Apply asks the server, which refuses one never applied.
            return;
          }
          if (answer.status !== "applied") this.end();
        });
      },
    };
  }

  end(): void {
    this.shared.end();
    this.ended();
  }
}

/**
 * A card's Apply in the live histories of its documents. Its Ctrl+Z is the card's Undo, the
 * step's Un-Apply, so the two take back the one command once; its Redo applies the same changes
 * again as a new command (`again`), whose step `follow` hands over.
 */
export class AppliedEntry {
  private undone: Promise<boolean> = Promise.resolve(false);
  /** The Redo on its way: a Ctrl+Z waits for the step it brings. */
  private reapplied: Promise<void> = Promise.resolve();
  /** The step this entry's own press is taking back, which keeps the entry for its Redo. */
  private pressed: ApplyStep | null = null;
  private readonly shared: SharedApply;

  constructor(
    session: TreeListSession,
    private step: ApplyStep,
    histories: LiveHistories,
    again: (entry: AppliedEntry) => Promise<void>,
  ) {
    this.shared = new SharedApply(histories, {
      undo: () => {
        const said = this.reapplied.then(() => {
          this.pressed = this.step;
          return undoApply(session, this.step);
        });
        this.undone = said.then((answer) => answer === "unapplied");
        return said.then((answer) => answer !== "failed");
      },
      redo: () => {
        this.reapplied = this.undone.then((back) => (back ? again(this) : undefined));
      },
    });
  }

  /**
   * The step's Un-Apply starts: while one sent from elsewhere (the card, the sidebar) is out, every
   * history hides the entry.
   */
  leaving(step: ApplyStep): void {
    if (this.pressed !== step) this.shared.release();
  }

  /**
   * The Un-Apply's answer. `failed` leaves the Apply in force, so it is back in every history; any
   * other answer from elsewhere, or a refusal, leaves nothing for a Redo to bring back.
   */
  answered(step: ApplyStep, answer: "unapplied" | "skipped" | "failed"): void {
    const own = this.pressed === step;
    if (own) this.pressed = null;
    if (answer === "failed") this.shared.enter();
    else if (answer === "skipped" || !own) this.retire();
  }

  follow(step: ApplyStep): void {
    this.step = step;
    this.shared.enter();
  }

  retire(): void {
    this.shared.end();
  }
}
