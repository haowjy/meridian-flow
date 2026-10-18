/**
 * The draft tree step on the settlement seam (contract §11.2, `kind: "draft_tree"`): what
 * Apply publishes with a draft's text, in the batch's one lock order (D's Work, D, every
 * current and final source, every item's document).
 *
 * The check (before staging) and `beforeAdmission` (completion) make the same decision,
 * except that the rendered tokens (#420, S2: location version, the live full-state
 * fingerprint, the branch generation) are compared only at the check: staging is the consent
 * boundary and a staged batch is never withdrawn as stale. 5a holds per item, first the draft's own view, then the
 * live tree, once: an item is blocked by what stands at its row's location now, never by another item.
 * The check refines the payload to the eligible items. `beforeAdmission` then installs: reveals
 * of still-hidden creates and restores of documents deleted live (F9) through placement,
 * each at its row's location, and reports each item's receipt notes.
 * `afterAdmission` settles arrivals once against the final tree (an ahead ref binds there,
 * once, for every holder), reconciles the catalog for every source it
 * touched (F23), drops the draft's applied rows, resets every admitted item whose branch
 * has nothing left to review (`settleDrainedItems`, in the completion transaction and keyed
 * to the staged generation) and records the writer's command with its terminal result.
 * Apply never closes the draft (§2.4).
 */
import type { ContextSourceId, DocumentId } from "@meridian/contracts";
import type {
  DraftApplyItemResult,
  DraftCommandResult,
  DraftItemSettlement,
} from "@meridian/contracts/drafts";
import type { Database } from "@meridian/database";
import type * as Y from "yjs";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { ContextCatalogMutationPort } from "../../context/ports/context-catalog.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import { dropDocumentRows } from "../../context/tree/draft-tree-store.js";
import { type PlaceTarget, place } from "../../context/tree/placement.js";
import { createTreeReader, LIVE_TREE, type TreeStateNode } from "../../context/tree/tree-view.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { BranchCoordinator } from "../domain/branch-coordinator.js";
import type { BranchSnapshot, BranchStore } from "../domain/branch-store.js";
import { BranchCasConflictError, materializeBranchRead } from "../domain/branch-store.js";
import { documentEffectsEqual } from "../domain/document-content.js";
import {
  type ApplyNote,
  DRAFT_TREE_STEP,
  type DraftTreePayload,
  type DraftTreePayloadItem,
  draftTreeHold,
  draftTreeNotes,
  draftTreeRefusal,
  encodeDraftTreePayload,
  parseDraftTreePayload,
  readDraftTreeHold,
  readDraftTreeNotes,
  readDraftTreeRefusal,
} from "../domain/draft-tree-payload.js";
import type { Drafts } from "../domain/drafts.js";
import type {
  PublicationAdmission,
  PublicationItemHold,
  PublicationRefusal,
  SettlementPublicationStep,
} from "../domain/ports/settlement-publication.js";
import { settleCommandForBatchWithinTx } from "./drizzle-draft-commands.js";

type Refusal = Extract<PublicationAdmission, { kind: "refuse" }>;

/** One item that publishes, with its node and branch read under the locks. */
type Eligible = { item: DraftTreePayloadItem; node: TreeStateNode; branch: BranchSnapshot | null };

type Decided = { kind: "proceed"; holds: PublicationItemHold[]; apply: Eligible[] };

export function createDrizzleDraftTreeStep(
  db: Database,
  deps: {
    drafts: Pick<Drafts, "byIds">;
    branches: Pick<BranchStore, "getBranch" | "readBranchAt">;
    /** The reset of a drained branch inside the completion transaction. */
    coordinator: Pick<BranchCoordinator, "resetFromDoc">;
    /** The live document as the completion transaction sees it, admissions included. */
    liveDoc(documentId: DocumentId): Promise<Y.Doc>;
    workProjection: Pick<WorkProjectionMutation, "mutate">;
    /** Catalog reconciliation in the completion transaction, so its replay sees the tree (F23). */
    catalog: ContextCatalogMutationPort;
    arrivals?: DocumentArrivals;
  },
): SettlementPublicationStep {
  const tree = createTreeReader(db);

  return {
    kind: DRAFT_TREE_STEP,

    async plan(scope) {
      const staged = parseDraftTreePayload(scope.payloads.get(DRAFT_TREE_STEP));
      if (!staged) return null;
      const payload: DraftTreePayload = staged;
      const editedIds = payload.items
        .filter((item) => item.origin === "edited")
        .map((item) => item.documentId);
      const [draft] = await deps.drafts.byIds([payload.draftId]);
      // The lock set, read without locks: a set that differs under them is stale.
      const selected = new Set(payload.items.map((item) => item.documentId));
      const sourceIds = new Set<ContextSourceId>();
      for (const node of await tree.treeState(payload.draftId, editedIds)) {
        if (!selected.has(node.nodeId)) continue;
        sourceIds.add(node.target.contextSourceId);
      }

      /** The same decision before staging and in completion (§11.2 steps 2 and 3). */
      async function decide(): Promise<Decided | Refusal> {
        const [locked] = await deps.drafts.byIds([payload.draftId]);
        if (locked?.status !== "active") return refuse(draftTreeRefusal.gone());
        const nodes = new Map(
          (await tree.treeState(payload.draftId, editedIds)).map((node) => [node.nodeId, node]),
        );
        const stale: string[] = [];
        const holds: PublicationItemHold[] = [];
        const apply: Eligible[] = [];
        for (const item of payload.items) {
          const node = nodes.get(item.documentId);
          const branch = item.draftBranchId
            ? await deps.branches.getBranch(item.draftBranchId)
            : null;
          if (!node || tokensMoved(item, node, branch)) {
            stale.push(item.itemKey);
          } else if (node.conflict.kind === "clash") {
            holds.push({
              itemKey: item.itemKey,
              ...(item.draftBranchId ? { documentId: item.documentId } : {}),
              reason: draftTreeHold(node.conflict.uri ?? node.conflict.at),
            });
          } else {
            apply.push({ item, node, branch });
          }
        }
        if (stale.length > 0) return refuse(draftTreeRefusal.stale(stale));
        return holdUntilPlaceable({ holds, apply });
      }

      /**
       * 5a against the live tree: an item publishes only where the live tree is free at its
       * row's location. Clashes among the draft's own items are already holds in its view,
       * so only live nodes block here; a blocked item is held.
       */
      async function holdUntilPlaceable(decided: {
        holds: PublicationItemHold[];
        apply: Eligible[];
      }): Promise<Decided> {
        const needs = new Map(decided.apply.map((eligible) => [eligible, slotsOf(eligible.node)]));
        const slots = [
          ...new Map([...needs.values()].flat().map((slot) => [slot.key, slot] as const)).values(),
        ];
        const found = await tree.occupancy(LIVE_TREE, slots);
        const occupied = new Map(slots.map((slot, index) => [slot.key, found[index]]));
        const holds = [...decided.holds];
        const apply: Eligible[] = [];
        for (const eligible of decided.apply) {
          const at = (needs.get(eligible) ?? []).find((slot) => {
            const there = occupied.get(slot.key);
            const staying = there?.documents.some((id) => id !== eligible.node.nodeId);
            return staying || (slot.target && (there?.folders.length ?? 0) > 0);
          });
          if (!at) {
            apply.push(eligible);
            continue;
          }
          holds.push({
            itemKey: eligible.item.itemKey,
            ...(eligible.item.draftBranchId ? { documentId: eligible.item.documentId } : {}),
            reason: draftTreeHold(uriIn(eligible.node, at.path)),
          });
        }
        return { kind: "proceed", holds, apply };
      }

      function tokensMoved(
        item: DraftTreePayloadItem,
        node: TreeStateNode,
        branch: BranchSnapshot | null,
      ): boolean {
        // A source outside the planned set isn't locked: the tokens would show it anyway.
        if (!sourceIds.has(node.target.contextSourceId)) return true;
        // Staging is the consent boundary: what the writer saw is compared only at the check.
        // Later live edits merge as ordinary peer edits and never withdraw an accepted batch.
        if (scope.stage !== "check") return false;
        if (node.locationVersion.toString() !== item.locationToken) return true;
        // A member's live text under its coordinator lease; an item with no text member
        // publishes no text, so its live text can't be stale.
        const live = scope.liveTextFingerprints.get(item.documentId);
        if (item.liveTextToken !== null && live !== undefined && live !== item.liveTextToken) {
          return true;
        }
        if (item.branchGenerationToken !== null) {
          return !branch || String(branch.generation) !== item.branchGenerationToken;
        }
        return false;
      }

      // What completion decided, for the command's terminal result (§4.5, §4.6).
      let completionHolds: readonly PublicationItemHold[] = [];
      let completionNotes: ReadonlyMap<string, readonly ApplyNote[]> = new Map();

      /** The command's terminal result when the batch completed. */
      function completedResult(
        settled: ReadonlyMap<DocumentId, DraftItemSettlement>,
      ): DraftCommandResult | null {
        const { command, draftId } = payload;
        if (!command) return null;
        const checkHeld = scope.stage === "completion" ? scope.held : [];
        const holds = new Map(
          [...checkHeld, ...completionHolds].flatMap((hold) => {
            const reason = readDraftTreeHold(hold.reason);
            return reason ? [[hold.itemKey, reason] as const] : [];
          }),
        );
        const results = command.itemKeys.map((itemKey): DraftApplyItemResult => {
          const reason = holds.get(itemKey);
          return reason
            ? { itemKey, status: "held", reason }
            : { itemKey, status: "applied", notes: [...(completionNotes.get(itemKey) ?? [])] };
        });
        if (command.shape === "all") return { status: "completed", draftId, items: results };
        const [result] = results;
        const itemKey = command.itemKeys[0];
        if (!result || !itemKey) return { status: "gone", draftId };
        if (result.status === "held") {
          return { status: "held", draftId, itemKey, reason: result.reason };
        }
        if (command.shape === "item") return { status: "applied", draftId, itemKey, item: result };
        const item = payload.items.find((candidate) => candidate.itemKey === itemKey);
        const closed = item ? settled.get(item.documentId as DocumentId) : undefined;
        return {
          status: "applied",
          draftId,
          itemKey,
          operationIds: [...(item?.selection?.operationIds ?? [])],
          closureClassIds: [...(item?.selection?.closureClassIds ?? [])],
          itemClosed: closed?.itemClosed ?? false,
          ...(closed?.itemDisposition ? { itemDisposition: closed.itemDisposition } : {}),
        };
      }

      /** The command's terminal result when completion withdrew the batch. */
      function withdrawnResult(reason: PublicationRefusal): DraftCommandResult | null {
        const { command, draftId } = payload;
        if (!command) return null;
        const gone = readDraftTreeRefusal(reason)?.kind === "gone";
        if (command.shape === "all") {
          return gone
            ? { status: "gone", draftId }
            : { status: "stale", draftId, staleItemKeys: [...command.itemKeys] };
        }
        const itemKey = command.itemKeys[0];
        return itemKey
          ? { status: gone ? "gone" : "stale", draftId, itemKey }
          : { status: "gone", draftId };
      }

      /**
       * Drained items reset inside the completion transaction (§4.1, LA-2): each admitted
       * text item whose branch is still at the staged generation and whose live-vs-branch
       * effect is empty against the transaction-visible live text is reset to G+1, edit
       * parts retired, peers kept, draft open. The reset, the terminal batch and the
       * command's result commit together.
       */
      async function settleDrainedItems(
        apply: readonly Eligible[],
        admitted: ReadonlySet<DocumentId>,
      ): Promise<Map<DocumentId, DraftItemSettlement>> {
        const settled = new Map<DocumentId, DraftItemSettlement>();
        for (const { item } of apply) {
          if (!item.draftBranchId || item.branchGenerationToken === null) continue;
          if (!admitted.has(item.documentId as DocumentId)) continue;
          const read = await deps.branches.readBranchAt(item.draftBranchId);
          const branch = read?.branch;
          if (
            !read ||
            branch?.status !== "active" ||
            String(branch.generation) !== item.branchGenerationToken
          ) {
            continue;
          }
          const live = await deps.liveDoc(item.documentId as DocumentId);
          const draft = materializeBranchRead(read);
          try {
            if (!documentEffectsEqual(live, draft)) continue;
            if (scope.stage !== "completion") {
              throw new Error("A drained item resets only in completion");
            }
            // Exact at the revision the empty effect was judged at; the settlement owns the
            // reset, so no settlement fence. A miss means content landed after the check
            // (a writer's frame): the item stays open with its typing, not reset.
            const reset = await deps.coordinator
              .resetFromDoc({
                branchId: branch.branchId,
                upstream: live,
                expectedGeneration: branch.generation,
                policy: "exact",
                expectedRevision: branch.revision,
                schemaVersion: branch.schemaVersion,
                editDisposition: "retired",
              })
              .catch((cause) => {
                if (cause instanceof BranchCasConflictError) return false;
                throw cause;
              });
            if (!reset) continue;
            settled.set(item.documentId as DocumentId, {
              itemClosed: true,
              itemDisposition: "applied",
            });
          } finally {
            draft.destroy();
            live.destroy();
          }
        }
        return settled;
      }

      // What `beforeAdmission` placed, for `afterAdmission`.
      let installed: {
        apply: Eligible[];
        arrived: DocumentId[];
        /** Every source a node reached, and the nodes placed. */
        catalog: { sourceIds: ReadonlySet<string>; roots: readonly string[] };
      } | null = null;

      return {
        workIds: draft?.originWorkId ? [draft.originWorkId] : [],
        draftIds: [payload.draftId],
        namespaceSourceIds: [...sourceIds],
        documentIds: payload.items.map((item) => item.documentId),

        async check() {
          const decided = await decide();
          if (decided.kind === "refuse") return decided;
          return {
            kind: "proceed",
            hold: decided.holds,
            payload: encodeDraftTreePayload({
              ...payload,
              // A per-change Apply's live token is the lock cut's: the live-revision fence
              // just proved live unchanged since the selection (§4.1).
              items: decided.apply.map(({ item }) =>
                item.selection && item.liveTextToken === null
                  ? {
                      ...item,
                      liveTextToken: scope.liveTextFingerprints.get(item.documentId) ?? null,
                    }
                  : item,
              ),
            }),
          };
        },

        async beforeAdmission() {
          const decided = await decide();
          if (decided.kind === "refuse") return decided;
          // Reveal every still-hidden create, restore every document deleted live (F9),
          // each at its row's location with its ancestors (decisions 7, 9).
          const placing = decided.apply.flatMap(({ node }) => {
            const mode =
              node.origin === "created" && node.hidden
                ? ("reveal" as const)
                : node.conflict.kind === "deleted_live"
                  ? ("restore" as const)
                  : null;
            return mode ? [{ node, mode }] : [];
          });
          const targets = placing.map(({ node, mode }): PlaceTarget => {
            const { contextSourceId, parentFolderId, name, extension } = node.target;
            return {
              node: { kind: "document", id: node.nodeId },
              at: { contextSourceId, parentFolderId, name, extension },
              mode,
            };
          });
          const placed = targets.length > 0 ? await place(db, { targets }) : null;
          if (placed && !placed.ok) return staleRefusal(decided.apply);
          const placedRefs = placed?.ok ? placed.value.placed : [];
          installed = {
            apply: decided.apply,
            arrived: placing.map(({ node }) => node.nodeId),
            catalog: {
              sourceIds: new Set(placed?.ok ? placed.value.sourceIds : []),
              roots: placedRefs.map((ref) => ref.id),
            },
          };
          completionHolds = decided.holds;
          const outcomes = decided.apply.flatMap(({ item, node }) => {
            const notes = notesOf(node);
            return notes.length > 0
              ? [{ itemKey: item.itemKey, detail: draftTreeNotes(notes) }]
              : [];
          });
          completionNotes = new Map(
            outcomes.map((outcome) => [outcome.itemKey, readDraftTreeNotes(outcome.detail)]),
          );
          return {
            kind: "proceed",
            hold: decided.holds,
            // The receipt says what this decision did (§11.2), not what a review saw.
            outcomes,
          };
        },

        async afterAdmission(admitted) {
          if (!installed) throw new Error("draft_tree afterAdmission ran without beforeAdmission");
          const { apply, arrived } = installed;
          // A restore or a reveal is an arrival; settled once against the final tree.
          if (arrived.length > 0) await deps.arrivals?.settle([...new Set(arrived)]);
          // In this transaction, warm or recovered: a replica replaying from a cursor taken
          // before the Apply learns of every node it revealed or restored.
          if (installed.catalog.sourceIds.size > 0) {
            await deps.catalog.refreshSources(
              [...installed.catalog.sourceIds],
              installed.catalog.roots,
            );
          }
          await deps.workProjection.mutate({ drafts: [payload.draftId] }, async () => {
            await dropDocumentRows(db, {
              draftId: payload.draftId,
              documentIds: apply
                .filter(({ node }) => node.origin === "created")
                .map(({ node }) => node.nodeId),
            });
          });
          const settled = await settleDrainedItems(apply, new Set(admitted));
          const result = completedResult(settled);
          if (result)
            await settleCommandForBatchWithinTx(currentDrizzleDb(db), scope.batchId, result);
        },

        async onRefused(reason) {
          const result = withdrawnResult(reason);
          if (result)
            await settleCommandForBatchWithinTx(currentDrizzleDb(db), scope.batchId, result);
        },
      };
    },
  };
}

/**
 * The live slots an item needs, root first: each ancestor folder's path (a document there
 * blocks it) and its own path (any other node there blocks it), in its target source.
 */
function slotsOf(node: TreeStateNode) {
  const { contextSourceId, dir, path } = node.target;
  return [
    ...dir.map((_, depth) => ({ path: dir.slice(0, depth + 1).join("/"), target: false })),
    { path, target: true },
  ].map((slot) => ({
    ...slot,
    contextSourceId,
    as: slot.target ? ("document" as const) : ("folder" as const),
    key: `${contextSourceId}\u0000${slot.path}`,
  }));
}

/** A path in the node's target source, spelled as its target is. */
function uriIn(node: TreeStateNode, path: string): string {
  const { uri, path: targetPath } = node.target;
  return uri?.endsWith(targetPath) ? uri.slice(0, uri.length - targetPath.length) + path : path;
}

/** What placing this node does, as the writer's receipt says it. */
function notesOf(node: TreeStateNode): ApplyNote[] {
  const path = node.target.uri ?? node.target.path;
  if (node.conflict.kind === "deleted_live") return [{ code: "restored", path }];
  return [];
}

function refuse(reason: Refusal["reason"]): Refusal {
  return { kind: "refuse", reason };
}

/** A placement or move that failed under the locks the decision just checked: a race lost. */
function staleRefusal(items: readonly Eligible[]): Refusal {
  return refuse(draftTreeRefusal.stale(items.map(({ item }) => item.itemKey)));
}
