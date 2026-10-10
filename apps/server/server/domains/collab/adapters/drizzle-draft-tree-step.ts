/**
 * The draft tree step on the settlement seam (contract §11.2, `kind: "draft_tree"`): what
 * Apply publishes with a draft's text, in the batch's one lock order (D's Work, D, every
 * current and final source, every item's document).
 *
 * The check (before staging) and `beforeAdmission` (completion) make the same decision:
 * rendered tokens (#420, S2: location version, the live full-state fingerprint, the
 * branch generation) or `stale`; 5a clashes held per item. The check also fences the
 * link cut (F18) and captures each holder's link meanings into the payload it refines
 * (V2-H4). `beforeAdmission` then vacates and installs: relocations through the batch move
 * primitive, reveals of still-hidden creates and restores of documents deleted live (F9)
 * through placement. `afterAdmission` settles arrivals once against the final tree, binds
 * admitted holders from the staged meanings, records the moves, drops the draft's applied
 * rows and closes the draft when asked and nothing stays pending.
 */
import type { ContextSourceId, DocumentId, DraftId, FolderId } from "@meridian/contracts";
import type { JsonValue } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { Ok } from "../../../shared/result.js";
import { draftMeaningsOf } from "../../context/adapters/link-ahead-draft-settlements.js";
import { bindHolderRefs } from "../../context/adapters/link-ahead-holder-bindings.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import { dropDocumentRows } from "../../context/tree/draft-tree-store.js";
import {
  installMoves,
  movedDocumentIds,
  type NodeMove,
  type PreparedMoves,
  prepareMoves,
  recordMoves,
  vacateMoves,
} from "../../context/tree/node-moves.js";
import { type PlaceTarget, place } from "../../context/tree/placement.js";
import { createTreeReader, type TreeStateNode } from "../../context/tree/tree-view.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { BranchStore } from "../domain/branch-coordinator.js";
import { fullStateFingerprint } from "../domain/branch-push-transition.js";
import { aheadRefsIn } from "../domain/draft-branch-ahead-registration.js";
import {
  APPLY_REFUSAL,
  DRAFT_TREE_STEP,
  type DraftTreePayload,
  type DraftTreePayloadItem,
  parseDraftTreePayload,
} from "../domain/draft-publication.js";
import type { Drafts } from "../domain/drafts.js";
import type { ApplicationBranchStore } from "../domain/ports/application-branch-store.js";
import type {
  PublicationAdmission,
  PublicationItemHold,
  SettlementBatchScope,
  SettlementPublicationStep,
} from "../domain/ports/settlement-publication.js";
import type { WorkDraftPendingStore } from "../domain/ports/work-draft-pending-store.js";

type Decision =
  | { kind: "refuse"; admission: Extract<PublicationAdmission, { kind: "refuse" }> }
  | {
      kind: "proceed";
      holds: PublicationItemHold[];
      /** The items that publish, each with its node under the locks. */
      apply: { item: DraftTreePayloadItem; node: TreeStateNode }[];
    };

export function createDrizzleDraftTreeStep(
  db: Database,
  deps: {
    drafts: Pick<Drafts, "byIds" | "close">;
    branches: Pick<BranchStore, "getBranch"> &
      Pick<ApplicationBranchStore, "listActiveDraftBranchIds">;
    pending: Pick<WorkDraftPendingStore, "listDraftBranchEvidence">;
    arrivals?: DocumentArrivals;
    workProjection?: WorkProjectionMutation;
  },
): SettlementPublicationStep {
  const tree = createTreeReader(db);

  async function branchFingerprint(branchId: string) {
    const branch = await deps.branches.getBranch(branchId);
    if (!branch) return null;
    const doc = createCollabYDoc({ gc: false });
    try {
      Y.applyUpdate(doc, branch.state);
      return { branch, fingerprint: fullStateFingerprint(doc), refs: aheadRefsIn(doc) };
    } finally {
      doc.destroy();
    }
  }

  /** Nothing pending in the draft: no branch with reviewable rows, no created row. */
  async function drained(draftId: DraftId): Promise<boolean> {
    const branches = await deps.pending.listDraftBranchEvidence(draftId);
    if (branches.some((evidence) => evidence.rows.length > 0)) return false;
    return (await tree.treeState(draftId)).length === 0;
  }

  function plan(scope: SettlementBatchScope, payload: DraftTreePayload) {
    const editedIds = payload.items
      .filter((item) => item.origin === "edited")
      .map((item) => item.documentId);
    const fingerprints = scope.liveTextFingerprints;

    /** The same decision before staging and in completion (§11.2 steps 2 and 3). */
    async function decide(lockedSources: ReadonlySet<string>): Promise<Decision> {
      const [draft] = await deps.drafts.byIds([payload.draftId]);
      if (draft?.status !== "active") {
        return { kind: "refuse", admission: refuse(APPLY_REFUSAL.gone) };
      }
      const nodes = new Map(
        (await tree.treeState(payload.draftId, editedIds)).map((node) => [node.nodeId, node]),
      );
      const stale: string[] = [];
      const holds: PublicationItemHold[] = [];
      const apply: { item: DraftTreePayloadItem; node: TreeStateNode }[] = [];
      for (const item of payload.items) {
        const node = nodes.get(item.documentId);
        if (!node || (await tokensMoved(item, node, lockedSources))) {
          stale.push(item.itemKey);
          continue;
        }
        if (node.conflict.kind === "clash") {
          holds.push({
            itemKey: item.itemKey,
            ...(item.draftBranchId ? { documentId: item.documentId } : {}),
            reason: {
              code: "path_taken",
              detail: { path: node.conflict.uri ?? node.conflict.at },
            },
          });
          continue;
        }
        apply.push({ item, node });
      }
      if (stale.length > 0) {
        return { kind: "refuse", admission: refuse(APPLY_REFUSAL.stale, { itemKeys: stale }) };
      }
      return { kind: "proceed", holds, apply };
    }

    async function tokensMoved(
      item: DraftTreePayloadItem,
      node: TreeStateNode,
      lockedSources: ReadonlySet<string>,
    ): Promise<boolean> {
      // A source outside the planned set isn't locked: the tokens would show it anyway.
      if (
        !lockedSources.has(node.live.contextSourceId) ||
        !lockedSources.has(node.target.contextSourceId)
      ) {
        return true;
      }
      if (
        item.locationToken !== undefined &&
        node.locationVersion.toString() !== item.locationToken
      ) {
        return true;
      }
      const live = fingerprints.get(item.documentId);
      if (item.liveTextToken !== undefined && live !== undefined && live !== item.liveTextToken) {
        return true;
      }
      if (item.branchGenerationToken !== undefined && item.draftBranchId) {
        const branch = await deps.branches.getBranch(item.draftBranchId);
        if (!branch || String(branch.generation) !== item.branchGenerationToken) return true;
      }
      return false;
    }

    return { decide };
  }

  return {
    kind: DRAFT_TREE_STEP,

    async prepare(raw) {
      const payload = parseDraftTreePayload(raw);
      if (!payload) return { branchIds: [] };
      // Closing D needs every branch of it leased (§2.1), both kinds.
      if (payload.closeWhenEmpty) {
        return { branchIds: await deps.branches.listActiveDraftBranchIds(payload.draftId) };
      }
      return { branchIds: payload.items.flatMap((item) => item.draftBranchId ?? []) };
    },

    async plan(scope) {
      const payload = parseDraftTreePayload(scope.payloads.get(DRAFT_TREE_STEP));
      if (!payload) return null;
      const [draft] = await deps.drafts.byIds([payload.draftId]);
      const before = await tree.treeState(
        payload.draftId,
        payload.items.filter((item) => item.origin === "edited").map((item) => item.documentId),
      );
      const selected = new Set(payload.items.map((item) => item.documentId));
      const sourceIds = new Set<string>();
      for (const node of before) {
        if (!selected.has(node.nodeId)) continue;
        sourceIds.add(node.live.contextSourceId);
        sourceIds.add(node.target.contextSourceId);
      }
      const { decide } = plan(scope, payload);
      // What `beforeAdmission` placed, for `afterAdmission`.
      let installed: {
        apply: { item: DraftTreePayloadItem; node: TreeStateNode }[];
        moves: PreparedMoves | null;
        arrived: DocumentId[];
      } | null = null;

      return {
        workIds: draft?.originWorkId ? [draft.originWorkId] : [],
        draftIds: [payload.draftId],
        namespaceSourceIds: [...sourceIds] as ContextSourceId[],
        documentIds: payload.items.map((item) => item.documentId),

        async check() {
          const decided = await decide(sourceIds);
          if (decided.kind !== "proceed") return decisionRefusal(decided);
          const holderMeanings: DraftTreePayload["holderMeanings"][number][] = [];
          for (const { item } of decided.apply) {
            if (!item.draftBranchId) continue;
            const read = await branchFingerprint(item.draftBranchId);
            const cut = payload.linkCut.branches.find(
              (branch) => branch.branchId === item.draftBranchId,
            );
            // F18: the staged text must be the text whose refs were registered.
            if (!read || cut?.fingerprint !== read.fingerprint) {
              return refuse(APPLY_REFUSAL.linkCutChanged);
            }
            const refs = await draftMeaningsOf(db, {
              draftId: payload.draftId,
              aheadIds: read.refs.map((ref) => ref.aheadId),
            });
            if (refs.length > 0) holderMeanings.push({ holderDocumentId: item.documentId, refs });
          }
          const refined: DraftTreePayload = {
            ...payload,
            items: decided.apply.map(({ item }) => item),
            holderMeanings,
          };
          return {
            kind: "proceed",
            hold: decided.holds,
            payload: refined as unknown as JsonValue,
          };
        },

        async beforeAdmission() {
          const decided = await decide(sourceIds);
          if (decided.kind !== "proceed") return decisionRefusal(decided);
          const relocating = decided.apply.filter(({ node }) => node.conflict.kind === "relocated");
          let moves: PreparedMoves | null = null;
          if (relocating.length > 0) {
            const prepared = await prepareMoves(db, {
              moves: relocating.map(
                ({ node }): NodeMove => ({
                  node: { kind: "document", id: node.nodeId },
                  to: {
                    contextSourceId: node.target.contextSourceId,
                    dir: node.target.path.split("/").slice(0, -1),
                    name: node.target.name,
                    extension: node.target.extension,
                  },
                }),
              ),
              filetypeFor: () => Ok(null),
            });
            if (!prepared.ok) return staleRefusal(relocating);
            moves = prepared.value;
            await vacateMoves(db, moves);
            const done = await installMoves(db, moves);
            if (!done.ok) return staleRefusal(relocating);
          }
          // Reveal every still-hidden create, restore every document deleted live (F9),
          // each at the draft's location with its ancestors (decisions 7, 9).
          const targets: PlaceTarget[] = decided.apply.flatMap(({ node }): PlaceTarget[] => {
            const mode =
              node.origin === "created" && node.hidden
                ? "reveal"
                : node.conflict.kind === "deleted_live"
                  ? "restore"
                  : null;
            if (!mode) return [];
            return [
              {
                node: { kind: "document", id: node.nodeId },
                at: {
                  contextSourceId: node.target.contextSourceId,
                  parentFolderId: node.target.parentFolderId as FolderId | null,
                  name: node.target.name,
                  extension: node.target.extension,
                },
                mode,
              },
            ];
          });
          const placed = targets.length > 0 ? await place(db, { targets }) : null;
          if (placed && !placed.ok) return staleRefusal(decided.apply);
          installed = {
            apply: decided.apply,
            moves,
            arrived: [
              ...targets.map((target) => target.node.id as DocumentId),
              ...(moves ? movedDocumentIds(moves) : []),
            ],
          };
          return { kind: "proceed", hold: decided.holds };
        },

        async afterAdmission(admitted) {
          if (!installed) throw new Error("draft_tree afterAdmission ran without beforeAdmission");
          const { apply, moves, arrived } = installed;
          // A restore or a reveal is an arrival; settled once against the final tree.
          if (arrived.length > 0) await deps.arrivals?.settle([...new Set(arrived)]);
          const admittedSet = new Set(admitted);
          await bindHolderRefs(
            db,
            payload.holderMeanings.filter((meaning) => admittedSet.has(meaning.holderDocumentId)),
          );
          if (moves) await recordMoves(db, moves);
          const dropAndClose = async () => {
            await dropDocumentRows(db, {
              draftId: payload.draftId,
              documentIds: apply
                .filter(({ node }) => node.origin === "created")
                .map(({ node }) => node.nodeId),
            });
            if (payload.closeWhenEmpty && (await drained(payload.draftId))) {
              await deps.drafts.close(payload.draftId, new Date());
            }
          };
          if (deps.workProjection) {
            await deps.workProjection.mutatePendingDraft([payload.draftId], dropAndClose);
          } else {
            await dropAndClose();
          }
        },
      };
    },
  };
}

function refuse(code: string, detail?: { itemKeys: string[] }) {
  return {
    kind: "refuse" as const,
    reason: detail ? { code, detail } : { code },
  };
}

function decisionRefusal(decided: Exclude<Decision, { kind: "proceed" }>) {
  return decided.admission;
}

/** A placement or move that failed under the locks the decision just checked: a race lost. */
function staleRefusal(items: readonly { item: DraftTreePayloadItem }[]) {
  return refuse(APPLY_REFUSAL.stale, { itemKeys: items.map(({ item }) => item.itemKey) });
}
