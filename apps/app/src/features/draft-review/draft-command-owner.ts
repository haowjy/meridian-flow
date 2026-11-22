/**
 * Account-lifetime command state for a Work's review items: which items a press has in flight
 * (`hold`), the presses this tab can still take back (`presses`) and one notice per draft owner.
 * The press itself is `usePressCommands`.
 */
import { type DraftId, draftItemKey } from "@meridian/contracts";
import { type DiscardTook, DraftNotices } from "./draft-notices";
import type { PressEntries } from "./press-history";

type DraftCommandState = {
  applying: boolean;
  /** A press has the item in flight: its rows and review leave until the press answers. */
  hidden: boolean;
};
const EMPTY: DraftCommandState = { applying: false, hidden: false };

export type CommandOutcome =
  | { kind: "blocked" }
  | {
      kind: "done";
      /** The press that landed it, which its Undo names. */
      commandId?: string;
      /** A Discard's answer: what of what it was sent it took (`DiscardTook`). */
      took?: DiscardTook;
    }
  /** The server answered and the press changed none of these items. */
  | { kind: "settled"; took?: DiscardTook };

export class DraftCommandOwner {
  private readonly records = new Map<string, DraftCommandState>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  /** Every press this tab can still take back or press again. */
  readonly presses = new Set<PressEntries>();
  /** One notice per draft owner, outliving the surface that made it. */
  readonly notices = new DraftNotices();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.revision;

  state(itemKey: string): DraftCommandState {
    return this.records.get(itemKey) ?? EMPTY;
  }

  /** Items a press has in flight: hidden, so their rows and review leave, until the release. */
  hold(itemKeys: readonly string[], applying: boolean): () => void {
    for (const itemKey of itemKeys) this.setState(itemKey, { hidden: true, applying });
    return () => {
      for (const itemKey of itemKeys) this.setState(itemKey, EMPTY);
    };
  }

  private setState(itemKey: string, state: DraftCommandState) {
    const previous = this.state(itemKey);
    if (previous.hidden === state.hidden && previous.applying === state.applying) return;
    if (state.hidden || state.applying) this.records.set(itemKey, state);
    else this.records.delete(itemKey);
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  close() {
    this.notices.close();
    for (const press of this.presses.values()) press.end();
  }
}

/** A folder's item in a Work's draft: the key its commands' state is kept under. */
export const folderKey = (draftId: string, folderId: string): string =>
  draftItemKey(draftId as DraftId, folderId);
