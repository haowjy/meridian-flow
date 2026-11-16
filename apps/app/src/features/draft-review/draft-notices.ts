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
import {
  CLOSED_OWNER_WHYS,
  type ClosedOwnerWhy,
  type LeftOutWhy,
  type Settlement,
} from "@meridian/contracts/commands";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import type { ApplyStep, Left, TreeFact, Unapplied } from "@/core/project-tree/tree-undo";
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

/**
 * Why a restore came back with nothing done: the Work is archived or deleted (or its chat is in
 * Trash), or Trash no longer holds what the Discard took.
 */
export type RestoreReturned = "work-closed" | "chat-in-trash" | "gone-from-trash";

/**
 * What one settlement line says, for the screen. `already` and `restored` paint the result
 * quietly; `overtaken` names the command that settled the item first (the screen offers its
 * reverse); `left_out` says why part of it stayed out; `returned`: a closed owner answered and
 * changed nothing.
 */
export type SettledView =
  | { kind: "already"; state: string }
  | { kind: "restored" }
  | { kind: "overtaken"; state: string; by: string }
  | { kind: "left_out"; why: string }
  | { kind: "returned"; why: RestoreReturned };

/**
 * The one place a settlement becomes what is shown. Null: a `returned` whose reason names no
 * closed owner (a model's edit), which no command surface says.
 */
export function viewOf(one: Settlement): SettledView | null {
  switch (one.rule) {
    case "already":
      return { kind: "already", state: one.state };
    case "restored":
      return { kind: "restored" };
    case "overtaken":
      return { kind: "overtaken", state: one.state, by: one.by };
    case "left_out":
      return { kind: "left_out", why: one.why };
    case "returned":
      return (CLOSED_OWNER_WHYS as readonly string[]).includes(one.why)
        ? { kind: "returned", why: closedOwnerWord(one.why as ClosedOwnerWhy) }
        : null;
  }
}

/**
 * Every line of a flat answer (Discard, Restore, Un-Apply) that names `itemId`, or every line
 * when it is left out. A line that names no item is about the whole command and always counts.
 */
export function settledOf(
  settled: readonly Settlement[] | undefined,
  itemId?: string,
): SettledView[] {
  return (settled ?? []).flatMap((one) => {
    if (itemId !== undefined && !names(one, itemId)) return [];
    const view = viewOf(one);
    return view ? [view] : [];
  });
}

function names(one: Settlement, itemId: string): boolean {
  if (one.rule === "already" || one.rule === "overtaken")
    return one.item === undefined || one.item === itemId;
  if (one.rule === "restored") return one.documentId === itemId;
  if (one.rule === "left_out") return one.items.includes(itemId);
  return true;
}

/** Why a command was answered by a closed owner, from its lines; null when it wasn't. */
export function returnedIn(settled: readonly Settlement[] | undefined): RestoreReturned | null {
  for (const view of settledOf(settled)) if (view.kind === "returned") return view.why;
  return null;
}

/** An Apply's answer for one item: each half landed or settled. */
export function itemOf(answer: ApplyClickResult, node: string): ApplyItemResult | undefined {
  return answer.items.find((item) => item.node === node);
}

/**
 * What of an Apply landed, command-wide: its Undo step's two halves, and what the tree half did
 * to each node it landed on, from where live had it before and after (`did`).
 */
export type ApplyHalves = {
  text: boolean;
  tree: boolean;
  restores: string[];
  did: Record<string, TreeFact["did"]>;
};

export function halvesOf(answer: ApplyClickResult): ApplyHalves {
  return {
    did: Object.fromEntries(
      answer.items.flatMap((item) => (item.tree?.landed ? [[item.node, didOf(item)]] : [])),
    ),
    text: answer.items.some((item) => item.text?.landed),
    tree: answer.items.some((item) => item.tree?.landed),
    restores: answer.items.flatMap((item) =>
      item.tree?.landed && item.tree.restore ? [item.tree.restore] : [],
    ),
  };
}

/**
 * What an Un-Apply took back, the one place its answer becomes what every surface says. Something
 * taken back with nothing left or held is `all`; with something left or held, `partly`; nothing
 * taken back but something left or held, `nothing`; neither, `already` (the server's `already
 * unapplied`). Each node a `left_out` line names keeps that line's reason (`treeLeft`), read here,
 * not through `settledOf`, whose views drop the nodes they name. `held` is what stayed for a closed
 * owner, as the answer says it; an answer stored before it had one holds nothing.
 */
export function unappliedOf(answer: UnapplyClickResult): Unapplied {
  const took = answer.reversedGroupIds.length > 0 || answer.treeUndone.length > 0;
  const treeLeft = new Map<string, LeftOutWhy>();
  for (const one of answer.settled ?? [])
    if (one.rule === "left_out")
      for (const node of one.items) if (!treeLeft.has(node)) treeLeft.set(node, one.why);
  const held = answer.held ?? [];
  const stayed = treeLeft.size > 0 || held.length > 0;
  return {
    taken: took ? (stayed ? "partly" : "all") : stayed ? "nothing" : "already",
    treeLeft: [...treeLeft].map(([node, why]) => ({ node, why })),
    held,
  };
}

function didOf(item: ApplyItemResult): TreeFact["did"] {
  const tree = item.tree;
  if (tree?.restore || tree?.settled?.some((one) => one.rule === "restored")) return "restored";
  const { from, to } = tree?.transition ?? { from: undefined, to: undefined };
  if (from === undefined) return null;
  if (from === null) return "created";
  if (to === null || to === undefined) return "deleted";
  const parent = (uri: string) => uri.replace(/\/?[^/]*\/?$/, "");
  return parent(from) === parent(to) && from !== to ? "renamed" : "moved";
}

/** The word a closed owner's reason (a `returned` settlement's, or a read-only room's) gives a notice. */
export function closedOwnerWord(why: ClosedOwnerWhy): RestoreReturned {
  return why === "chat_frozen" ? "chat-in-trash" : "work-closed";
}

/**
 * What a Discard's answer says of the documents and folders it was sent: `untaken`, the ones it
 * found settled already (an earlier Discard's, quietly, or an Apply's), and of those
 * `appliedFirst`, the ones an Apply took before it. A notice lists only what it took.
 */
export type DiscardTook = { untaken: readonly string[]; appliedFirst: readonly string[] };

export type DiscardUndoAnswer = {
  /** `returned`: the restore was answered and did nothing, for `why`. */
  answer: "ok" | "failed" | "gone" | "returned";
  landed: Promise<void>;
  /** What the Discard held that could not come back (`UndoDiscardResult.leftOut`). */
  leftOut?: number;
  why?: RestoreReturned;
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
  /** Every document and folder the share brings back, when more than `documentId`. */
  covers?: readonly string[];
  handle: DiscardUndo;
  /**
   * The server Discard the share takes back, by its command id: its progress is the one every view
   * reads (`DiscardRestores`), so a restore sent from Trash or the editor ends or answers the
   * notice too.
   */
  restore?: string;
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
      /** What the Discard took (its answer's word, once it came): the rows its Undo brings back. */
      documentIds: readonly string[];
      /** What it was sent that an Apply took first: each says so where the writer pressed. */
      appliedFirst: readonly string[];
      /** A single draft's review, which an Undo may return main to. */
      review: ReviewFileTarget | null;
      /**
       * `partial`: the Undo landed, but `leftOut` of what the Discard held could not come back.
       * `returned`: the Undo was answered with nothing done, for `returned`. `bounced`: the
       * Discard itself discarded nothing, because a closed owner returned it (`returned`) or an
       * Apply took all of it first (`appliedFirst`); no Undo, and it ends after `BOUNCE_SHOWN_MS`.
       */
      status: "ready" | "undoing" | "failed" | "partial" | "returned" | "bounced";
      leftOut: number;
      returned: RestoreReturned | null;
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
    })
  | (Base & {
      /**
       * What Ctrl+Z on an Apply in an editor said, on that document: what stayed (`left`), or that
       * the Un-Apply didn't reach the server, with its Retry.
       */
      kind: "unapplied";
      said: { kind: "left"; left: Left } | { kind: "failed"; name: string; retry(): void };
      dismiss(): void;
    });

/** An Apply's Undo: its step on the sidebar's Undo stack (`undoApply`), over `count` changes. */
export type AppliedUndo = { undo: () => void; count: number };

/**
 * One fact an Apply brought, about one document: it was applied where it was (`applied`, which
 * only its row says), landed somewhere new (`uri`), came back to its area (`scheme`, its source),
 * or was applied along with the documents picked
 * (`also`: its old and new names). `step`: the Apply's Undo, while it can be taken back.
 */
export type AppliedFact = { documentId: string; step?: AppliedUndo } & (
  | { kind: "applied"; name: string; scheme: ProjectContextTreeScheme | null }
  | { kind: "landed"; uri: string; name: string }
  | { kind: "restored"; name: string; scheme: ProjectContextTreeScheme | null }
  | { kind: "also"; from: string; to: string }
);

/** A notice with something to say on a line: a plain Apply's is said only on its rows. */
export const hasLine = (notice: DraftNotice): boolean =>
  notice.kind === "applied"
    ? notice.facts.some((fact) => fact.kind !== "applied")
    : notice.kind === "unapplied" || notice.status !== "bounced";

const BOUNCE_SHOWN_MS = 6_000;

type Discarded = Extract<DraftNotice, { kind: "discarded" }>;

export class DraftNotices {
  private readonly notices = new Map<string, DraftNotice>();
  /** A Discard notice's shares still holding an Undo. */
  private readonly parts = new Map<number, DiscardPart[]>();
  /**
   * The notice's own Undo: in flight, or a room's share that failed. A server share's progress is
   * `DiscardRestores`'.
   */
  private readonly pressed = new Map<number, "undoing" | "failed">();
  private readonly bounceTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Where a Discard notice says it discarded nothing, when not where it shows (`bounceSurface`). */
  private readonly bounceTo = new Map<number, NoticeSurface>();
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
        notice.kind === "unapplied" &&
        notice.projectId === projectId &&
        notice.surface.kind === "band" &&
        notice.surface.documentId === documentId
      )
        return notice;
      else if (
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

  /**
   * What Ctrl+Z on an Apply in `documentId`'s editor answered, on that document's identity row:
   * what stayed, or that it didn't go through. Taken back whole, the text says it.
   */
  showPress(input: {
    projectId: string;
    ownerKey: string;
    documentId: string;
    step: ApplyStep & { press(from: null): Promise<unknown> };
    answer: Unapplied | { taken: "failed" };
  }): void {
    const { step, answer } = input;
    if (this.closed || answer.taken === "all" || answer.taken === "already") return;
    const held = this.notices.get(input.ownerKey);
    if (held) this.drop(held);
    const id = this.nextId++;
    this.notices.set(input.ownerKey, {
      kind: "unapplied",
      id,
      projectId: input.projectId,
      ownerKey: input.ownerKey,
      surface: { kind: "band", documentId: input.documentId },
      said:
        answer.taken === "failed"
          ? { kind: "failed", name: step.name, retry: () => void step.press(null) }
          : {
              kind: "left",
              left: { ...answer, name: step.name, nodes: step.nodes, facts: step.facts },
            },
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
    /** Where it says it discarded nothing, as a closed owner's bounce would (a change card's). */
    bounceSurface?: NoticeSurface;
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
    if (input.bounceSurface) this.bounceTo.set(id, input.bounceSurface);
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
      returned: null,
      appliedFirst: [],
      ...this.subjectOf(input.parts),
      undo: () => this.undo(ownerKey, id),
      dismiss: () => this.endIf(ownerKey, id),
    });
    this.publish();
    return id;
  }

  /**
   * A Discard that came back with nothing changed, for `why`: the chip on the control pressed,
   * for a few seconds. `documentIds` are the rows the press named.
   */
  showBounce(input: {
    projectId: string;
    ownerKey: string;
    surface: NoticeSurface;
    documentIds: readonly string[];
    why: RestoreReturned;
  }): void {
    if (this.closed) return;
    const held = this.notices.get(input.ownerKey);
    if (held) this.drop(held);
    this.bounce({
      id: this.nextId++,
      projectId: input.projectId,
      ownerKey: input.ownerKey,
      surface: input.surface,
      documentIds: input.documentIds,
      appliedFirst: [],
      returned: input.why,
    });
  }

  /**
   * What a Discard's answer says it took (`DiscardTook`): the share's rows it didn't take leave
   * the notice, and the ones an Apply took first say so. A notice left with nothing to bring back
   * but something applied first says only that, as a bounce does.
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
      const appliedFirst = [...new Set([...notice.appliedFirst, ...took.appliedFirst])];
      if (parts.length === 0) {
        const surface = this.bounceTo.get(id) ?? notice.surface;
        this.parts.delete(id);
        this.bounceTo.delete(id);
        this.pressed.delete(id);
        if (appliedFirst.length === 0) this.notices.delete(notice.ownerKey);
        else
          this.bounce({
            id,
            projectId: notice.projectId,
            ownerKey: notice.ownerKey,
            surface,
            documentIds: [],
            appliedFirst,
            returned: null,
          });
      } else
        this.notices.set(notice.ownerKey, { ...notice, appliedFirst, ...this.subjectOf(parts) });
      this.publish();
      return;
    }
  }

  private bounce(input: {
    id: number;
    projectId: string;
    ownerKey: string;
    surface: NoticeSurface;
    documentIds: readonly string[];
    appliedFirst: readonly string[];
    returned: RestoreReturned | null;
  }) {
    const { id, ownerKey } = input;
    this.notices.set(ownerKey, {
      kind: "discarded",
      id,
      projectId: input.projectId,
      ownerKey,
      surface: input.surface,
      subject: { kind: "drafts", count: input.documentIds.length },
      documentIds: input.documentIds,
      appliedFirst: input.appliedFirst,
      review: null,
      left: null,
      status: "bounced",
      leftOut: 0,
      returned: input.returned,
      undo: async () => "failed",
      dismiss: () => this.endIf(ownerKey, id),
    });
    this.bounceTimers.set(
      id,
      setTimeout(() => this.endIf(ownerKey, id), BOUNCE_SHOWN_MS),
    );
    this.publish();
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
        this.bounceTo.delete(id);
        this.pressed.delete(id);
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
    this.pressed.set(id, "undoing");
    this.settle(ownerKey, id);
    // Retry takes back only the shares still out: a room's share that undid leaves the list, and a
    // server's is done once its restore is. Every room's share is taken back in this event turn;
    // the server's answers come back.
    const answers = await Promise.all(
      this.outstanding(parts).map(async (part) => ({ part, ...(await part.handle.undo()) })),
    );
    const listed = answers.flatMap(({ part, answer, landed }) =>
      answer !== "ok" ? [] : [part.undone ? part.undone(landed) : landed.then(() => true)],
    );
    const roomFailed = answers.some(({ part, answer }) => !part.restore && answer === "failed");
    if (this.parts.has(id)) {
      this.parts.set(
        id,
        parts.filter(
          (part) =>
            part.restore ||
            (answers.find((answered) => answered.part === part)?.answer ?? "failed") === "failed",
        ),
      );
      if (roomFailed) this.pressed.set(id, "failed");
      else this.pressed.delete(id);
      this.settle(ownerKey, id);
    }
    if (answers.some(({ answer }) => answer === "failed")) return "failed";
    if (listed.length === 0) return "unlisted";
    // A view following the Undo waits until the server lists the draft again: a draft-only
    // document opened on a draft the list omits closes as discarded.
    return (await Promise.all(listed)).every(Boolean) ? "ok" : "unlisted";
  }

  /** The shares an Undo still has to take back: every room's left, and each server's not yet back. */
  private outstanding(parts: readonly DiscardPart[]) {
    return parts.filter((part) => {
      const state = part.restore ? this.restores.state(part.restore) : undefined;
      return state?.kind !== "restored" && state?.kind !== "returned";
    });
  }

  /**
   * The notice as its shares stand: its own Undo, each server share's restore wherever it was sent,
   * and gone once everything is back.
   */
  private settle(ownerKey: string, id: number) {
    const notice = this.notices.get(ownerKey);
    const parts = this.parts.get(id);
    if (notice?.id !== id || notice.kind !== "discarded" || !parts) return;
    const restores = parts.flatMap((part) =>
      part.restore ? [this.restores.state(part.restore)] : [],
    );
    const pressed = this.pressed.get(id);
    const returned = restores.find((state) => state?.kind === "returned");
    const leftOut = restores.reduce(
      (sum, state) => sum + (state?.kind === "restored" ? state.leftOut : 0),
      0,
    );
    const out = this.outstanding(parts);
    const status: Discarded["status"] | null =
      pressed === "undoing" || restores.some((state) => state?.kind === "restoring")
        ? "undoing"
        : pressed === "failed" || restores.some((state) => state?.kind === "failed")
          ? "failed"
          : returned
            ? "returned"
            : out.length > 0
              ? "ready"
              : leftOut > 0
                ? "partial"
                : null;
    if (status === null) {
      this.notices.delete(ownerKey);
      this.parts.delete(id);
      this.bounceTo.delete(id);
      this.pressed.delete(id);
      this.publish();
      return;
    }
    const next = {
      ...notice,
      status,
      leftOut,
      returned: returned?.kind === "returned" ? returned.why : null,
      ...(status === "failed" ? this.subjectOf(out) : {}),
    };
    if (
      next.status === notice.status &&
      next.leftOut === notice.leftOut &&
      next.returned === notice.returned &&
      next.subject === notice.subject
    )
      return;
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
    this.notices.delete(notice.ownerKey);
    const parts = this.parts.get(notice.id) ?? [];
    this.parts.delete(notice.id);
    this.pressed.delete(notice.id);
    clearTimeout(this.bounceTimers.get(notice.id));
    this.bounceTimers.delete(notice.id);
    this.bounceTo.delete(notice.id);
    for (const part of parts) part.handle.end();
  }

  private publish() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}
