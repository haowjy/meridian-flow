import { t } from "@lingui/core/macro";
import { notifyFailure } from "@/components/app/failure-toast";
import type { DocumentApplyEntry, DocumentHistory } from "@/core/editor/editor-history";

/** The histories this tab holds for the Apply's documents, read now: each one's live session. */
type Histories = () => readonly (DocumentHistory | null)[];

/**
 * What a press of Undo came to: `failed`, it never reached the server (`told`: the writer was
 * told already, when it couldn't be saved to send); else the Undo the server answered
 * (`unapplyId`) and whether it took anything back.
 */
export type Undone =
  | { kind: "failed"; told?: true }
  | { kind: "answered"; unapplyId: string; took: boolean };

/** What a Redo landed: the new Apply's command id. */
type Redone = { commandId: string };

/**
 * The two requests every Undo and Redo of an Apply makes, by command id: take back the Apply in
 * force, and apply again what that took back.
 */
export type ApplyPort = {
  unapply(applyId: string): Promise<Undone>;
  /** Null: nothing to apply again. `failed`: it never reached the server. */
  redo(unapplyId: string): Promise<Redone | "failed" | null>;
};

/** Where an Apply's step is on the sidebar's Undo stack while it can be taken back. */
export type Seat = { push(): void; drop(): void };

/**
 * One Apply in the history of every live session of its documents, and on the sidebar's stack. It
 * holds the Apply's command id and nothing else of it: a press asks the server to Un-Apply it and
 * hides the entry everywhere but where it was pressed; one that took something back leaves that
 * editor's Redo, which asks the server to apply it again, and a Redo that lands makes the new
 * command the one in force and shows it again everywhere. Nothing is left of an Apply an Un-Apply
 * took back from elsewhere, or took nothing of.
 */
export class ApplyEntries {
  private readonly entries = new Map<DocumentHistory, DocumentApplyEntry>();
  private ended = false;
  /** The Un-Apply out now, which a second press and a Redo wait on. */
  private pending: Promise<Undone> | null = null;
  /** The Un-Apply the editor that pressed holds the Redo of, and that editor's history. */
  private unapplyId: string | null = null;
  private redoIn: DocumentHistory | null = null;

  constructor(
    private commandId: string,
    private port: ApplyPort,
    private readonly histories: Histories,
    private readonly seat: Seat | null,
    /** It ended: nothing is left of it to take back or apply again. */
    private readonly over: () => void,
  ) {
    this.enter();
    seat?.push();
  }

  get id(): string {
    return this.commandId;
  }

  /** Shows it in each live history of its documents, hidden ones included. */
  enter(): void {
    if (this.ended) return;
    const live = new Set(this.histories().filter((history) => history !== null));
    for (const [history, entry] of this.entries) {
      if (live.has(history)) continue;
      entry.remove();
      this.entries.delete(history);
    }
    for (const history of live) {
      const entry = this.entries.get(history);
      if (entry) {
        entry.show();
        continue;
      }
      this.entries.set(
        history,
        history.captureApply({
          undo: () => this.undo(history).then((undone) => undone.kind !== "failed"),
          redo: () => this.redo(),
          dropped: () => this.dropped(history),
        }),
      );
    }
  }

  /**
   * Every Undo of it: Ctrl+Z in an editor (`from`), a row's or a card's Undo, the sidebar's
   * Ctrl+Z. A press while one is out hears the same answer.
   */
  undo(from: DocumentHistory | null): Promise<Undone> {
    if (this.ended) return Promise.resolve({ kind: "answered", unapplyId: "", took: false });
    if (this.pending) return this.pending;
    for (const [history, entry] of this.entries) if (history !== from) entry.hide();
    const press = this.port.unapply(this.commandId).then((undone) => {
      this.pending = null;
      this.answered(undone, from);
      return undone;
    });
    this.pending = press;
    return press;
  }

  private answered(undone: Undone, from: DocumentHistory | null): void {
    if (undone.kind === "failed") {
      if (!undone.told)
        notifyFailure({
          key: `unapply:${this.commandId}`,
          title: t`Couldn't undo`,
          brief: true,
        });
      this.enter();
      return;
    }
    // Taken back in an editor, its Redo is left there; anywhere else nothing is.
    if (!undone.took || !from) {
      this.end();
      return;
    }
    this.unapplyId = undone.unapplyId;
    this.redoIn = from;
    this.seat?.drop();
  }

  /** `history` dropped its Redo (the writer typed, or its session closed): nothing is left of it. */
  private dropped(history: DocumentHistory): void {
    if (this.redoIn === history) this.end();
  }

  /** The Redo of the press that took it back, once that press has answered. */
  private redo(): void {
    void (this.pending ?? Promise.resolve()).then(async () => {
      const { unapplyId } = this;
      if (this.ended || !unapplyId) return;
      this.unapplyId = null;
      this.redoIn = null;
      const landed = await this.port.redo(unapplyId);
      if (landed === "failed") {
        notifyFailure({
          key: `redo:${this.commandId}`,
          title: t`Couldn't redo`,
          brief: true,
        });
        this.end();
        return;
      }
      if (!landed) {
        this.end();
        return;
      }
      this.commandId = landed.commandId;
      this.enter();
      this.seat?.push();
    });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const entry of this.entries.values()) entry.remove();
    this.entries.clear();
    this.seat?.drop();
    this.over();
  }
}
