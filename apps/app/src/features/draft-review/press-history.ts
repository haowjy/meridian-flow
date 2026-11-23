import { t } from "@lingui/core/macro";
import type { OutsideStep } from "@meridian/loro-prosemirror";
import { notifyFailure } from "@/components/app/failure-toast";

/**
 * What a press of Undo came to: `failed`, it never reached the server (`told`: the writer was
 * told already, when it couldn't be saved to send); else the Undo the server answered
 * (`unpressId`) and whether it took anything back.
 */
export type Undone =
  | { kind: "failed"; told?: true }
  | { kind: "answered"; unpressId: string; took: boolean };

/** The request every Undo of a press makes, by command id: take back the press in force. */
export type PressPort = {
  unpress(pressId: string): Promise<Undone>;
};

/** Where a press's step is on the sidebar's Undo stack while it can be taken back. */
export type Seat = { push(): void; drop(): void };

/**
 * One press (an Apply or a Discard) on the sidebar's stack, until it is taken back. It holds the
 * press's command id and nothing else of it: an Undo asks the server to take it back, and one
 * that lands ends it. A failed Undo leaves it to try again.
 */
export class PressEntries {
  private ended = false;
  /** The Undo out now, which a second press waits on. */
  private pending: Promise<Undone> | null = null;

  constructor(
    private readonly commandId: string,
    private readonly port: PressPort,
    private readonly seat: Seat | null,
    /** It ended: nothing is left of it to take back. */
    private readonly over: () => void,
  ) {
    seat?.push();
  }

  get id(): string {
    return this.commandId;
  }

  /** Every Undo of it: a row's or a card's Undo, the sidebar's Ctrl+Z. A press while one is out hears the same answer. */
  undo(): Promise<Undone> {
    if (this.ended) return Promise.resolve({ kind: "answered", unpressId: "", took: false });
    if (this.pending) return this.pending;
    const press = this.port.unpress(this.commandId).then((undone) => {
      this.pending = null;
      if (undone.kind === "failed") {
        if (!undone.told)
          notifyFailure({
            key: `unpress:${this.commandId}`,
            title: t`Couldn't undo`,
            brief: true,
          });
      } else this.end();
      return undone;
    });
    this.pending = press;
    return press;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.seat?.drop();
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
  private press: Promise<PressEntries | null> = Promise.resolve(null);
  /** Ctrl+Z took it back: its step is on the Redo stack. */
  private undone = false;

  constructor(
    private readonly histories: readonly EditorHistory[],
    private readonly again: (step: EditorPressStep) => void,
  ) {
    for (const history of histories) history.pushOutside(this);
  }

  /** The press this step stands for, from its sending to its answer. */
  pressing(press: Promise<PressEntries | null>): void {
    this.press = press;
    void press.then((entries) => {
      if (!entries) this.remove();
    });
  }

  undo(): void {
    this.undone = true;
    void this.press.then(async (entries) => {
      if (!entries) return;
      const undone = await entries.undo();
      if (undone.kind !== "failed") return;
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
