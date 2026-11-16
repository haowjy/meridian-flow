import type {
  DocumentApplyEntry,
  DocumentHistory,
  EditorHistoryHandle,
} from "@/core/editor/editor-history";
import { type ApplyStep, undoApply } from "@/core/project-tree/tree-undo";
import type { TreeListSession } from "@/core/tree-list/tree-list-session";

type ApplyAction = Parameters<EditorHistoryHandle["captureApply"]>[0];
/** The histories of the live sessions this tab holds for the Apply's documents, read now. */
type LiveHistories = () => readonly (DocumentHistory | null)[];

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
    const live = new Set(this.histories().filter((history) => history !== null));
    for (const [history, entry] of this.held) {
      if (live.has(history)) continue;
      entry.remove();
      this.held.delete(history);
    }
    for (const history of live) {
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

  release(kept: DocumentHistory | null = null): void {
    for (const [history, entry] of this.held) if (history !== kept) entry.hide();
  }

  end(): void {
    this.ended = true;
    for (const entry of this.held.values()) entry.remove();
    this.held.clear();
  }
}

/** A band's Apply, its queue's Un-Apply and Redo, in every live history of its document. */
export function sharedHistory(histories: LiveHistories): EditorHistoryHandle {
  return {
    captureApply(action) {
      const shared = new SharedApply(histories, action);
      return { remove: () => shared.end() };
    },
  };
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
