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

/** What a journaled press keeps out of review while it is in flight. */
type JournalHold =
  | { kind: "item"; item: string; applying: boolean }
  | { kind: "drafts"; drafts: ReadonlySet<string>; applying: boolean }
  | { kind: "change"; item: string; change: string; applying: boolean };

/** A row a notice keeps in the list, and where it was before the press took it. */
export type HeldNoticeRow<T> = { key: string; row: T; after: readonly string[] };
export type HeldNoticeRows = ReadonlyMap<string, readonly HeldNoticeRow<unknown>[]>;

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
  /** Rows kept in the Changes list for a notice, removed with that notice. */
  private readonly noticeRows = new Map<string, HeldNoticeRows>();
  /** One notice per draft owner, outliving the surface that made it. */
  readonly notices = new DraftNotices((draftId, id) => {
    this.noticeRows.delete(`${draftId}:${id}`);
  });
  /** `at`: when the entry last changed here; a card read from before then is out of date. */
  private readonly restores = new Map<string, { entry: RestoreEntry | null; at: number }>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.revision;

  /** Whether the journal currently subtracts this item from every draft-list read. */
  holds(itemKey: string): boolean {
    const draft = parseDraftItemKey(itemKey)?.draftId;
    return this.journal.some((each) =>
      each.kind === "item"
        ? each.item === itemKey
        : each.kind === "drafts" && draft !== undefined && each.drafts.has(draft),
    );
  }

  /** Whether a press in flight takes all of the draft. */
  holdsDraft(draft: string): boolean {
    return this.journal.some((hold) => hold.kind === "drafts" && hold.drafts.has(draft));
  }

  /** Whether an Apply in flight takes a whole row from the draft. */
  applyingDraft(draft: string): boolean {
    return this.journal.some(
      (hold) =>
        hold.applying &&
        (hold.kind === "drafts"
          ? hold.drafts.has(draft)
          : hold.kind === "item" && parseDraftItemKey(hold.item)?.draftId === draft),
    );
  }

  /** Change rows a journaled press keeps out of one document's editor review. */
  heldChanges(itemKey: string): ReadonlySet<string> {
    return new Set(
      this.journal.flatMap((hold) =>
        hold.kind === "change" && hold.item === itemKey ? [hold.change] : [],
      ),
    );
  }

  holdNoticeRows(draftId: string, id: number, rows: HeldNoticeRows | undefined) {
    if (rows?.size) this.noticeRows.set(`${draftId}:${id}`, rows);
  }

  heldNoticeRows<T>(draftId: string, id: number, draft: string): readonly HeldNoticeRow<T>[] {
    return (this.noticeRows.get(`${draftId}:${id}`)?.get(draft) ??
      []) as readonly HeldNoticeRow<T>[];
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
      const applying = verdict === "apply";
      if (scope?.kind === "document") return [{ kind: "item", item: scope.item, applying }];
      if (scope?.kind === "draft" || scope?.kind === "work")
        return [{ kind: "drafts", drafts: new Set<string>(pressRooms(record).drafts), applying }];
      if (scope?.kind === "change")
        return [{ kind: "change", item: scope.item, change: scope.change, applying }];
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
