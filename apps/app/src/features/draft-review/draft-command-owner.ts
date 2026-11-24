/**
 * Account-lifetime command state for a Work's review items: which items a press has in flight
 * (every press the journal holds unanswered, `followPresses`), the presses this tab can still take
 * back (`presses`), each turn's restore in a draft (`restore`) and one notice per draft owner. The
 * press itself is `usePressCommands`.
 */
import { t } from "@lingui/core/macro";
import type { CommandRecord } from "@meridian/command-driver";
import { type DraftId, draftItemKey, parseDraftItemKey, type TurnId } from "@meridian/contracts";
import { type PressBody, pressRooms } from "@/client/query/press-commands";
import { notifyFailure } from "@/components/app/failure-toast";
import { DraftNotices, workNoticeKey } from "./draft-notices";
import type { PressEntry } from "./press-history";

type DraftCommandState = {
  applying: boolean;
  /** A press has the item in flight: its rows and review leave until the press answers. */
  hidden: boolean;
};
const EMPTY: DraftCommandState = { applying: false, hidden: false };
const APPLYING: DraftCommandState = { applying: true, hidden: true };
const DISCARDING: DraftCommandState = { applying: false, hidden: true };

/** What a journaled press takes whole: one document's item, or every item of its drafts. */
type JournalHold = ({ item: string } | { drafts: ReadonlySet<string> }) & {
  state: DraftCommandState;
};

/** `settled`: the server answered and the press changed none of its items. */
export type CommandOutcome = "done" | "settled" | "blocked";

/**
 * A turn's restore in one draft, as this tab knows it: sent and not yet answered, or in
 * force with its one Undo (`press`).
 */
export type RestoreEntry = { kind: "sending" } | { kind: "in-force"; press: PressEntry };

const restoreKey = (turn: TurnId, draft: DraftId) => `${turn}:${draft}`;

export class DraftCommandOwner {
  private journal: readonly JournalHold[] = [];
  private readonly opened = Date.now();
  private readonly reported = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  /** Every press this tab can still take back or press again. */
  readonly presses = new Set<PressEntry>();
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
    const draft = parseDraftItemKey(itemKey)?.draftId;
    const hold = this.journal.find((each) =>
      "item" in each ? each.item === itemKey : draft !== undefined && each.drafts.has(draft),
    );
    return hold?.state ?? EMPTY;
  }

  /** Whether a press in flight takes all of the draft. */
  holdsDraft(draft: string): boolean {
    return this.journal.some((hold) => "drafts" in hold && hold.drafts.has(draft));
  }

  /**
   * The account's journaled presses: one not answered yet, or answered and not yet in a list
   * read, holds its items in flight (hidden, so their rows and review leave), in every tab and
   * through a reload. A press of a change or a turn takes part of a document and holds nothing.
   * One the server never took, since this tab opened, says so once, in a tab showing its project
   * (`shownProject`).
   */
  followPresses(records: readonly CommandRecord[], shownProject: string | null) {
    for (const record of records) this.reportFailure(record, shownProject);
    const holds = records.flatMap((record): JournalHold[] => {
      if (record.state === "never" || (record.state === "done" && record.observed)) return [];
      const { scope, verdict } = record.body as Partial<PressBody>;
      const state = verdict === "apply" ? APPLYING : DISCARDING;
      if (scope?.kind === "document") return [{ item: scope.item, state }];
      if (scope?.kind === "draft" || scope?.kind === "work")
        return [{ drafts: new Set<string>(pressRooms(record).drafts), state }];
      return [];
    });
    if (holds.length === 0 && this.journal.length === 0) return;
    this.journal = holds;
    this.changed();
  }

  private reportFailure(record: CommandRecord, shownProject: string | null) {
    if (record.state !== "never" || (record.settledAt ?? 0) < this.opened) return;
    if (this.reported.has(record.id)) return;
    this.reported.add(record.id);
    const { scope, verdict, projectId } = record.body as Partial<PressBody>;
    if (projectId !== shownProject) return;
    const owner =
      scope?.kind === "work"
        ? workNoticeKey(scope.work)
        : scope?.kind === "draft" || scope?.kind === "turn"
          ? scope.draft
          : scope && parseDraftItemKey(scope.item)?.draftId;
    notifyFailure({
      key: `press:${owner ?? record.id}`,
      title:
        verdict === "apply"
          ? t`Couldn't apply`
          : verdict === "restore"
            ? t`Couldn't undo`
            : t`Couldn't discard`,
      brief: true,
    });
  }

  /** The turn's restore in `draft` this tab has sent or holds in force. */
  restore(turn: TurnId, draft: DraftId): RestoreEntry | null {
    return this.restores.get(restoreKey(turn, draft))?.entry ?? null;
  }

  /** When the turn's restore in `draft` last changed here; 0 if it never did. */
  restoreChangedAt(turn: TurnId, draft: DraftId): number {
    return this.restores.get(restoreKey(turn, draft))?.at ?? 0;
  }

  /** The drafts where this tab has sent or holds the turn's restore. */
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

  close() {
    this.notices.close();
    for (const press of this.presses.values()) press.end();
  }
}

/** A folder's item in a Work's draft: the key its commands' state is kept under. */
export const folderKey = (draftId: string, folderId: string): string =>
  draftItemKey(draftId as DraftId, folderId);
