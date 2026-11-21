/**
 * Account-lifetime command state for a Work's review items: which items a press has in flight
 * (`hold`), the Applies this tab can still take back (`applied`), each Discard's restore and one
 * notice per draft owner. The press itself is `usePressCommands`.
 */
import { type BranchId, draftItemKey } from "@meridian/contracts";
import type { ApplyEntries } from "./apply-history";
import { DiscardRestores } from "./discard-restores";
import { type DiscardTook, DraftNotices } from "./draft-notices";

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
  /** Every Apply this tab can still take back or apply again. */
  readonly applied = new Set<ApplyEntries>();
  /** Each Discard's restore, whatever sent it: the one progress every view reads. */
  readonly restores = new DiscardRestores();
  /** One notice per draft owner, outliving the surface that made it. */
  readonly notices = new DraftNotices(this.restores);
  /** An Apply made before a session of its documents opened joins that session's history. */
  private readonly stopRejoining: () => void;

  constructor(registry: { observeHistories(observer: () => void): () => void }) {
    this.stopRejoining = registry.observeHistories(() => {
      for (const applied of this.applied) applied.enter();
    });
  }

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
    this.stopRejoining();
    this.notices.close();
    // Their entries sit on sessions that outlive this owner.
    for (const applied of this.applied.values()) applied.end();
  }
}

/** A folder's item in a Work's branch: the key its commands' state is kept under. */
export const folderKey = (branchId: string, folderId: string): string =>
  draftItemKey(branchId as BranchId, folderId);
