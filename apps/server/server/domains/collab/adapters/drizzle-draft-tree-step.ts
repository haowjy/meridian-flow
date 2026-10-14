/**
 * The draft tree step on the settlement seam (`kind: "draft_tree"`): what Apply publishes beside a
 * draft's text, in the batch's one lock order (D's Work, D, every current and final source, every
 * item's document).
 *
 * The check (before staging) and `beforeAdmission` (completion) make the same decision: the
 * source-lock check at both, the location-consent check only at staging (staging is the consent
 * boundary and a staged batch is never withdrawn as stale; later live edits merge as ordinary peer
 * edits). 5a holds per item in one pass, first the draft's own view, then the live tree: an item is
 * blocked by what stands at its row's location now, never by another item. The check refines the
 * payload to the eligible items. `beforeAdmission` then installs: reveals of still-hidden creates
 * and restores of documents deleted live (F9), each at its row's current location through
 * placement, and reports each item's receipt notes. `afterAdmission` settles arrivals once against
 * the final tree, reconciles the catalog for every source it touched (F23), drops the draft's
 * applied created rows, and stores the writer's command with its terminal result, composed from the
 * holds, the member outcomes content settlement decided, the outcomes decided at staging and the
 * restoration notes. Apply never closes the draft (§2.4).
 */
import type { ContextSourceId, DocumentId } from "@meridian/contracts";
import type {
  DraftApplyAllResult,
  DraftCommandOutcome,
  DraftItemApplyResult,
  DraftItemOutcome,
} from "@meridian/contracts/drafts";
import type { Database } from "@meridian/database";
import { documentBranches } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { ContextCatalogMutationPort } from "../../context/ports/context-catalog.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import { dropDocumentRows } from "../../context/tree/draft-tree-store.js";
import { type PlaceTarget, place } from "../../context/tree/placement.js";
import { createTreeReader, LIVE_TREE, type TreeStateNode } from "../../context/tree/tree-view.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
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
  MemberOutcome,
  PublicationAdmission,
  PublicationItemHold,
  PublicationRefusal,
  SettlementPublicationStep,
} from "../domain/ports/settlement-publication.js";
import { settleCommandForBatchWithinTx } from "./drizzle-draft-commands.js";

type Refusal = Extract<PublicationAdmission, { kind: "refuse" }>;

/** One item that publishes, with its node read under the locks. */
type Eligible = { item: DraftTreePayloadItem; node: TreeStateNode };

type Decided = { kind: "proceed"; holds: PublicationItemHold[]; apply: Eligible[] };

export function createDrizzleDraftTreeStep(
  db: Database,
  deps: {
    drafts: Pick<Drafts, "byIds">;
    workProjection: Pick<WorkProjectionMutation, "mutatePendingDraft">;
    /** Catalog reconciliation in the completion transaction, so its replay sees the tree (F23). */
    catalog: ContextCatalogMutationPort;
    arrivals?: DocumentArrivals;
  },
): SettlementPublicationStep {
  const tree = createTreeReader(db);

  return {
    kind: DRAFT_TREE_STEP,

    async prepare(raw) {
      const payload = parseDraftTreePayload(raw);
      if (!payload) return { branchIds: [] };
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
          if (!node || tokensMoved(item, node)) {
            stale.push(item.itemKey);
          } else if (node.conflict.kind === "clash") {
            holds.push({
              itemKey: item.itemKey,
              ...(item.draftBranchId ? { documentId: item.documentId } : {}),
              reason: draftTreeHold(node.conflict.uri ?? node.conflict.at),
            });
          } else {
            apply.push({ item, node });
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

      function tokensMoved(item: DraftTreePayloadItem, node: TreeStateNode): boolean {
        // A source outside the planned set isn't locked: the token would show it anyway.
        if (!sourceIds.has(node.target.contextSourceId)) return true;
        // Staging is the consent boundary: what the writer saw is compared only at the check.
        // Later live edits merge as ordinary peer edits and never withdraw an accepted batch.
        return scope.stage === "check" && node.locationVersion.toString() !== item.locationToken;
      }

      // What completion decided, for the command's terminal result (§4.5, §4.6).
      let completionHolds: readonly PublicationItemHold[] = [];
      let completionNotes: ReadonlyMap<string, readonly ApplyNote[]> = new Map();

      /**
       * The command's terminal result when the batch completed (§1.2, §2.2's disposition table):
       * an item decided `failed` or `not_found` at staging answers that; a hold answers `held`;
       * otherwise it is `applied` when its member merged, or when the tree revealed, restored or
       * dropped its created row, and `already_live` when nothing changed.
       */
      async function completedResult(
        outcomes: ReadonlyMap<DocumentId, MemberOutcome>,
      ): Promise<DraftCommandOutcome> {
        const { command, draftId } = payload;
        const checkHeld = scope.stage === "completion" ? scope.held : [];
        const holds = new Map(
          [...checkHeld, ...completionHolds].flatMap((hold) => {
            const reason = readDraftTreeHold(hold.reason);
            return reason ? [[hold.itemKey, reason] as const] : [];
          }),
        );
        const decided = new Map(command.decided.map((outcome) => [outcome.itemKey, outcome]));
        const results: DraftItemOutcome[] = [];
        for (const itemKey of command.itemKeys) {
          const said = decided.get(itemKey);
          if (said && said.status !== "already_live") {
            results.push(said);
            continue;
          }
          const reason = holds.get(itemKey);
          if (reason) {
            results.push({ itemKey, status: "held", reason });
            continue;
          }
          const item = payload.items.find((candidate) => candidate.itemKey === itemKey);
          if (!item) throw new Error(`Apply lost item ${itemKey} between staging and completion`);
          const member = outcomes.get(item.documentId as DocumentId);
          const notes = [...(completionNotes.get(itemKey) ?? [])];
          // A created item's row drops with this command whether it revealed the document or
          // another Work already had (a shared create); an edited one never closes.
          const closed = item.origin === "created";
          const hasChanges = member?.hasChanges ?? (await textBranchHasChanges(item));
          if (member?.status === "applied" || closed || notes.length > 0) {
            results.push({
              itemKey,
              status: "applied",
              notes,
              overrode: member?.status === "applied" ? member.overrode : [],
              hasChanges,
              itemClosed: closed,
              ...(closed ? { itemDisposition: "applied" as const } : {}),
            });
          } else {
            results.push({ itemKey, status: "already_live", hasChanges });
          }
        }
        if (command.shape === "all") {
          return { status: "completed", draftId, items: results } satisfies DraftApplyAllResult;
        }
        const [result] = results;
        if (!result) return { status: "gone", draftId, itemKey: command.itemKeys[0] ?? "" };
        return { draftId, ...result } as DraftItemApplyResult;
      }

      /** Whether an item's text branch still differs from its base: read in this transaction. */
      async function textBranchHasChanges(item: DraftTreePayloadItem): Promise<boolean> {
        if (!item.draftBranchId) return false;
        const [branch] = await currentDrizzleDb(db)
          .select({ hasEffect: documentBranches.hasEffect, status: documentBranches.status })
          .from(documentBranches)
          .where(eq(documentBranches.id, item.draftBranchId))
          .limit(1);
        return branch?.status === "active" && branch.hasEffect;
      }

      /** The command's terminal result when completion withdrew the batch. */
      function withdrawnResult(reason: PublicationRefusal): DraftCommandOutcome {
        const { command, draftId } = payload;
        const gone = readDraftTreeRefusal(reason)?.kind === "gone";
        if (command.shape === "all") {
          return gone
            ? { status: "gone", draftId }
            : { status: "stale", draftId, staleItemKeys: [...command.itemKeys] };
        }
        const itemKey = command.itemKeys[0];
        if (!itemKey) return { status: "gone", draftId };
        return gone ? { status: "gone", draftId, itemKey } : { status: "stale", draftId, itemKey };
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
              items: decided.apply.map(({ item }) => item),
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

        async afterAdmission(outcomes) {
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
          await deps.workProjection.mutatePendingDraft([payload.draftId], async () => {
            await dropDocumentRows(db, {
              draftId: payload.draftId,
              documentIds: apply
                .filter(({ node }) => node.origin === "created")
                .map(({ node }) => node.nodeId),
            });
          });
          await settleCommandForBatchWithinTx(
            currentDrizzleDb(db),
            scope.batchId,
            await completedResult(outcomes),
          );
        },

        async onRefused(reason) {
          await settleCommandForBatchWithinTx(
            currentDrizzleDb(db),
            scope.batchId,
            withdrawnResult(reason),
          );
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
