/**
 * Apply compilation and command identity. A frozen cut is the writer's click on their room; a
 * whole cut is the server's replica on receipt. No live state or locks enter either.
 */
import type { StoredDelta } from "@meridian/agent-edit/content-merge";
import {
  type ApplyEntry,
  applySpanPatches,
  composeHunks,
  diffBlocks,
  type Hunk,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  type ReviewGroup,
  readBlocks,
  type SpanPatch,
  UnknownChangeError,
  validateSpanPatches,
} from "@meridian/agent-edit/diff";
import type {
  ApplyClickAnswer,
  ApplyClickResult,
  ApplySpanPatch,
  ApplyTextCut,
  UnapplyClickAnswer,
  UnapplyClickResult,
} from "@meridian/contracts/branches";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import * as Y from "yjs";
import { CommandExistsError, replay } from "../../../shared/commands/command-record.js";
import { testHook } from "../../../shared/test-hooks.js";
import type { CollabBranches } from "../contracts.js";
import type { DocumentCommands } from "./document-commands.js";
import { carriedBy, readChangesAt, draftSchema as schema } from "./draft-changes.js";
import type { DraftBase } from "./draft-runtime.js";
import type { DraftDispositionStore } from "./ports/draft-disposition-store.js";

export type ApplyCommand = Parameters<CollabBranches["draftReview"]["apply"]>[0];
/**
 * A press's cut as the route decoded it: per list, the list's journal id and the state vector
 * the draft list read. A scope left out is the server's own cut.
 */
export type TreeCut = {
  project?: { list: string; vector: Uint8Array };
  account?: { list: string; vector: Uint8Array };
};
type UnapplyClickCommand = Parameters<CollabBranches["draftReview"]["unapplyClick"]>[0];
/** What an Un-Apply takes back: the Apply's text effects on each document it wrote, and its tree half. */
export type PreparedUnapply = {
  branchId: import("@meridian/contracts").BranchId;
  /** One per document the Apply wrote text in, by document id; empty for a tree-only Apply. */
  texts: {
    /** The draft the effects were written in; it may be closed, on another branch, or purged. */
    draftId: string;
    documentId: import("@meridian/contracts").DocumentId;
    effects: {
      ordinal: number;
      groupId: string;
      /** What the group changed in the manuscript; null when it already held the text. */
      liveDelta: StoredDelta | null;
      baseBefore: unknown[];
      baseAfter: unknown[];
    }[];
  }[];
  /** One per list the Apply settled records in: the list's state vector it left. */
  trees: {
    scope: "project" | "account";
    mark: Uint8Array;
    createdHeads: Record<string, { live: number; draft: number }>;
    /** The live restore records the Apply made in this list. */
    restored: string[];
  }[];
};
export type CompiledClick = {
  schema: import("prosemirror-model").Schema;
  /** Empty only for a whole cut whose draft had no change on receipt: the item's text is skipped. */
  groups: CompiledApplyGroup[];
};
/**
 * One selected group, as a step of a chain: `before` is the base with the click's earlier groups
 * applied (the optimistic base for the first), `patched` that with this group applied too. Merging
 * each step into live in turn applies the click once; every step merged against the same base would
 * see its sibling groups as concurrent changes.
 */
type CompiledApplyGroup = {
  groupId: string;
  before: readonly PMNode[];
  patched: readonly PMNode[];
  /** The draft's record of the Apply: which command took the group (the browser's queue reads it). */
  record: ApplyEntry;
  /** The changes of AI edits that sat in this group, as `[partId, index]`, on the draft as the click found it. */
  carried: [number, number][];
  /** Where the group sat (`placeOf`). */
  place: string;
};
/**
 * One item of an Apply with its cuts prepared: the text compiled against the draft's replica.
 * `closedDraftId` names a text cut whose draft could not be read (closed, replaced, purged): the
 * store says what became of it.
 */
export type PreparedApplyItem = {
  node: string;
  tree: boolean;
  text: { base: DraftBase; click: CompiledClick } | null;
  closedDraftId?: string;
};
export interface ApplyCommandStore {
  loadBase(input: {
    draftId: string;
    documentId: string;
    branchId: import("@meridian/contracts").BranchId;
  }): Promise<DraftBase | null>;
  /**
   * Applies the command's cuts in one transaction: the tree cuts first (the moves, deletes and
   * creations), then each item's text cut at the result. Every item comes back once, each half
   * landed or settled on its own evidence.
   */
  apply(
    command: ApplyCommand,
    items: readonly PreparedApplyItem[],
    saw: TreeCut | undefined,
  ): Promise<ApplyClickAnswer>;
  /** What the Apply left to take back; null when it left nothing (taken back before, or not this account's). */
  loadUnapply(command: UnapplyClickCommand): Promise<PreparedUnapply | null>;
  unapply(
    command: UnapplyClickCommand,
    prepared: PreparedUnapply | null,
  ): Promise<UnapplyClickAnswer>;
  measured?(input: { commandId: string; compileClickMs: number }): void;
}

/** Undo of a Discard's `not_found`: B4 settles it, and this goes with it. */
export class ApplyClickRefused extends Error {
  constructor(readonly reason: "not_found") {
    super(reason);
  }
}

/** The click's snapshot, patches or groups are not what a client builds: a 400, nothing stored. */
export class ApplyClickMalformed extends Error {}

/**
 * The click's cut is ahead of what the server holds (a room's unacknowledged changes, or tree
 * records not synced yet): a 503, nothing stored, and the client resends the same command.
 */
export class ApplyClickUnsynced extends Error {}

/** Snapshot containment includes tombstones: a delete-only key must have been acknowledged too. */
export function containsSnapshot(current: Y.Snapshot, clicked: Y.Snapshot): boolean {
  for (const [client, clock] of clicked.sv) if (clock > (current.sv.get(client) ?? 0)) return false;
  return Y.equalDeleteSets(current.ds, Y.mergeDeleteSets([current.ds, clicked.ds]));
}

export function decodeClickedSnapshot(encoded: string): Y.Snapshot {
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new Error("Invalid base64");
    return Y.decodeSnapshotV2(bytes);
  } catch {
    throw new ApplyClickMalformed();
  }
}

/** A change's hash and the id of the first block it touches: an equal change elsewhere has another. */
function placeOf(projection: ReturnType<typeof projectReview>, group: ReviewGroup): string {
  const [span] = group.spans;
  const { base, draft } = projection.diff;
  const block = draft.blocks[span.draft.from] ?? base.blocks[span.base.from];
  return `${group.id.replace(/~\d+$/, "")}@${block?.attrs.id}`;
}

/**
 * The review a writer acted on: the base and text of `doc` at their room's snapshot (the replica
 * as it is, for null), with their tab's Applies still in flight (`baseViewDelta`) laid over the
 * base, as the review they saw showed it. Apply and Discard name changes in it, so an id means
 * the same change to both. A snapshot the replica doesn't hold yet is `ApplyClickUnsynced`.
 */
export function readSeen(
  doc: Y.Doc,
  encoded: string | null,
  baseViewDelta: readonly ApplySpanPatch[],
): { base: readonly PMNode[]; text: readonly PMNode[] } {
  const snapshot = encoded === null ? null : decodeClickedSnapshot(encoded);
  if (snapshot && !containsSnapshot(Y.snapshot(doc), snapshot)) throw new ApplyClickUnsynced();
  const cut =
    snapshot && !Y.equalSnapshots(Y.snapshot(doc), snapshot)
      ? Y.createDocFromSnapshot(doc, snapshot, new Y.Doc({ gc: false }))
      : doc;
  try {
    const base = readBlocks(cut.getXmlFragment(REVIEW_BASE_FRAGMENT), schema);
    let patches: SpanPatch[];
    try {
      patches = baseViewDelta.map((patch) => ({
        ...patch,
        blocks: patch.blocks.map((node) => schema.nodeFromJSON(node)),
      }));
      if (validateSpanPatches(schema, base, patches)) throw new Error("Invalid patches");
    } catch {
      throw new ApplyClickMalformed();
    }
    return {
      base: applySpanPatches(base, patches, "base"),
      text: readBlocks(cut.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema),
    };
  } finally {
    if (cut !== doc) cut.destroy();
  }
}

export function compileClick(
  doc: Y.Doc,
  request: ApplyTextCut & { commandId: string },
  parts: readonly {
    id: number;
    delta: import("@meridian/agent-edit/content-merge").StoredDelta | null;
  }[],
): CompiledClick {
  const { base: optimistic, text: draftText } =
    "whole" in request
      ? readSeen(doc, null, [])
      : readSeen(doc, request.snapshot, request.baseViewDelta);
  const projection = projectReview(diffBlocks(optimistic, draftText));
  const reading = readChangesAt(optimistic, draftText, parts);
  let groupIds: readonly string[];
  if ("whole" in request) {
    const places = request.places && new Set(request.places);
    const carried = request.carried && new Set(request.carried.map((key) => key.join(":")));
    const named = places || carried;
    // A group is re-applied by `carried` only while every AI change in it is one the Un-Apply took:
    // a neighbour the writer never chose stays in Changes.
    groupIds = projection.groups.flatMap((group, position) => {
      const keys = carriedBy(reading, position);
      if (!named || (!keys.length && places?.has(placeOf(projection, group)))) return [group.id];
      return carried && keys.length > 0 && keys.every((key) => carried.has(key.join(":")))
        ? [group.id]
        : [];
    });
    if (groupIds.length === 0) return { schema, groups: [] };
  } else groupIds = request.groupIds;
  if (!groupIds.length || new Set(groupIds).size !== groupIds.length)
    throw new ApplyClickMalformed();
  const chosen: Hunk[] = [];
  let before = optimistic;
  const groups = groupIds.map((groupId): CompiledApplyGroup => {
    const group = projection.groups.find((candidate) => candidate.id === groupId);
    if (!group) throw new UnknownChangeError(`Unknown change ${groupId}`);
    chosen.push(...group.hunks.map((hunk) => projection.diff.hunks[hunk.index]));
    const patched = applySpanPatches(
      optimistic,
      composeHunks(schema, projection.diff, chosen, "apply"),
      "base",
    );
    const step = {
      groupId,
      before,
      patched,
      record: { base: [], settled: [], commandId: request.commandId, groupId },
      carried: carriedBy(
        reading,
        projection.groups.findIndex((candidate) => candidate.id === groupId),
      ),
      place: placeOf(projection, group),
    };
    before = patched;
    return step;
  });
  return { schema, groups };
}

export function createApplyClickService(input: {
  commands: DocumentCommands;
  evidence: DraftDispositionStore;
  store: ApplyCommandStore;
}) {
  const apply = async (command: ApplyCommand): Promise<ApplyClickAnswer> => {
    const { commandId } = command.envelope;
    const lookup = async (): Promise<ApplyClickAnswer | null> =>
      replay<ApplyClickResult>(await input.commands.lookup(command.envelope), commandId);
    const first = await lookup();
    if (first) return first;
    await testHook("apply.beforeCompile");
    try {
      const { items } = command.request;
      const prepared: PreparedApplyItem[] = [];
      for (const item of items) {
        const tree = item.tree === true;
        const cut = item.text;
        if (!cut) {
          // A tree cut alone: a move, a delete or a creation with no text room (design-v2 §4).
          if (!tree) throw new ApplyClickMalformed();
          prepared.push({ node: item.node, tree, text: null });
          continue;
        }
        if (!("whole" in cut) && !cut.groupIds.length) throw new ApplyClickMalformed();
        const start = performance.now();
        const base = await input.store.loadBase({
          draftId: cut.draftId,
          documentId: item.node,
          branchId: command.branchId,
        });
        // Receipts are captured after this replica, so they cover every item a contained click can name.
        const captured = base ? await input.evidence.capture(cut.draftId) : null;
        if (!base || !captured) {
          prepared.push({ node: item.node, tree, text: null, closedDraftId: cut.draftId });
          continue;
        }
        let click: CompiledClick;
        try {
          click = compileClick(base.replica.doc, { ...cut, commandId }, captured.parts);
        } finally {
          input.store.measured?.({ commandId, compileClickMs: performance.now() - start });
        }
        prepared.push({ node: item.node, tree, text: { base, click } });
      }
      return await input.store.apply(command, prepared, command.saw);
    } catch (cause) {
      // A twin that already stored its answer wins over a refusal to start (LA-1).
      if (
        cause instanceof CommandExistsError ||
        cause instanceof ApplyClickMalformed ||
        cause instanceof UnknownChangeError ||
        cause instanceof ApplyClickUnsynced
      ) {
        const winner = await lookup();
        if (winner) return winner;
      }
      throw cause;
    }
  };
  const unapply = async (command: UnapplyClickCommand): Promise<UnapplyClickAnswer> => {
    const commandId = command.envelope.commandId;
    const lookup = async (): Promise<UnapplyClickAnswer | null> =>
      replay<UnapplyClickResult>(await input.commands.lookup(command.envelope), commandId);
    const first = await lookup();
    if (first) return first;
    try {
      const prepared = await input.store.loadUnapply(command);
      return await input.store.unapply(command, prepared);
    } catch (cause) {
      if (cause instanceof CommandExistsError) {
        const winner = await lookup();
        if (winner) return winner;
      }
      throw cause;
    }
  };
  return { apply, unapply };
}
