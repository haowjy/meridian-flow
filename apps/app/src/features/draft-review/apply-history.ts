import type { EditorHistoryHandle } from "@/core/editor/editor-history";
import { type ApplyStep, undoApply } from "@/core/project-tree/tree-undo";
import type { TreeListSession } from "@/core/tree-list/tree-list-session";

/**
 * One Apply in the history of every editor open on its documents. Ctrl+Z in any of them takes it
 * back, and the others let go of it: no second Un-Apply goes, and a later press there takes that
 * editor's own step.
 */
export function sharedHistory(
  histories: readonly (EditorHistoryHandle | null)[],
): EditorHistoryHandle | null {
  const open = [...new Set(histories.filter((history) => history !== null))];
  if (open.length < 2) return open[0] ?? null;
  return {
    captureApply(action) {
      const entries = new Map<EditorHistoryHandle, () => void>();
      const release = (kept: EditorHistoryHandle | null) => {
        for (const [history, remove] of entries) {
          if (history === kept) continue;
          remove();
          entries.delete(history);
        }
      };
      for (const history of open)
        entries.set(
          history,
          history.captureApply({
            undo: () => {
              release(history);
              action.undo();
            },
            redo: () => action.redo(),
          }),
        );
      return () => release(null);
    },
  };
}

/**
 * A card's Apply in the open editors' histories. Its Ctrl+Z is the card's Undo, the step's
 * Un-Apply, so the two take back the one command once; its Redo applies the same changes again
 * as a new command (`again`), whose step `follow` hands over.
 */
export class AppliedEntry {
  private undone: Promise<boolean> = Promise.resolve(false);
  /** The Redo on its way: a Ctrl+Z waits for the step it brings. */
  private reapplied: Promise<void> = Promise.resolve();
  /** The step this entry's own press is taking back, which keeps the entry for its Redo. */
  private pressed: ApplyStep | null = null;
  private readonly remove: () => void;

  constructor(
    session: TreeListSession,
    private step: ApplyStep,
    history: EditorHistoryHandle,
    again: (entry: AppliedEntry) => Promise<void>,
  ) {
    this.remove = history.captureApply({
      undo: () => {
        this.undone = this.reapplied.then(() => {
          this.pressed = this.step;
          return undoApply(session, this.step);
        });
      },
      redo: () => {
        this.reapplied = this.undone.then((back) => (back ? again(this) : undefined));
      },
    });
  }

  /** The step's Un-Apply starts: one sent from elsewhere (the card, the sidebar) ends the entry. */
  leaving(step: ApplyStep): void {
    if (this.pressed !== step) this.retire();
  }

  /** The Un-Apply's answer: anything but `unapplied` leaves nothing for a Redo to bring back. */
  answered(step: ApplyStep, answer: string): void {
    if (this.pressed === step) this.pressed = null;
    if (answer !== "unapplied") this.retire();
  }

  follow(step: ApplyStep): void {
    this.step = step;
  }

  retire(): void {
    this.remove();
  }
}
