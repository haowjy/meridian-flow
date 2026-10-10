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
import type { ContextSourceId, DocumentId, DraftId } from "@meridian/contracts";
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
  type PreparedMoves,
  prepareMoves,
  recordMoves,
  vacateMoves,
} from "../../context/tree/node-moves.js";
import { type PlaceTarget, place } from "../../context/tree/placement.js";
import { createTreeReader, LIVE_TREE, type TreeStateNode } from "../../context/tree/tree-view.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { BranchSnapshot, BranchStore } from "../domain/branch-coordinator.js";
import { branchCutOf } from "../domain/draft-branch-ahead-registration.js";
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
} from "../domain/draft-tree-payload.js";
import type { Drafts } from "../domain/drafts.js";
import type { ApplicationBranchStore } from "../domain/ports/application-branch-store.js";
import type {
  PublicationAdmission,
  PublicationItemHold,
  SettlementPublicationStep,
} from "../domain/ports/settlement-publication.js";
import type { WorkDraftPendingStore } from "../domain/ports/work-draft-pending-store.js";

type Refusal = Extract<PublicationAdmission, { kind: "refuse" }>;

/** One item that publishes, with its node and branch read under the locks. */
type Eligible = { item: DraftTreePayloadItem; node: TreeStateNode; branch: BranchSnapshot | null };

type Decided = { kind: "proceed"; holds: PublicationItemHold[]; apply: Eligible[] };

export function createDrizzleDraftTreeStep(
  db: Database,
  deps: {
    drafts: Pick<Drafts, "byIds" | "close">;
    branches: Pick<BranchStore, "getBranch"> &
      Pick<ApplicationBranchStore, "listActiveDraftBranchIds">;
    pending: Pick<WorkDraftPendingStore, "listDraftBranchEvidence">;
    workProjection: Pick<WorkProjectionMutation, "mutatePendingDraft">;
    arrivals?: DocumentArrivals;
  },
): SettlementPublicationStep {
  const tree = createTreeReader(db);

  /** Nothing pending in the draft: no branch with reviewable rows, no created row. */
  async function drained(draftId: DraftId): Promise<boolean> {
    const branches = await deps.pending.listDraftBranchEvidence(draftId);
    if (branches.some((evidence) => evidence.rows.length > 0)) return false;
    return (await tree.treeState(draftId)).length === 0;
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
        sourceIds.add(node.live.contextSourceId);
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
       * 5a against the final live tree (E-R2): an item publishes only where the live tree
       * will be free once the other publishing items have moved. A live occupant stays
       * unless it is a publishing item moving away, so holding a mover keeps its slot
       * taken; holds propagate until nothing else is blocked. Clashes among the draft's own
       * items are already holds in its view, so only staying live nodes block here.
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
        let apply = decided.apply;
        const holds = [...decided.holds];
        for (;;) {
          const movers = new Set(
            apply
              .filter(({ node }) => node.conflict.kind === "relocated")
              .map(({ node }) => node.nodeId),
          );
          const blocked = apply.flatMap((eligible) => {
            const at = (needs.get(eligible) ?? []).find((slot) => {
              const there = occupied.get(slot.key);
              const staying = there?.documents.some(
                (id) => id !== eligible.node.nodeId && !movers.has(id),
              );
              return staying || (slot.target && (there?.folders.length ?? 0) > 0);
            });
            return at ? [{ eligible, at }] : [];
          });
          if (blocked.length === 0) return { kind: "proceed", holds, apply };
          for (const { eligible, at } of blocked) {
            holds.push({
              itemKey: eligible.item.itemKey,
              ...(eligible.item.draftBranchId ? { documentId: eligible.item.documentId } : {}),
              reason: draftTreeHold(uriIn(eligible.node, at.path)),
            });
          }
          const out = new Set(blocked.map(({ eligible }) => eligible));
          apply = apply.filter((eligible) => !out.has(eligible));
        }
      }

      function tokensMoved(
        item: DraftTreePayloadItem,
        node: TreeStateNode,
        branch: BranchSnapshot | null,
      ): boolean {
        // A source outside the planned set isn't locked: the tokens would show it anyway.
        if (
          !sourceIds.has(node.live.contextSourceId) ||
          !sourceIds.has(node.target.contextSourceId)
        ) {
          return true;
        }
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

      // What `beforeAdmission` placed, for `afterAdmission`.
      let installed: {
        apply: Eligible[];
        moves: PreparedMoves | null;
        arrived: DocumentId[];
      } | null = null;

      return {
        workIds: draft?.originWorkId ? [draft.originWorkId] : [],
        draftIds: [payload.draftId],
        namespaceSourceIds: [...sourceIds],
        documentIds: payload.items.map((item) => item.documentId),

        async check() {
          const decided = await decide();
          if (decided.kind === "refuse") return decided;
          const holderMeanings: DraftTreePayload["holderMeanings"][number][] = [];
          for (const { item, branch } of decided.apply) {
            if (!item.draftBranchId) continue;
            const read = branch ? cutOfBranch(branch) : null;
            const cut = payload.linkCut.branches.find(
              (registered) => registered.branchId === item.draftBranchId,
            );
            // F18: the staged text must be the text whose refs were registered.
            if (!read || cut?.fingerprint !== read.fingerprint) {
              return refuse(draftTreeRefusal.linkCutChanged());
            }
            const refs = await draftMeaningsOf(db, {
              draftId: payload.draftId,
              aheadIds: read.refs.map((ref) => ref.aheadId),
            });
            // One snapshot per holder: the durable payload never names a (holder, ref) twice.
            const captured = holderMeanings.some(
              (meaning) => meaning.holderDocumentId === item.documentId,
            );
            if (refs.length > 0 && !captured) {
              holderMeanings.push({ holderDocumentId: item.documentId, refs });
            }
          }
          return {
            kind: "proceed",
            hold: decided.holds,
            payload: encodeDraftTreePayload({
              ...payload,
              items: decided.apply.map(({ item }) => item),
              holderMeanings,
            }),
          };
        },

        async beforeAdmission() {
          const decided = await decide();
          if (decided.kind === "refuse") return decided;
          const relocating = decided.apply.filter(({ node }) => node.conflict.kind === "relocated");
          let moves: PreparedMoves | null = null;
          if (relocating.length > 0) {
            const prepared = await prepareMoves(db, {
              moves: relocating.map(({ node }) => ({
                node: { kind: "document" as const, id: node.nodeId },
                to: {
                  contextSourceId: node.target.contextSourceId,
                  dir: node.target.dir,
                  name: node.target.name,
                  extension: node.target.extension,
                },
              })),
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
          installed = {
            apply: decided.apply,
            moves,
            arrived: [
              ...placing.map(({ node }) => node.nodeId),
              ...(moves ? movedDocumentIds(moves) : []),
            ],
          };
          return {
            kind: "proceed",
            hold: decided.holds,
            // The receipt says what this decision did (§11.2), not what a review saw.
            outcomes: decided.apply.flatMap(({ item, node }) => {
              const notes = notesOf(node);
              return notes.length > 0
                ? [{ itemKey: item.itemKey, detail: draftTreeNotes(notes) }]
                : [];
            }),
          };
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
          await deps.workProjection.mutatePendingDraft([payload.draftId], async () => {
            await dropDocumentRows(db, {
              draftId: payload.draftId,
              documentIds: apply
                .filter(({ node }) => node.origin === "created")
                .map(({ node }) => node.nodeId),
            });
            if (payload.closeWhenEmpty && (await drained(payload.draftId))) {
              await deps.drafts.close(payload.draftId, new Date());
            }
          });
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
  ].map((slot) => ({ ...slot, contextSourceId, key: `${contextSourceId}\u0000${slot.path}` }));
}

/** A path in the node's target source, spelled as its target is. */
function uriIn(node: TreeStateNode, path: string): string {
  const { uri, path: targetPath } = node.target;
  return uri?.endsWith(targetPath) ? uri.slice(0, uri.length - targetPath.length) + path : path;
}

/** What placing or moving this node does, as the writer's receipt says it. */
function notesOf(node: TreeStateNode): ApplyNote[] {
  const path = node.target.uri ?? node.target.path;
  if (node.conflict.kind === "deleted_live") return [{ code: "restored", path }];
  if (node.conflict.kind === "relocated") {
    return [{ code: "rename_replaced", replacedPath: node.live.uri ?? node.live.path, path }];
  }
  return [];
}

/** A branch's link cut as it stands: its text loaded once and read the registration's way. */
function cutOfBranch(branch: BranchSnapshot) {
  const doc = createCollabYDoc({ gc: false });
  try {
    Y.applyUpdate(doc, branch.state);
    return branchCutOf(doc);
  } finally {
    doc.destroy();
  }
}

function refuse(reason: Refusal["reason"]): Refusal {
  return { kind: "refuse", reason };
}

/** A placement or move that failed under the locks the decision just checked: a race lost. */
function staleRefusal(items: readonly Eligible[]): Refusal {
  return refuse(draftTreeRefusal.stale(items.map(({ item }) => item.itemKey)));
}
