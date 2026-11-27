export type NoticeSurface =
  | { kind: "changes" }
  | { kind: "strip"; threadId: string | null }
  | { kind: "page"; documentId: string; draftId: string | null }
  | { kind: "landing" };

export const deleteNoticeKey = (projectId: string) => `delete:${projectId}`;

type NoticeSubject =
  | { kind: "draft" | "change" | "deleted"; name: string }
  | { kind: "drafts"; count: number }
  | { kind: "deletes"; count: number };

type Base = { id: number; projectId: string; draftId: string; surface: NoticeSurface };

export const workNoticeKey = (workId: string) => `work:${workId}`;

export type DraftNotice =
  | (Base & {
      kind: "discarded";
      subject: NoticeSubject;
      documentIds: readonly string[];
      status: "ready" | "undoing";
      left: { landed: string | null } | null;
      undo(): Promise<void>;
      dismiss(): void;
    })
  | (Base & {
      kind: "applied";
      documents: readonly { documentId: string; name: string }[];
      change: boolean;
      wholeDraft: boolean;
      undo(): void;
      dismiss(): void;
    });

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

  discarding(documentId: string): DraftNotice | null {
    for (const notice of this.notices.values())
      if (notice.kind === "discarded" && notice.documentIds.includes(documentId)) return notice;
    return null;
  }

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

  landed(draftId: string, id: number, landing: { documentId: string | null } | null) {
    if (!landing) return this.end(draftId, id);
    const notice = this.notices.get(draftId);
    if (notice?.id !== id || notice.kind !== "discarded") return;
    this.notices.set(draftId, { ...notice, left: { landed: landing.documentId } });
    this.publish();
  }

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
