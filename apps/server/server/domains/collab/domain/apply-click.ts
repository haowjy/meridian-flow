/** Frozen Apply compilation and command identity: no live state or locks enter the clicked cut. */
import {
  type ApplyEntry,
  applyRecordOf,
  applySpanPatches,
  classifyChanges,
  composeHunks,
  diffBlocks,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  type SpanPatch,
  validateSpanPatches,
} from "@meridian/agent-edit/diff";
import type {
  ApplyClickAnswer,
  ApplyClickRefusalReason,
  ApplyClickResult,
  ApplyTextCut,
  UnapplyClickAnswer,
  UnapplyClickResult,
} from "@meridian/contracts/branches";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import * as Y from "yjs";
import { testHook } from "../../../shared/test-hooks.js";
import type { CollabBranches } from "../contracts.js";
import { DocumentCommandExistsError, type DocumentCommands, replay } from "./document-commands.js";
import type { DraftBase } from "./draft-runtime.js";
import type { DraftDispositionStore } from "./ports/draft-disposition-store.js";

export type ApplyCommand = Parameters<CollabBranches["draftReview"]["apply"]>[0];
type UnapplyClickCommand = Parameters<CollabBranches["draftReview"]["unapplyClick"]>[0];
/** What an Un-Apply takes back: the Apply's text effects on each document it wrote, and its tree half. */
export type PreparedUnapply = {
  branchId: import("@meridian/contracts").BranchId;
  /** One per document the Apply wrote text in, by document id; empty for a tree-only Apply. */
  texts: {
    base: DraftBase;
    documentId: import("@meridian/contracts").DocumentId;
    effects: {
      ordinal: number;
      groupId: string;
      liveUpdateSeq: number | null;
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
  optimistic: readonly PMNode[];
  patched: readonly PMNode[];
  groups: CompiledApplyGroup[];
};
type CompiledApplyGroup = {
  groupId: string;
  patched: readonly PMNode[];
  record: ApplyEntry;
};
/** One item of an Apply with its cuts prepared: the text compiled against the draft's replica. */
export type PreparedApplyItem = {
  node: string;
  tree: TreeCut | null;
  text: { base: DraftBase; click: CompiledClick } | null;
};
export interface ApplyCommandStore {
  loadBase(input: {
    draftId: string;
    documentId: string;
    branchId: import("@meridian/contracts").BranchId;
  }): Promise<DraftBase | null>;
  /**
   * Applies exactly the command's cuts in one transaction: the tree cuts first (the moves,
   * deletes and creations their frozen revisions hold), then each item's text cut at the result.
   */
  apply(command: ApplyCommand, items: readonly PreparedApplyItem[]): Promise<ApplyClickAnswer>;
  loadUnapply(command: UnapplyClickCommand): Promise<PreparedUnapply | null>;
  unapply(command: UnapplyClickCommand, prepared: PreparedUnapply): Promise<UnapplyClickAnswer>;
  measured?(input: { commandId: string; compileClickMs: number }): void;
}
/** The branch row revision a click froze. */
export type TreeCut = { revision: string | null };
const schema = buildDocumentSchema();

export class ApplyClickRefused extends Error {
  constructor(readonly reason: ApplyClickRefusalReason) {
    super(reason);
  }
}

/** Snapshot containment includes tombstones: a delete-only key must have been acknowledged too. */
function containsSnapshot(current: Y.Snapshot, clicked: Y.Snapshot): boolean {
  for (const [client, clock] of clicked.sv) if (clock > (current.sv.get(client) ?? 0)) return false;
  return Y.equalDeleteSets(current.ds, Y.mergeDeleteSets([current.ds, clicked.ds]));
}

export function compileClick(
  doc: Y.Doc,
  request: ApplyTextCut & { commandId: string },
  provenance: {
    userId: string;
    parts: import("@meridian/agent-edit/diff").Provenance["parts"];
  },
): CompiledClick {
  let snapshot: Y.Snapshot;
  try {
    if (!request.snapshot) throw new Error("Missing snapshot");
    const bytes = Buffer.from(request.snapshot, "base64");
    if (bytes.toString("base64") !== request.snapshot) throw new Error("Invalid base64");
    snapshot = Y.decodeSnapshotV2(bytes);
  } catch {
    throw new ApplyClickRefused("malformed");
  }
  const current = Y.snapshot(doc);
  if (!containsSnapshot(current, snapshot)) throw new ApplyClickRefused("unsynced");
  const cut = Y.equalSnapshots(current, snapshot)
    ? doc
    : Y.createDocFromSnapshot(doc, snapshot, new Y.Doc({ gc: false }));
  try {
    const base = readBlocks(cut.getXmlFragment(REVIEW_BASE_FRAGMENT), schema);
    let patches: SpanPatch[];
    try {
      patches = request.baseViewDelta.map((patch) => ({
        ...patch,
        blocks: patch.blocks.map((node) => schema.nodeFromJSON(node)),
      }));
      if (validateSpanPatches(schema, base, patches)) throw new Error("Invalid patches");
    } catch {
      throw new ApplyClickRefused("malformed");
    }
    const optimistic = applySpanPatches(base, patches, "base");
    const projection = projectReview(
      diffBlocks(optimistic, readBlocks(cut.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema)),
    );
    const known = new Set(projection.groups.map((group) => group.id));
    if (
      !request.groupIds.length ||
      new Set(request.groupIds).size !== request.groupIds.length ||
      request.groupIds.some((id) => !known.has(id))
    )
      throw new ApplyClickRefused("malformed");
    const classifications = classifyChanges(
      cut,
      projection,
      { ...provenance, snapshot },
      { record: true },
    );
    const compileGroup = (groupId: string): CompiledApplyGroup => {
      const group = projection.groups.find((candidate) => candidate.id === groupId);
      if (!group) throw new ApplyClickRefused("malformed");
      const hunks = group.hunks.map((hunk) => projection.diff.hunks[hunk.index]);
      const patches = composeHunks(schema, projection.diff, hunks, "apply");
      return {
        groupId,
        patched: applySpanPatches(optimistic, patches, "base"),
        record: {
          ...applyRecordOf(classifications, [groupId]),
          commandId: request.commandId,
          groupId,
        },
      };
    };
    const groups = request.groupIds.map(compileGroup);
    const selected = projection.groups.filter((group) => request.groupIds.includes(group.id));
    const selectedPatches = composeHunks(
      schema,
      projection.diff,
      selected.flatMap((group) => group.hunks.map((hunk) => projection.diff.hunks[hunk.index])),
      "apply",
    );
    return {
      schema,
      optimistic,
      patched: applySpanPatches(optimistic, selectedPatches, "base"),
      groups,
    };
  } finally {
    if (cut !== doc) cut.destroy();
  }
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
        const tree = item.tree ?? null;
        const cut = item.text;
        if (!cut) {
          // A tree cut alone: a move, a delete or a creation with no text room (design-v2 §4).
          if (!tree) throw new ApplyClickRefused("malformed");
          prepared.push({ node: item.node, tree, text: null });
          continue;
        }
        if (!cut.groupIds.length) throw new ApplyClickRefused("malformed");
        const start = performance.now();
        const base = await input.store.loadBase({
          draftId: cut.draftId,
          documentId: item.node,
          branchId: command.branchId,
        });
        if (!base || base.snapshot.status === "closed")
          return (await lookup()) ?? { status: "closed", commandId };
        // Receipts are captured after this replica, so they cover every item a contained click can name.
        const captured = await input.evidence.capture(cut.draftId);
        if (!captured || captured.draft.documentDraft.status === "closed")
          return (await lookup()) ?? { status: "closed", commandId };
        const lifecycle = captured.draft.documentDraft.lifecycle;
        if (lifecycle !== "active")
          throw new ApplyClickRefused(
            lifecycle === "archived"
              ? "work_archived"
              : lifecycle === "deleted"
                ? "work_deleted"
                : "not_found",
          );
        let click: CompiledClick;
        try {
          click = compileClick(base.replica.doc, { ...cut, commandId }, captured);
        } finally {
          input.store.measured?.({ commandId, compileClickMs: performance.now() - start });
        }
        prepared.push({ node: item.node, tree, text: { base, click } });
      }
      return await input.store.apply(command, prepared);
    } catch (cause) {
      if (cause instanceof DocumentCommandExistsError) {
        const winner = await lookup();
        if (winner) return winner;
      }
      if (cause instanceof ApplyClickRefused)
        return (await lookup()) ?? { status: "refused", commandId, reason: cause.reason };
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
      if (!prepared) return (await lookup()) ?? { status: "refused", commandId };
      return await input.store.unapply(command, prepared);
    } catch (cause) {
      if (cause instanceof DocumentCommandExistsError) {
        const winner = await lookup();
        if (winner) return winner;
      }
      if (cause instanceof ApplyClickRefused)
        return (await lookup()) ?? { status: "refused", commandId };
      throw cause;
    }
  };
  return { apply, unapply };
}
