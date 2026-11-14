/**
 * One notice per draft owner (`work:<id>`, `lineage:<root>`): the owner's latest Discard with its
 * Undo, or the facts its latest Apply brought; and per project the writer's latest delete
 * (`deleteNoticeKey`), whose Undo is the sidebar's Undo step. The account command owner holds
 * them, so a notice outlives the surface that made it; a reload starts with none.
 */
import type { ReviewFileTarget } from "@/client/query/work-branch-files";

export type NoticeSurface =
  | { kind: "changes" }
  | { kind: "strip"; threadId: string | null }
  /** A document's review band: the notice shows in that document's identity row. */
  | { kind: "band"; documentId: string }
  /** Where a delete made there shows: the sidebar's trees, or main's Recently opened. */
  | { kind: "tree" | "landing" };

/** The key a project's delete notice is held under, beside the draft owners'. */
export const deleteNoticeKey = (projectId: string) => `delete:${projectId}`;

export type NoticeSubject =
  /** `folder`: a folder's changes and everything listed under it. `deleted`: the writer's delete. */
  | { kind: "draft" | "change" | "folder" | "deleted"; name: string }
  | { kind: "drafts"; count: number }
  | { kind: "deletes"; count: number };

export type DiscardUndoAnswer = {
  answer: "ok" | "failed" | "gone";
  landed: Promise<void>;
  /** What the Discard held that could not come back (`UndoDiscardResult.leftOut`). */
  leftOut?: number;
};

/**
 * One share of a Discard's Undo: a room's text (`startDraftDiscardSession`), or a Discard the
 * server ran, which its Undo command takes back.
 */
export type DiscardUndo = {
  /**
   * Takes the share back now. `ok` once the prose is back in the room (or the server made its
   * copies), with `landed` settling when the server holds it; `gone`: nothing is left to take
   * back (the room ended or turned read-only, the write never landed, or it was taken back).
   * A room's answer is known at once; the server's comes back.
   */
  undo(): DiscardUndoAnswer | Promise<DiscardUndoAnswer>;
  end(): void;
};

export type DiscardPart = {
  documentId: string;
  name: string;
  scope: "draft" | "change" | "folder" | "deleted";
  /** What it stands for: a whole branch's Discard is one share for all its drafts, a delete for all it took. */
  count?: number;
  handle: DiscardUndo;
  /** The draft's review, for the view to follow an Undo back to. */
  review?: ReviewFileTarget;
  /**
   * Right after this room's Undo is written, given its `landed`: the caller's caches catch up.
   * Resolves true once the server lists the draft again, so a view may open it.
   */
  undone?: (landed: Promise<void>) => Promise<boolean>;
};

type Base = { id: number; projectId: string; ownerKey: string; surface: NoticeSurface };

export type DraftNotice =
  | (Base & {
      kind: "discarded";
      subject: NoticeSubject;
      documentIds: readonly string[];
      /** A single draft's review, which an Undo may return main to. */
      review: ReviewFileTarget | null;
      /** `partial`: the Undo landed, but `leftOut` of what the Discard held could not come back. */
      status: "ready" | "undoing" | "failed" | "partial";
      leftOut: number;
      /** The Discard sent main away from the page it was made on; `landed` is where main went. */
      left: { landed: string | null } | null;
      /** `ok` once the server lists every restored draft again; `unlisted` if one never was. */
      undo(): Promise<"ok" | "unlisted" | "failed">;
      dismiss(): void;
    })
  | (Base & {
      kind: "applied";
      restored: readonly string[];
      renamed: readonly string[];
      alsoApplied: readonly string[];
      /** Documents the Apply put in a new place, a new one included: where each went now. */
      landed: readonly { documentId: string; uri: string }[];
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

  /**
   * The Discard notice a document's identity row shows: one made in a document's band, on that
   * document, or on the one main went back to when the Discard made it leave (null: Recently
   * opened, whose top slot shows it). A list or strip keeps its own notice where it was made.
   */
  forDocument(projectId: string, documentId: string | null): DraftNotice | null {
    for (const notice of this.notices.values())
      if (
        notice.kind === "discarded" &&
        notice.projectId === projectId &&
        (notice.surface.kind === "band"
          ? (notice.left ? notice.left.landed : notice.surface.documentId) === documentId
          : notice.surface.kind === "landing" && documentId === null)
      )
        return notice;
    return null;
  }

  /** The Discard notice whose Undo brings this document back, wherever it was made. */
  discarding(documentId: string): DraftNotice | null {
    for (const notice of this.notices.values())
      if (notice.kind === "discarded" && notice.documentIds.includes(documentId)) return notice;
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
      left: null,
      status: "ready",
      leftOut: 0,
      ...this.subjectOf(input.parts),
      undo: () => this.undo(ownerKey, id),
      dismiss: () => this.endIf(ownerKey, id),
    });
    this.publish();
    return id;
  }

  /**
   * Where main landed after the Discard made it leave (`documentId` null: Recently opened).
   * Null: the writer moved first, so no place shows the notice, and its Undo ends.
   */
  landed(ownerKey: string, id: number, landing: { documentId: string | null } | null) {
    if (landing) this.update(ownerKey, id, () => ({ left: { landed: landing.documentId } }));
    else this.endIf(ownerKey, id);
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

  /** The writer left the project: its notices end, and the rooms their Undo held go. */
  endProject(projectId: string) {
    const leaving = [...this.notices.values()].filter((notice) => notice.projectId === projectId);
    for (const notice of leaving) this.drop(notice);
    if (leaving.length) this.publish();
  }

  close() {
    this.closed = true;
    for (const notice of [...this.notices.values()]) this.drop(notice);
    this.publish();
  }

  private async undo(ownerKey: string, id: number): Promise<"ok" | "unlisted" | "failed"> {
    const notice = this.notices.get(ownerKey);
    const parts = this.parts.get(id);
    if (notice?.id !== id || notice.kind !== "discarded" || notice.status === "undoing" || !parts)
      return "failed";
    this.update(ownerKey, id, () => ({ status: "undoing" }));
    // Retry takes back only the shares that failed: a share that undid has left the list. Every
    // room's share is taken back in this event turn; the server's answers come back.
    const answers = await Promise.all(
      [...parts].map(async (part) => ({ part, ...(await part.handle.undo()) })),
    );
    const leftOut = answers.reduce((sum, { leftOut: left = 0 }) => sum + left, 0);
    const listed = answers.flatMap(({ part, answer, landed }) =>
      answer !== "ok" ? [] : [part.undone ? part.undone(landed) : landed.then(() => true)],
    );
    const failed = answers.flatMap(({ part, answer }) => (answer === "failed" ? [part] : []));
    if (this.notices.get(ownerKey)?.id === id) {
      if (failed.length === 0 && leftOut > 0) {
        this.parts.set(id, []);
        this.update(ownerKey, id, () => ({ status: "partial", leftOut }));
      } else if (failed.length === 0) {
        this.notices.delete(ownerKey);
        this.parts.delete(id);
        this.publish();
      } else {
        this.parts.set(id, failed);
        this.update(ownerKey, id, () => ({ status: "failed", ...this.subjectOf(failed) }));
      }
    }
    if (failed.length) return "failed";
    // A view following the Undo waits until the server lists the draft again: a draft-only
    // document opened on a draft the list omits closes as discarded.
    return (await Promise.all(listed)).every(Boolean) ? "ok" : "unlisted";
  }

  private subjectOf(parts: readonly DiscardPart[]) {
    const [only] = parts;
    const count = parts.reduce((sum, part) => sum + (part.count ?? 1), 0);
    return {
      subject:
        count === 1 && only
          ? { kind: only.scope, name: only.name }
          : only?.scope === "deleted"
            ? { kind: "deletes" as const, count }
            : { kind: "drafts" as const, count },
      documentIds: parts.map((part) => part.documentId),
      review: (count === 1 && only?.review) || null,
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
