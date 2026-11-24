/**
 * One notice per draft (by its id): the draft's latest Discard with its
 * Undo, or the facts its latest Apply brought; and per project the writer's latest delete
 * (`deleteNoticeKey`), whose Undo is the sidebar's Undo step, for main's band or Recently opened
 * (the sidebar's rows say it themselves, `TreeNotice`). The account command owner holds
 * them, so a notice outlives the surface that made it; a reload starts with none.
 */
import type { PressEntries } from "./press-history";

export type NoticeSurface =
  | { kind: "changes" }
  | { kind: "strip"; threadId: string | null }
  /** A document's review band: the notice shows in that document's identity row. */
  | { kind: "band"; documentId: string }
  /** One change's card in a document: a Discard pressed there answers on the card, not the band. */
  | { kind: "card"; documentId: string }
  /** Where a delete made on main's Recently opened shows; the sidebar's rows carry their own. */
  | { kind: "landing" };

/** The key a project's delete notice is held under, beside the draft owners'. */
export const deleteNoticeKey = (projectId: string) => `delete:${projectId}`;

type NoticeSubject =
  /** `folder`: a folder's changes and everything listed under it. `deleted`: the writer's delete. */
  | { kind: "draft" | "change" | "folder" | "deleted"; name: string }
  | { kind: "drafts"; count: number }
  | { kind: "deletes"; count: number };

/**
 * What a Discard's answer says of the documents and folders it was sent: `untaken`, the ones it
 * found settled already (an earlier Discard's, or an Apply's). A notice lists only what it took.
 */
export type DiscardTook = { untaken: readonly string[] };

type DiscardUndoAnswer = { answer: "ok" | "failed" | "gone" };

/**
 * One share of a notice's Undo: a Discard the server ran, which the press's Undo takes back, or a
 * delete in the tree, which the tree's own Undo step takes back.
 */
export type DiscardUndo = {
  /**
   * Takes it back now. `ok` once it is back, with `landed` settling when the writer's own room
   * holds it; `gone`: nothing is left to take back.
   */
  undo(): DiscardUndoAnswer | Promise<DiscardUndoAnswer>;
  end(): void;
};

export type DiscardPart = {
  documentId: string;
  name: string;
  scope: "draft" | "change" | "folder" | "deleted";
  /** What it stands for: a whole draft's Discard is one share for all its drafts, a delete for all it took. */
  count?: number;
  /** Every document and folder the share brings back, when more than `documentId`. */
  covers?: readonly string[];
  handle: DiscardUndo;
};

type Base = { id: number; projectId: string; draftId: string; surface: NoticeSurface };

export type DraftNotice =
  | (Base & {
      kind: "discarded";
      subject: NoticeSubject;
      /** What the Discard took (its answer's word, once it came): the rows its Undo brings back. */
      documentIds: readonly string[];
      status: "ready" | "undoing";
      /** The Discard sent main away from the page it was made on; `landed` is where main went. */
      left: { landed: string | null } | null;
      undo(): Promise<void>;
      dismiss(): void;
    })
  | (Base & {
      kind: "applied";
      /** What the Apply did that the writer can't see from the rows alone, each on its document. */
      facts: readonly AppliedFact[];
      dismiss(): void;
    });

/**
 * One fact an Apply brought, about one document: it was applied where it was (`applied`, which
 * only its row's Undo shows), or landed somewhere new (`uri`). `step`: the Apply's Undo, while it
 * can be taken back.
 */
export type AppliedFact = { documentId: string; step?: PressEntries } & (
  | { kind: "applied"; name: string }
  | { kind: "landed"; uri: string; name: string }
);

type Discarded = Extract<DraftNotice, { kind: "discarded" }>;

export class DraftNotices {
  private readonly notices = new Map<string, DraftNotice>();
  /** A Discard notice's shares still holding an Undo. */
  private readonly parts = new Map<number, DiscardPart[]>();
  /** Notices whose Undo is in flight. */
  private readonly pressed = new Set<number>();
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

  get(draftId: string): DraftNotice | null {
    return this.notices.get(draftId) ?? null;
  }

  /**
   * The notice a document's identity row shows: a Discard made in a document's band, on that
   * document, or on the one main went back to when the Discard made it leave (null: Recently
   * opened, whose top slot shows it), or what an Undo made there left in place. A list or strip
   * keeps its own notice where it was made.
   */
  forDocument(projectId: string, documentId: string | null): DraftNotice | null {
    for (const notice of this.notices.values()) {
      if (notice.projectId !== projectId) continue;
      if (
        notice.kind === "discarded" &&
        (notice.surface.kind === "band"
          ? (notice.left ? notice.left.landed : notice.surface.documentId) === documentId
          : notice.surface.kind === "landing" && documentId === null)
      )
        return notice;
    }
    return null;
  }

  /** The Discard notice on one change card of `documentId` (`NoticeSurface` `card`). */
  forCard(projectId: string, documentId: string): DraftNotice | null {
    for (const notice of this.notices.values())
      if (
        notice.kind === "discarded" &&
        notice.projectId === projectId &&
        notice.surface.kind === "card" &&
        notice.surface.documentId === documentId
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
  end(draftId: string) {
    const notice = this.notices.get(draftId);
    if (!notice) return;
    this.drop(notice);
    this.publish();
  }

  showApplied(
    input: Omit<Extract<DraftNotice, { kind: "applied" }>, "id" | "kind" | "dismiss">,
  ): void {
    if (this.closed) return;
    const held = this.notices.get(input.draftId);
    if (held) this.drop(held);
    const id = this.nextId++;
    this.notices.set(input.draftId, {
      ...input,
      kind: "applied",
      id,
      dismiss: () => this.endIf(input.draftId, id),
    });
    this.publish();
  }

  /** The facts an Apply adds to the owner's applied notice, if it is the one showing. */
  appliedFacts(draftId: string) {
    const held = this.notices.get(draftId);
    return held?.kind === "applied" ? held : null;
  }

  showDiscard(input: {
    projectId: string;
    draftId: string;
    surface: NoticeSurface;
    parts: readonly DiscardPart[];
  }): number | null {
    if (this.closed || input.parts.length === 0) {
      for (const part of input.parts) part.handle.end();
      return null;
    }
    const held = this.notices.get(input.draftId);
    if (held) this.drop(held);
    const id = this.nextId++;
    this.parts.set(id, [...input.parts]);
    const { draftId } = input;
    this.notices.set(draftId, {
      kind: "discarded",
      id,
      projectId: input.projectId,
      draftId,
      surface: input.surface,
      left: null,
      status: "ready",
      ...this.subjectOf(input.parts),
      undo: () => this.undo(draftId, id),
      dismiss: () => this.endIf(draftId, id),
    });
    this.publish();
    return id;
  }

  /**
   * Where main landed after the Discard made it leave (`documentId` null: Recently opened).
   * Null: the writer moved first, so no place shows the notice, and its Undo ends.
   */
  landed(draftId: string, id: number, landing: { documentId: string | null } | null) {
    if (landing) this.update(draftId, id, () => ({ left: { landed: landing.documentId } }));
    else this.endIf(draftId, id);
  }

  /** A share's Undo ended on its own (refused or blocked): the notice stops naming it. */
  partEnded(handle: DiscardUndo) {
    for (const [id, parts] of this.parts) {
      const index = parts.findIndex((part) => part.handle === handle);
      if (index < 0) continue;
      parts.splice(index, 1);
      const notice = [...this.notices.values()].find((candidate) => candidate.id === id);
      if (notice?.kind !== "discarded" || notice.status === "undoing") return;
      this.notices.set(notice.draftId, { ...notice, ...this.subjectOf(parts) });
      this.publish();
      this.settle(notice.draftId, id);
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

  private async undo(draftId: string, id: number): Promise<void> {
    const notice = this.notices.get(draftId);
    const parts = this.parts.get(id);
    if (notice?.id !== id || notice.kind !== "discarded" || notice.status === "undoing" || !parts)
      return;
    this.pressed.add(id);
    this.settle(draftId, id);
    // Retry takes back only the shares still out: a share that undid leaves the list.
    const answers = await Promise.all(
      parts.map(async (part) => ({ part, ...(await part.handle.undo()) })),
    );
    const failed = answers.some(({ answer }) => answer === "failed");
    if (this.parts.has(id)) {
      this.parts.set(
        id,
        parts.filter(
          (part) =>
            (answers.find((answered) => answered.part === part)?.answer ?? "failed") === "failed",
        ),
      );
      this.pressed.delete(id);
      this.settle(draftId, id, failed);
    }
  }

  /** The notice as its shares stand: undoing while its Undo is out, gone once nothing is left. */
  private settle(draftId: string, id: number, narrow = false) {
    const notice = this.notices.get(draftId);
    const parts = this.parts.get(id);
    if (notice?.id !== id || notice.kind !== "discarded" || !parts) return;
    const status: Discarded["status"] | null = this.pressed.has(id)
      ? "undoing"
      : parts.length > 0
        ? "ready"
        : null;
    if (status === null) {
      this.forget(notice);
      this.publish();
      return;
    }
    const next = { ...notice, status, ...(narrow ? this.subjectOf(parts) : {}) };
    if (next.status === notice.status && next.subject === notice.subject) return;
    this.notices.set(draftId, next);
    this.publish();
  }

  private subjectOf(parts: readonly DiscardPart[]) {
    const [only] = parts;
    // A document's text and its move are two shares of one change: it counts once.
    const counted = new Set<string>();
    const count = parts.reduce((sum, part) => {
      if (part.count !== undefined) return sum + part.count;
      if (counted.has(part.documentId)) return sum;
      counted.add(part.documentId);
      return sum + 1;
    }, 0);
    return {
      subject:
        count === 1 && only
          ? { kind: only.scope, name: only.name }
          : only?.scope === "deleted"
            ? { kind: "deletes" as const, count }
            : { kind: "drafts" as const, count },
      documentIds: parts.flatMap((part) => part.covers ?? [part.documentId]),
    };
  }

  private update(
    draftId: string,
    id: number,
    patch: () => Partial<Extract<DraftNotice, { kind: "discarded" }>>,
  ) {
    const notice = this.notices.get(draftId);
    if (notice?.id !== id || notice.kind !== "discarded") return;
    this.notices.set(draftId, { ...notice, ...patch() });
    this.publish();
  }

  private endIf(draftId: string, id: number) {
    const notice = this.notices.get(draftId);
    if (notice?.id === id) this.end(draftId);
  }

  private drop(notice: DraftNotice) {
    const parts = this.parts.get(notice.id) ?? [];
    this.forget(notice);
    for (const part of parts) part.handle.end();
  }

  private forget(notice: DraftNotice) {
    this.notices.delete(notice.draftId);
    this.parts.delete(notice.id);
    this.pressed.delete(notice.id);
  }

  private publish() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}
