/**
 * One notice per draft owner (`work:<id>`, `lineage:<root>`): the owner's latest Discard with its
 * Undo, or the facts its latest Apply brought. The account command owner holds it, so a notice
 * outlives the surface that made it; a reload starts with none.
 */
import type { ReviewFileTarget } from "@/client/query/work-branch-files";

export type NoticeSurface =
  | { kind: "changes" }
  | { kind: "dock"; threadId: string | null }
  /** A document's review band: the notice shows in that document's identity row. */
  | { kind: "band"; documentId: string };

export type NoticeSubject =
  | { kind: "draft" | "change"; name: string }
  | { kind: "drafts"; count: number };

/** One room's share of a Discard's Undo (`startDraftDiscardSession`). */
export type DiscardUndo = {
  /** `gone`: nothing is left to take back (the room ended, or the write never landed). */
  undo(): Promise<"ok" | "failed" | "gone">;
  end(): void;
};

export type DiscardPart = {
  documentId: string;
  name: string;
  scope: "draft" | "change";
  handle: DiscardUndo;
  /** The draft's review, for the view to follow an Undo back to. */
  review?: ReviewFileTarget;
  /** Right after this room's Undo is written: the caller's caches catch up. */
  undone?: () => void;
};

type Base = { id: number; projectId: string; ownerKey: string; surface: NoticeSurface };

export type DraftNotice =
  | (Base & {
      kind: "discarded";
      subject: NoticeSubject;
      documentIds: readonly string[];
      /** A single draft's review, which an Undo may return main to. */
      review: ReviewFileTarget | null;
      status: "ready" | "undoing" | "failed";
      /** The Discard sent main away from the page it was made on; `landed` is where main went. */
      left: { landed: string | null } | null;
      undo(): Promise<"ok" | "failed">;
      dismiss(): void;
    })
  | (Base & {
      kind: "applied";
      restored: readonly string[];
      renamed: readonly string[];
      alsoApplied: readonly string[];
      dismiss(): void;
    });

export class DraftNotices {
  private readonly notices = new Map<string, DraftNotice>();
  /** A Discard notice's rooms still holding an Undo. */
  private readonly parts = new Map<number, DiscardPart[]>();
  private readonly listeners = new Set<() => void>();
  private nextId = 1;
  private revision = 0;
  private closed = false;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.revision;

  get(ownerKey: string): DraftNotice | null {
    return this.notices.get(ownerKey) ?? null;
  }

  /** The Discard notice a document's identity row shows: made in its band, or main landed on it. */
  forDocument(projectId: string, documentId: string): DraftNotice | null {
    for (const notice of this.notices.values())
      if (
        notice.kind === "discarded" &&
        notice.projectId === projectId &&
        (notice.left
          ? notice.left.landed === documentId
          : notice.surface.kind === "band" && notice.surface.documentId === documentId)
      )
        return notice;
    return null;
  }

  /** Replaces the owner's notice: an Apply or a Discard with no Undo shows nothing in its place. */
  end(ownerKey: string) {
    const notice = this.notices.get(ownerKey);
    if (!notice) return;
    this.drop(notice);
    this.publish();
  }

  showApplied(
    input: Omit<Extract<DraftNotice, { kind: "applied" }>, "id" | "kind" | "dismiss">,
  ): void {
    if (this.closed) return;
    const held = this.notices.get(input.ownerKey);
    if (held) this.drop(held);
    const id = this.nextId++;
    this.notices.set(input.ownerKey, {
      ...input,
      kind: "applied",
      id,
      dismiss: () => this.endIf(input.ownerKey, id),
    });
    this.publish();
  }

  /** The facts an Apply adds to the owner's applied notice, if it is the one showing. */
  appliedFacts(ownerKey: string) {
    const held = this.notices.get(ownerKey);
    return held?.kind === "applied" ? held : null;
  }

  showDiscard(input: {
    projectId: string;
    ownerKey: string;
    surface: NoticeSurface;
    parts: readonly DiscardPart[];
    left?: boolean;
  }): number | null {
    if (this.closed || input.parts.length === 0) {
      for (const part of input.parts) part.handle.end();
      return null;
    }
    const held = this.notices.get(input.ownerKey);
    if (held) this.drop(held);
    const id = this.nextId++;
    this.parts.set(id, [...input.parts]);
    const { ownerKey } = input;
    this.notices.set(ownerKey, {
      kind: "discarded",
      id,
      projectId: input.projectId,
      ownerKey,
      surface: input.surface,
      left: input.left ? { landed: null } : null,
      status: "ready",
      ...this.subjectOf(input.parts),
      undo: () => this.undo(ownerKey, id),
      dismiss: () => this.endIf(ownerKey, id),
    });
    this.publish();
    return id;
  }

  /** Where main landed after the Discard made it leave. */
  landed(ownerKey: string, id: number, documentId: string | null) {
    this.update(ownerKey, id, () => ({ left: { landed: documentId } }));
  }

  /** A room's Undo ended on its own: the room closed, its text moved on, or Ctrl+Z took it back. */
  partEnded(handle: DiscardUndo) {
    for (const [id, parts] of this.parts) {
      const index = parts.findIndex((part) => part.handle === handle);
      if (index < 0) continue;
      parts.splice(index, 1);
      const notice = [...this.notices.values()].find((candidate) => candidate.id === id);
      if (notice?.kind !== "discarded" || notice.status === "undoing") return;
      if (parts.length === 0) {
        this.notices.delete(notice.ownerKey);
        this.parts.delete(id);
      } else this.notices.set(notice.ownerKey, { ...notice, ...this.subjectOf(parts) });
      this.publish();
      return;
    }
  }

  close() {
    this.closed = true;
    for (const notice of [...this.notices.values()]) this.drop(notice);
    this.publish();
  }

  private async undo(ownerKey: string, id: number): Promise<"ok" | "failed"> {
    const notice = this.notices.get(ownerKey);
    const parts = this.parts.get(id);
    if (notice?.id !== id || notice.kind !== "discarded" || notice.status === "undoing" || !parts)
      return "failed";
    this.update(ownerKey, id, () => ({ status: "undoing" }));
    // Retry takes back only the rooms that failed: a part that undid has ended and left the list.
    const answers = await Promise.all(
      [...parts].map(async (part) => {
        // The prose comes back before the server acknowledges it: the row returns with it.
        const pending = part.handle.undo();
        part.undone?.();
        return { part, answer: await pending };
      }),
    );
    const failed = answers.flatMap(({ part, answer }) => (answer === "failed" ? [part] : []));
    if (this.notices.get(ownerKey)?.id !== id) return failed.length ? "failed" : "ok";
    if (failed.length === 0) {
      this.notices.delete(ownerKey);
      this.parts.delete(id);
      this.publish();
      return "ok";
    }
    this.parts.set(id, failed);
    this.update(ownerKey, id, () => ({ status: "failed", ...this.subjectOf(failed) }));
    return "failed";
  }

  private subjectOf(parts: readonly DiscardPart[]) {
    const [only] = parts;
    return {
      subject:
        parts.length === 1 && only
          ? { kind: only.scope, name: only.name }
          : { kind: "drafts" as const, count: parts.length },
      documentIds: parts.map((part) => part.documentId),
      review: (parts.length === 1 && only?.review) || null,
    };
  }

  private update(
    ownerKey: string,
    id: number,
    patch: () => Partial<Extract<DraftNotice, { kind: "discarded" }>>,
  ) {
    const notice = this.notices.get(ownerKey);
    if (notice?.id !== id || notice.kind !== "discarded") return;
    this.notices.set(ownerKey, { ...notice, ...patch() });
    this.publish();
  }

  private endIf(ownerKey: string, id: number) {
    const notice = this.notices.get(ownerKey);
    if (notice?.id === id) this.end(ownerKey);
  }

  private drop(notice: DraftNotice) {
    this.notices.delete(notice.ownerKey);
    const parts = this.parts.get(notice.id) ?? [];
    this.parts.delete(notice.id);
    for (const part of parts) part.handle.end();
  }

  private publish() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}
