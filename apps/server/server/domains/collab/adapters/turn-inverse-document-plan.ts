/** Pure attempt-local text planning for one captured inverse document. */
import type { ComputedInverseEdit } from "@meridian/agent-edit/integration";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import type { BranchId } from "@meridian/contracts";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { appendInverseRestorationFacts } from "../domain/provenance.js";
import type { PreparedDocumentInverse, TurnInverseQuery } from "../domain/turn-inverse-service.js";

export type PlannedInverse = {
  plan: PreparedDocumentInverse;
  documentId: import("@meridian/contracts").DocumentId;
  /** Each live step's parts, with their restoration facts on this attempt's copy of Live. */
  edits: Map<ComputedInverseEdit, ComputedInverseEdit["parts"]>;
  /** What a step wrote: Live's journal updates (`draftId` null) and the appends of a draft's content steps. */
  updates: { draftId: string | null; update: Uint8Array }[];
  live: boolean;
  /** Drafts a content step wrote into, for delivery. */
  contentDrafts: Set<string>;
  /** The cuts around the one draft write this entry committed, for the model's echo. */
  cut?: { before: Uint8Array; after: Uint8Array };
  source: "agent" | "writer";
  committed: ComputedInverseEdit[];
  reversed: Map<BranchId | null, number>;
  outcomes: { documentId: string; branchId: BranchId | null; draftId: string | null }[];
};

export function planInverseDocument(
  plan: PreparedDocumentInverse,
  query: TurnInverseQuery,
): PlannedInverse {
  const document = plan.document;
  const edits = new Map<ComputedInverseEdit, ComputedInverseEdit["parts"]>();
  for (const step of plan.steps) {
    // A step in an open draft is content: it is computed under the draft's hold, not here.
    if (step.kind === "content") continue;
    const view = document.live;
    edits.set(
      step.edit,
      step.edit.parts.map((part) => {
        const client =
          Y.decodeUpdate(part.update).structs[0]?.id.client ?? allocateDocumentClient(view);
        const provenance = captureMutationUpdates(view, () => {
          view.transact(() => {
            Y.applyUpdate(view, part.update);
            const planningClient = view.clientID;
            view.clientID = client;
            try {
              appendInverseRestorationFacts(view, part.aliases);
            } finally {
              view.clientID = planningClient;
            }
          });
        });
        return {
          ...part,
          update: provenance.length ? Y.mergeUpdates([part.update, ...provenance]) : part.update,
        };
      }),
    );
  }
  return {
    plan,
    documentId: document.documentId,
    edits,
    updates: [],
    live: plan.steps.some((step) => step.kind === "kernel"),
    contentDrafts: new Set(),
    source: query.model ? "agent" : "writer",
    committed: [],
    reversed: new Map(),
    outcomes: [],
  };
}
