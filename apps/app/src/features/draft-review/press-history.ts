import { t } from "@lingui/core/macro";
import type { OutsideStep } from "@meridian/loro-prosemirror";
import { notifyFailure } from "@/components/app/failure-toast";

/**
 * What a press of Undo came to: `ok`, the server took the press back; else it failed, `told` when
 * the writer was told already (it couldn't be saved to send).
 */
export type Undone = { ok: boolean; told?: true };

/** Where a press's step is on the sidebar's Undo stack while it can be taken back. */
export type Seat = { push(): void; drop(): void };

/**
 * One press (an Apply, a Discard or a turn's restore) on the sidebar's stack, until it is taken
 * back. An Undo asks the server to take it back, and one that lands ends it. A failed Undo leaves
 * it to try again.
 */
export class PressEntry {
  private ended = false;
  /** The Undo out now, which a second press waits on. */
  private pending: Promise<Undone> | null = null;

  constructor(
    readonly id: string,
    private readonly unpress: () => Promise<Undone>,
    private readonly seat: Seat,
    /** It ended: nothing is left of it to take back. */
    private readonly over: () => void,
    /** An Undo of it went out, or came back: `undoing` changed. */
    private readonly changed: () => void,
  ) {
    seat.push();
  }

  /** An Undo of it is out: every surface that offers it shows it running. */
  get undoing(): boolean {
    return this.pending !== null;
  }

  /** Every Undo of it: a row's or a card's Undo, the sidebar's Ctrl+Z. A press while one is out hears the same answer. */
  undo(): Promise<Undone> {
    if (this.ended) return Promise.resolve({ ok: true });
    if (this.pending) return this.pending;
    const press = this.unpress().then((undone) => {
      this.pending = null;
      this.changed();
      if (undone.ok) this.end();
      else if (!undone.told)
        notifyFailure({
          key: `unpress:${this.id}`,
          title: t`Couldn't undo`,
          brief: true,
        });
      return undone;
    });
    this.pending = press;
    this.changed();
    return press;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.seat.drop();
    this.over();
  }
}

/** The Ctrl+Z of an editor open on a pressed document (`DocumentHistory`). */
export type EditorHistory = {
  pushOutside(step: OutsideStep): void;
  removeOutside(step: OutsideStep): void;
  restoreOutside(step: OutsideStep): void;
};

/**
 * A press's step on the Ctrl+Z of the editors open on its documents, pushed as the press is made,
 * so typing after it is undone first. Its Undo waits for the press's answer and is that press's
 * one Undo; Redo presses again and the step stands for the new press. Taken back from anywhere
 * else (the sidebar, a notice), the step leaves the editors with it.
 */
export class EditorPressStep implements OutsideStep {
  /** The press in force, once answered: null when it took nothing. */
  private press: Promise<PressEntry | null> = Promise.resolve(null);
  /** Ctrl+Z took it back: its step is on the Redo stack. */
  private undone = false;

  constructor(
    private readonly histories: readonly EditorHistory[],
    private readonly again: (step: EditorPressStep) => void,
  ) {
    for (const history of histories) history.pushOutside(this);
  }

  /** The press this step stands for, from its sending to its answer. */
  pressing(press: Promise<PressEntry | null>): void {
    this.press = press;
    void press.then((entry) => {
      if (!entry) this.remove();
    });
  }

  undo(): void {
    this.undone = true;
    void this.press.then(async (entry) => {
      if (!entry) return;
      if ((await entry.undo()).ok) return;
      this.undone = false;
      for (const history of this.histories) history.restoreOutside(this);
    });
  }

  redo(): void {
    this.undone = false;
    this.again(this);
  }

  /** Its press ended elsewhere: a step Ctrl+Z took back stays for Redo. */
  drop(): void {
    if (!this.undone) this.remove();
  }

  private remove(): void {
    for (const history of this.histories) history.removeOutside(this);
  }
}
