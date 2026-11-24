/**
 * One notice per draft (by its id): the draft's latest Discard or Apply, each with its press's
 * one Undo; and per project the writer's latest delete
 * (`deleteNoticeKey`), whose Undo is the sidebar's Undo step, for main's page or Recently opened
 * (the sidebar's rows say it themselves, `TreeNotice`). The account command owner holds
 * them, so a notice outlives the surface that made it; a reload starts with none.
 */
export type NoticeSurface =
  | { kind: "changes" }
  | { kind: "strip"; threadId: string | null }
  /**
   * A document's page: the notice floats at that page's foot. `draftId`: the draft the page showed
   * when a press there made it, which alone shows it, and leaving it ends it; null for a delete,
   * which shows wherever main went.
   */
  | { kind: "page"; documentId: string; draftId: string | null }
  /** Where a delete made on main's Recently opened shows; the sidebar's rows carry their own. */
  | { kind: "landing" };

/** The key a project's delete notice is held under, beside the draft owners'. */
export const deleteNoticeKey = (projectId: string) => `delete:${projectId}`;

type NoticeSubject =
  /** `deleted`: the writer's delete. */
  | { kind: "draft" | "change" | "deleted"; name: string }
  | { kind: "drafts"; count: number }
  | { kind: "deletes"; count: number };

/** `draftId`: the draft whose press it tells of, or `workNoticeKey` for a press of a Work's drafts. */
type Base = { id: number; projectId: string; draftId: string; surface: NoticeSurface };

/** The notice key of a press of every draft of a Work (its `Apply all`). */
export const workNoticeKey = (workId: string) => `work:${workId}`;

export type DraftNotice =
  | (Base & {
      kind: "discarded";
      subject: NoticeSubject;
      /** The documents and folders the Discard took: the rows its Undo brings back. */
      documentIds: readonly string[];
      status: "ready" | "undoing";
      /** The Discard sent main away from the page it was made on; `landed` is where main went. */
      left: { landed: string | null } | null;
      undo(): Promise<void>;
      dismiss(): void;
    })
  | (Base & {
      kind: "applied";
      /** The documents the Apply took, each named as it was listed. */
      documents: readonly { documentId: string; name: string }[];
      /** It took one change of its document (Review changes' Apply), not the whole document. */
      change: boolean;
      /** It took every row of a draft or Work, so its one Undo is said once in a row list. */
      wholeDraft: boolean;
      /** The Apply's one Undo (its press's). */
      undo(): void;
      dismiss(): void;
    });

/**
 * A Discard notice: what it took, said as one `name` (`count` 1) or a count, and its one Undo,
 * which answers whether it took the Discard back.
 */
type DiscardInput = {
  projectId: string;
  draftId: string;
  surface: NoticeSurface;
  scope: "draft" | "change" | "deleted";
  name: string;
  count?: number;
  documentIds: readonly string[];
  undo(): boolean | Promise<boolean>;
};

export class DraftNotices {
  private readonly notices = new Map<string, DraftNotice>();
  private readonly listeners = new Set<() => void>();
  /** The draft pages hosts show now, by document and draft, with how many hosts show each. */
  private readonly shownPages = new Map<string, number>();
  private nextId = 1;
  private revision = 0;
  private closed = false;

  constructor(private readonly onEnd?: (draftId: string, id: number) => void) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.revision;

  get(draftId: string): DraftNotice | null {
    return this.notices.get(draftId) ?? null;
  }

  /**
   * The notice a document's page shows, on the draft it shows (`draftId`, null on Live): an Apply
   * or Discard made on that page and draft, or a delete on the document main went back to when it
   * made main leave (null `documentId`: Recently opened, whose top slot shows it). A list or strip
   * keeps its own notice where it was made.
   */
  forDocument(
    projectId: string,
    documentId: string | null,
    draftId: string | null = null,
  ): DraftNotice | null {
    for (const notice of this.notices.values()) {
      if (notice.projectId !== projectId) continue;
      const { surface } = notice;
      const left = notice.kind === "discarded" ? notice.left : null;
      if (
        surface.kind === "page"
          ? (left ? left.landed : surface.documentId) === documentId &&
            (surface.draftId === null || surface.draftId === draftId)
          : surface.kind === "landing" && documentId === null
      )
        return notice;
    }
    return null;
  }

  /** The Discard notice whose Undo brings this document back, wherever it was made. */
  discarding(documentId: string): DraftNotice | null {
    for (const notice of this.notices.values())
      if (notice.kind === "discarded" && notice.documentIds.includes(documentId)) return notice;
    return null;
  }

  /**
   * A host shows a document's page on a draft. A press's notice belongs to that page: once no host
   * shows it (the host moved to another draft, Live or another document), the notice ends.
   */
  showPage(documentId: string, draftId: string): () => void {
    const key = `${documentId}\n${draftId}`;
    this.shownPages.set(key, (this.shownPages.get(key) ?? 0) + 1);
    return () => {
      const hosts = (this.shownPages.get(key) ?? 1) - 1;
      if (hosts > 0) {
        this.shownPages.set(key, hosts);
        return;
      }
      this.shownPages.delete(key);
      // A page moving to another host is let go and taken up in one commit: decide after it.
      queueMicrotask(() => {
        if (this.shownPages.has(key)) return;
        for (const notice of [...this.notices.values()])
          if (
            notice.surface.kind === "page" &&
            notice.surface.documentId === documentId &&
            notice.surface.draftId === draftId
          )
            this.end(notice.draftId, notice.id);
      });
    };
  }

  /** Ends the owner's notice, or with `id` only that notice: a later one stands. */
  end(draftId: string, id?: number) {
    const notice = this.notices.get(draftId);
    if (!notice || (id !== undefined && notice.id !== id)) return;
    this.notices.delete(draftId);
    this.onEnd?.(draftId, notice.id);
    this.publish();
  }

  showApplied(
    input: Omit<Extract<DraftNotice, { kind: "applied" }>, "id" | "kind" | "dismiss">,
  ): number | null {
    if (this.closed) return null;
    const id = this.nextId++;
    this.notices.set(input.draftId, {
      ...input,
      kind: "applied",
      id,
      dismiss: () => this.end(input.draftId, id),
    });
    this.publish();
    return id;
  }

  showDiscard({ undo, scope, name, count = 1, ...input }: DiscardInput): number | null {
    if (this.closed) return null;
    const id = this.nextId++;
    const { draftId } = input;
    this.notices.set(draftId, {
      ...input,
      kind: "discarded",
      id,
      left: null,
      status: "ready",
      subject:
        count === 1
          ? { kind: scope, name }
          : { kind: scope === "deleted" ? "deletes" : "drafts", count },
      undo: async () => {
        if (!this.setStatus(draftId, id, "undoing")) return;
        if (await undo()) this.end(draftId, id);
        else this.setStatus(draftId, id, "ready");
      },
      dismiss: () => this.end(draftId, id),
    });
    this.publish();
    return id;
  }

  /**
   * Where main landed after the Discard made it leave (`documentId` null: Recently opened).
   * Null: the writer moved first, so no place shows the notice, and its Undo ends.
   */
  landed(draftId: string, id: number, landing: { documentId: string | null } | null) {
    if (!landing) return this.end(draftId, id);
    const notice = this.notices.get(draftId);
    if (notice?.id !== id || notice.kind !== "discarded") return;
    this.notices.set(draftId, { ...notice, left: { landed: landing.documentId } });
    this.publish();
  }

  /** The writer left the project: its notices end. */
  endProject(projectId: string) {
    const leaving = [...this.notices.values()].filter((notice) => notice.projectId === projectId);
    for (const notice of leaving) {
      this.notices.delete(notice.draftId);
      this.onEnd?.(notice.draftId, notice.id);
    }
    if (leaving.length) this.publish();
  }

  close() {
    this.closed = true;
    for (const notice of this.notices.values()) this.onEnd?.(notice.draftId, notice.id);
    this.notices.clear();
    this.publish();
  }

  /** Moves a Discard notice's Undo to `status`; false when the notice ended or already is there. */
  private setStatus(draftId: string, id: number, status: "ready" | "undoing"): boolean {
    const notice = this.notices.get(draftId);
    if (notice?.id !== id || notice.kind !== "discarded" || notice.status === status) return false;
    this.notices.set(draftId, { ...notice, status });
    this.publish();
    return true;
  }

  private publish() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}
