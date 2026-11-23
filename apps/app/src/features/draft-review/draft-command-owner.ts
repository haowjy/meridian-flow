/**
 * Account-lifetime command state for a Work's review items: which items a press has in flight
 * (`hold`), the presses this tab can still take back (`presses`), each turn's Restore before in a
 * draft (`restore`) and one notice per draft owner. The press itself is `usePressCommands`.
 */
import { type DraftId, draftItemKey, type TurnId } from "@meridian/contracts";
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
      /** Takes the press back once, as its notice's Undo does. */
      undo?: () => Promise<unknown>;
    }
  /** The server answered and the press changed none of these items. */
  | { kind: "settled"; took?: DiscardTook };

/**
 * A turn's Restore before in one draft, as this tab knows it: sent and not yet answered, or in
 * force with its one Undo (`press`).
 */
export type RestoreEntry = { kind: "sending" } | { kind: "in-force"; press: PressEntries };

const restoreKey = (turn: TurnId, draft: DraftId) => `${turn}:${draft}`;

export class DraftCommandOwner {
  private readonly records = new Map<string, DraftCommandState>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  /** Every press this tab can still take back or press again. */
  readonly presses = new Set<PressEntries>();
  /** One notice per draft owner, outliving the surface that made it. */
  readonly notices = new DraftNotices();
  /** `at`: when the entry last changed here; a card read from before then is out of date. */
  private readonly restores = new Map<string, { entry: RestoreEntry | null; at: number }>();
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

  /** The turn's Restore before in `draft` this tab has sent or holds in force. */
  restore(turn: TurnId, draft: DraftId): RestoreEntry | null {
    return this.restores.get(restoreKey(turn, draft))?.entry ?? null;
  }

  /** When the turn's Restore before in `draft` last changed here; 0 if it never did. */
  restoreChangedAt(turn: TurnId, draft: DraftId): number {
    return this.restores.get(restoreKey(turn, draft))?.at ?? 0;
  }

  /** The drafts where this tab has sent or holds the turn's Restore before. */
  restoredDrafts(turn: TurnId): DraftId[] {
    const prefix = `${turn}:`;
    return [...this.restores].flatMap(([key, { entry }]) =>
      entry && key.startsWith(prefix) ? [key.slice(prefix.length) as DraftId] : [],
    );
  }

  setRestore(turn: TurnId, draft: DraftId, entry: RestoreEntry | null, at = Date.now()) {
    this.restores.set(restoreKey(turn, draft), { entry, at });
    this.changed();
  }

  /** Something a surface reads changed: a press's Undo went out or came back. */
  changed = () => {
    this.revision++;
    for (const listener of this.listeners) listener();
  };

  private setState(itemKey: string, state: DraftCommandState) {
    const previous = this.state(itemKey);
    if (previous.hidden === state.hidden && previous.applying === state.applying) return;
    if (state.hidden || state.applying) this.records.set(itemKey, state);
    else this.records.delete(itemKey);
    this.changed();
  }

  close() {
    this.notices.close();
    for (const press of this.presses.values()) press.end();
  }
}

/** A folder's item in a Work's draft: the key its commands' state is kept under. */
export const folderKey = (draftId: string, folderId: string): string =>
  draftItemKey(draftId as DraftId, folderId);
