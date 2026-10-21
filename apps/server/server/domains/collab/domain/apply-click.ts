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
  ApplyClick,
  ApplyClickAnswer,
  ApplyClickRefusalReason,
  ApplyClickResult,
} from "@meridian/contracts/branches";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import * as Y from "yjs";
import { testHook } from "../../../shared/test-hooks.js";
import type { CollabBranches } from "../contracts.js";
import { BranchCommandExistsError, type BranchCommands } from "./branch-commands.js";
import type { BranchReviewIdentity } from "./branch-review-identity.js";
import type { DraftBase } from "./draft-runtime.js";
import type { DraftDispositionStore } from "./ports/draft-disposition-store.js";
import type { TrailOwner } from "./trail-read-kernel.js";

export type ApplyClickCommand = Parameters<CollabBranches["draftReview"]["applyClick"]>[0];
export type CompiledClick = {
  schema: import("prosemirror-model").Schema;
  optimistic: readonly PMNode[];
  patched: readonly PMNode[];
  record: ApplyEntry;
  owners: readonly TrailOwner[];
  effects: { side: "base" | "draft"; index: number; owners: readonly TrailOwner[] }[];
};
export interface ApplyClickStore {
  closed(command: ApplyClickCommand): Promise<ApplyClickResult>;
  loadBase(command: ApplyClickCommand): Promise<DraftBase | null>;
  execute(
    command: ApplyClickCommand,
    prepared:
      | { kind: "text"; base: DraftBase; click: CompiledClick }
      | { kind: "reveal"; branchId: import("@meridian/contracts").BranchId },
  ): Promise<ApplyClickAnswer>;
  measured?(input: { commandId: string; compileClickMs: number }): void;
}
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
  request: ApplyClick,
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
    const members = new Set(
      request.groupIds.flatMap((id) => classifications.get(id)?.members ?? []),
    );
    const owners = new Map<string, TrailOwner>();
    for (const index of members) {
      const part = provenance.parts[index];
      if (part?.threadId && part.turnId)
        owners.set(`${part.threadId}:${part.turnId}`, {
          threadId: part.threadId,
          turnId: part.turnId,
        });
    }
    const effects: CompiledClick["effects"] = [];
    const selectedHunks = new Map<import("@meridian/agent-edit/diff").Hunk, TrailOwner[]>();
    for (const group of projection.groups) {
      if (!request.groupIds.includes(group.id)) continue;
      const groupOwners = (classifications.get(group.id)?.members ?? []).flatMap((index) => {
        const part = provenance.parts[index];
        return part?.threadId && part.turnId
          ? [{ threadId: part.threadId, turnId: part.turnId }]
          : [];
      });
      for (const h of group.hunks) selectedHunks.set(projection.diff.hunks[h.index], groupOwners);
    }
    const selectedPatches = composeHunks(
      schema,
      projection.diff,
      selectedHunks.keys(),
      "apply",
      (h, blocks) => {
        const owners = selectedHunks.get(h) ?? [];
        for (const index of blocks) effects.push({ side: "draft", index, owners });
        const baseSide = projection.diff.base;
        const deleted = new Set<number>();
        for (let i = h.from; i < h.to; i++) {
          const index = baseSide.blockOf[i];
          if (
            !blocks.length ||
            (h.from <= baseSide.starts[index] && h.to >= baseSide.starts[index + 1])
          )
            deleted.add(index);
        }
        for (const index of deleted) effects.push({ side: "base", index, owners });
      },
    );
    return {
      schema,
      optimistic,
      effects,
      patched: applySpanPatches(optimistic, selectedPatches, "base"),
      record: { ...applyRecordOf(classifications, request.groupIds), commandId: request.commandId },
      owners: [...owners.values()],
    };
  } finally {
    if (cut !== doc) cut.destroy();
  }
}

export function createApplyClickService(input: {
  identity: BranchReviewIdentity;
  commands: BranchCommands;
  evidence: DraftDispositionStore;
  store: ApplyClickStore;
}) {
  return async (command: ApplyClickCommand): Promise<ApplyClickAnswer> => {
    const commandId = command.envelope.commandId;
    const lookup = async (): Promise<ApplyClickAnswer | null> => {
      const found = await input.commands.lookup(command.envelope);
      if (found.kind === "none") return null;
      if (found.kind === "done")
        return found.commandKind === "apply_click"
          ? (found.result as ApplyClickResult)
          : { status: "conflict", commandId };
      return { status: found.kind, commandId };
    };
    const first = await lookup();
    if (first) return first;
    await testHook("apply.beforeCompile");
    try {
      const revealOnly =
        !command.request.snapshot &&
        !command.request.groupIds.length &&
        !command.request.baseViewDelta.length;
      if (revealOnly) {
        const resolved = await input.identity.resolveReviewItemByDocument(command);
        if (
          !resolved ||
          resolved.draftId ||
          !resolved.item.isNew ||
          resolved.item.origin !== "created"
        )
          throw new ApplyClickRefused("malformed");
        return await input.store.execute(command, { kind: "reveal", branchId: resolved.branchId });
      }
      if (!command.request.groupIds.length) throw new ApplyClickRefused("malformed");
      if (!command.request.draftId) throw new ApplyClickRefused("malformed");
      const start = performance.now();
      const base = await input.store.loadBase(command);
      if (!base || base.snapshot.status === "closed") {
        const result = await input.store.closed(command);
        return (await lookup()) ?? result;
      }
      // Receipts are captured after this replica, so they cover every item a contained click can name.
      const captured = await input.evidence.capture(command.request.draftId);
      if (!captured || captured.draft.documentDraft.status === "closed") {
        const result = await input.store.closed(command);
        return (await lookup()) ?? result;
      }
      const lifecycle = captured.draft.documentDraft.lifecycle;
      if (lifecycle !== "active")
        throw new ApplyClickRefused(
          lifecycle === "archived"
            ? "work_archived"
            : lifecycle === "deleted"
              ? "work_deleted"
              : "not_found",
        );
      const doc = base.replica.doc;
      let click: CompiledClick;
      try {
        click = compileClick(doc, command.request, captured);
      } finally {
        input.store.measured?.({ commandId, compileClickMs: performance.now() - start });
      }
      const result = await input.store.execute(command, { kind: "text", base, click });
      return result.status === "closed" || result.status === "refused"
        ? ((await lookup()) ?? result)
        : result;
    } catch (cause) {
      if (cause instanceof BranchCommandExistsError)
        return (await lookup()) ?? { status: "pending", commandId };
      if (cause instanceof ApplyClickRefused)
        return (await lookup()) ?? { status: "refused", commandId, reason: cause.reason };
      throw cause;
    }
  };
}
