/**
 * One notice per draft owner (`work:<id>`, `lineage:<root>`): the owner's latest Discard with its
 * Undo, or the facts its latest Apply brought; and per project the writer's latest delete
 * (`deleteNoticeKey`), whose Undo is the sidebar's Undo step, for main's band or Recently opened
 * (the sidebar's rows say it themselves, `TreeNotice`). The account command owner holds
 * them, so a notice outlives the surface that made it; a reload starts with none.
 */
import type {
  ApplyClickResult,
  ApplyItemResult,
  UnapplyClickResult,
} from "@meridian/contracts/branches";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import type { ApplyEntries } from "./apply-history";
import type { DiscardRestores } from "./discard-restores";

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

export type NoticeSubject =
  /** `folder`: a folder's changes and everything listed under it. `deleted`: the writer's delete. */
  | { kind: "draft" | "change" | "folder" | "deleted"; name: string }
  | { kind: "drafts"; count: number }
  | { kind: "deletes"; count: number };

/** An Apply's answer for one item: each half landed or settled. */
export function itemOf(answer: ApplyClickResult, node: string): ApplyItemResult | undefined {
  return answer.items.find((item) => item.node === node);
}

/** Whether something of `node` landed, text or tree: `applied` alone says the command finished. */
export function itemLanded(answer: ApplyClickResult, node: string): boolean {
  const item = itemOf(answer, node);
  return item?.text?.landed === true || item?.tree?.landed === true;
}

/** The text groups of `node` an Un-Apply took back. */
export function textUndoneOf(answer: UnapplyClickResult, node: string): string[] {
  return answer.textUndone.find((text) => text.node === node)?.groupIds ?? [];
}

/** What of an Apply landed, command-wide: its Undo step's two halves. */
export type ApplyHalves = {
  text: boolean;
  tree: boolean;
  restores: string[];
};

export function halvesOf(answer: ApplyClickResult): ApplyHalves {
  return {
    text: answer.items.some((item) => item.text?.landed),
    tree: answer.items.some((item) => item.tree?.landed),
    restores: answer.items.flatMap((item) =>
      item.tree?.landed && item.tree.restore ? [item.tree.restore] : [],
    ),
  };
}

/**
 * What a Discard's answer says of the documents and folders it was sent: `untaken`, the ones it
 * found settled already (an earlier Discard's, or an Apply's). A notice lists only what it took.
 */
export type DiscardTook = { untaken: readonly string[] };

export type DiscardUndoAnswer = {
  answer: "ok" | "failed" | "gone";
  landed: Promise<void>;
};

/**
 * One share of a notice's Undo: a Discard the server ran, which its Restore command takes back, or
 * a delete in the tree, which the tree's own Undo step takes back.
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
  /** What it stands for: a whole branch's Discard is one share for all its drafts, a delete for all it took. */
  count?: number;
  /** Every document and folder the share brings back, when more than `documentId`. */
  covers?: readonly string[];
  handle: DiscardUndo;
  /**
   * The Discard the share takes back, by its command id: its progress is the one every view
   * reads (`DiscardRestores`), so a restore sent from Trash or the editor ends or answers the
   * notice too. A share without one is a delete in the tree, which `handle` takes back.
   */
  restore?: string;
  /** The draft's review, for the view to follow an Undo back to. */
  review?: ReviewFileTarget;
  /**
   * Right after this Discard's Undo, given its `landed`: the caller's caches catch up. Resolves
   * true once the server lists the draft again, so a view may open it.
   */
  undone?: (landed: Promise<void>) => Promise<boolean>;
};

type Base = { id: number; projectId: string; ownerKey: string; surface: NoticeSurface };

export type DraftNotice =
  | (Base & {
      kind: "discarded";
      subject: NoticeSubject;
      /** What the Discard took (its answer's word, once it came): the rows its Undo brings back. */
      documentIds: readonly string[];
      /** A single draft's review, which an Undo may return main to. */
      review: ReviewFileTarget | null;
      status: "ready" | "undoing";
      /** The Discard sent main away from the page it was made on; `landed` is where main went. */
      left: { landed: string | null } | null;
      /** `ok` once the server lists every restored draft again; `unlisted` if one never was. */
      undo(): Promise<"ok" | "unlisted" | "failed">;
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
export type AppliedFact = { documentId: string; step?: ApplyEntries } & (
  | { kind: "applied"; name: string }
  | { kind: "landed"; uri: string; name: string }
);

/** A notice with something to say on a line: a plain Apply's is said only on its rows. */
export const hasLine = (notice: DraftNotice): boolean =>
  notice.kind !== "applied" || notice.facts.some((fact) => fact.kind !== "applied");

type Discarded = Extract<DraftNotice, { kind: "discarded" }>;

export class DraftNotices {
  private readonly notices = new Map<string, DraftNotice>();
  /** A Discard notice's shares still holding an Undo. */
  private readonly parts = new Map<number, DiscardPart[]>();
  /** The notice's own Undo: in flight, or a tree share that failed. A Discard's progress is `DiscardRestores`'. */
  private readonly pressed = new Set<number>();
  private readonly listeners = new Set<() => void>();
  private nextId = 1;
  private revision = 0;
  private closed = false;

  constructor(private readonly restores: DiscardRestores) {
    restores.subscribe(() => {
      for (const notice of [...this.notices.values()])
        if (notice.kind === "discarded") this.settle(notice.ownerKey, notice.id);
    });
  }

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
      ...this.subjectOf(input.parts),
      undo: () => this.undo(ownerKey, id),
      dismiss: () => this.endIf(ownerKey, id),
    });
    this.publish();
    return id;
  }

  /**
   * What a Discard's answer says it took (`DiscardTook`): the share's rows it didn't take leave
   * the notice, and a notice left with nothing to bring back ends.
   */
  answered(handle: DiscardUndo, took: DiscardTook) {
    const untaken = new Set(took.untaken);
    for (const [id, parts] of this.parts) {
      const index = parts.findIndex((part) => part.handle === handle);
      const part = parts[index];
      if (!part) continue;
      const notice = [...this.notices.values()].find((candidate) => candidate.id === id);
      // An Undo in flight owns the notice until it answers, as `partEnded` leaves it.
      if (notice?.kind !== "discarded" || notice.status === "undoing") return;
      const covers = (part.covers ?? [part.documentId]).filter((node) => !untaken.has(node));
      if (covers.length === 0) {
        parts.splice(index, 1);
        part.handle.end();
      } else
        parts[index] = {
          ...part,
          covers,
          ...(part.count !== undefined ? { count: covers.length } : {}),
        };
      if (parts.length === 0) this.forget(notice);
      else {
        this.notices.set(notice.ownerKey, { ...notice, ...this.subjectOf(parts) });
        this.settle(notice.ownerKey, id);
      }
      this.publish();
      return;
    }
  }

  /**
   * Where main landed after the Discard made it leave (`documentId` null: Recently opened).
   * Null: the writer moved first, so no place shows the notice, and its Undo ends.
   */
  landed(ownerKey: string, id: number, landing: { documentId: string | null } | null) {
    if (landing) this.update(ownerKey, id, () => ({ left: { landed: landing.documentId } }));
    else this.endIf(ownerKey, id);
  }

  /** A share's Undo ended on its own (refused or blocked): the notice stops naming it. */
  partEnded(handle: DiscardUndo) {
    for (const [id, parts] of this.parts) {
      const index = parts.findIndex((part) => part.handle === handle);
      if (index < 0) continue;
      parts.splice(index, 1);
      const notice = [...this.notices.values()].find((candidate) => candidate.id === id);
      if (notice?.kind !== "discarded" || notice.status === "undoing") return;
      this.notices.set(notice.ownerKey, { ...notice, ...this.subjectOf(parts) });
      this.publish();
      this.settle(notice.ownerKey, id);
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
    this.pressed.add(id);
    this.settle(ownerKey, id);
    // Retry takes back only the shares still out: a tree share that undid leaves the list, and a
    // Discard's is done once its restore is.
    const answers = await Promise.all(
      this.outstanding(parts).map(async (part) => ({ part, ...(await part.handle.undo()) })),
    );
    const listed = answers.flatMap(({ part, answer, landed }) =>
      answer !== "ok" ? [] : [part.undone ? part.undone(landed) : landed.then(() => true)],
    );
    const treeFailed = answers.some(({ part, answer }) => !part.restore && answer === "failed");
    if (this.parts.has(id)) {
      this.parts.set(
        id,
        parts.filter(
          (part) =>
            part.restore ||
            (answers.find((answered) => answered.part === part)?.answer ?? "failed") === "failed",
        ),
      );
      this.pressed.delete(id);
      this.settle(ownerKey, id, treeFailed);
    }
    if (answers.some(({ answer }) => answer === "failed")) return "failed";
    if (listed.length === 0) return "unlisted";
    // A view following the Undo waits until the server lists the draft again: a draft-only
    // document opened on a draft the list omits closes as discarded.
    return (await Promise.all(listed)).every(Boolean) ? "ok" : "unlisted";
  }

  /** The shares an Undo still has to take back: every tree share left, and each Discard not yet back. */
  private outstanding(parts: readonly DiscardPart[]) {
    return parts.filter((part) => {
      const state = part.restore ? this.restores.state(part.restore) : undefined;
      return state?.kind !== "restored";
    });
  }

  /**
   * The notice as its shares stand: its own Undo, each server share's restore wherever it was sent,
   * and gone once everything is back.
   */
  private settle(ownerKey: string, id: number, narrow = false) {
    const notice = this.notices.get(ownerKey);
    const parts = this.parts.get(id);
    if (notice?.id !== id || notice.kind !== "discarded" || !parts) return;
    const restores = parts.flatMap((part) =>
      part.restore ? [this.restores.state(part.restore)] : [],
    );
    const out = this.outstanding(parts);
    const status: Discarded["status"] | null =
      this.pressed.has(id) || restores.some((state) => state?.kind === "restoring")
        ? "undoing"
        : out.length > 0
          ? "ready"
          : null;
    if (status === null) {
      this.forget(notice);
      this.publish();
      return;
    }
    const next = { ...notice, status, ...(narrow ? this.subjectOf(out) : {}) };
    if (next.status === notice.status && next.subject === notice.subject) return;
    this.notices.set(ownerKey, next);
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
    const parts = this.parts.get(notice.id) ?? [];
    this.forget(notice);
    for (const part of parts) part.handle.end();
  }

  private forget(notice: DraftNotice) {
    this.notices.delete(notice.ownerKey);
    this.parts.delete(notice.id);
    this.pressed.delete(notice.id);
  }

  private publish() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}
