import { t } from "@lingui/core/macro";
import type { OutsideStep } from "@meridian/loro-prosemirror";
import { notifyFailure } from "@/components/app/failure-toast";

export type Undone = { ok: boolean; told?: true };

export type Seat = { push(): void; drop(): void };

export class PressEntry {
  private ended = false;
  private pending: Promise<Undone> | null = null;

  constructor(
    readonly id: string,
    private readonly unpress: () => Promise<Undone>,
    private readonly seat: Seat,
    private readonly over: () => void,
    private readonly changed: () => void,
  ) {
    seat.push();
  }

  get undoing(): boolean {
    return this.pending !== null;
  }

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
  private press: Promise<PressEntry | null> = Promise.resolve(null);
  private undone = false;

  constructor(
    private readonly histories: readonly EditorHistory[],
    private readonly again: (step: EditorPressStep) => void,
  ) {
    for (const history of histories) history.pushOutside(this);
  }

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

  drop(): void {
    if (!this.undone) this.remove();
  }

  private remove(): void {
    for (const history of this.histories) history.removeOutside(this);
  }
}
