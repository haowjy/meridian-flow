/** Pure attempt-local text planning for one captured inverse document. */
import { captureDelta, type StoredDelta } from "@meridian/agent-edit/content-merge";
import { readBlocks } from "@meridian/agent-edit/diff";
import type { ComputedInverseEdit } from "@meridian/agent-edit/integration";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import type { BranchId } from "@meridian/contracts";
import { allocateDocumentClient, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { draftSchema } from "../domain/draft-changes.js";
import { appendInverseRestorationFacts } from "../domain/provenance.js";
import type { PreparedDocumentInverse, TurnInverseQuery } from "../domain/turn-inverse-service.js";

export type PlannedInverse = {
  plan: PreparedDocumentInverse;
  documentId: import("@meridian/contracts").DocumentId;
  /** Each live step's parts, with their restoration facts on this attempt's copy of Live. */
  edits: Map<
    ComputedInverseEdit,
    (ComputedInverseEdit["parts"][number] & { delta: StoredDelta | null })[]
  >;
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
  const edits: PlannedInverse["edits"] = new Map();
  for (const step of plan.steps) {
    // A content or manuscript step is computed under its draft's hold or Live's key, not here.
    if (step.kind !== "kernel") continue;
    const view = document.live;
    edits.set(
      step.edit,
      step.edit.parts.map((part) => {
        const client =
          Y.decodeUpdate(part.update).structs[0]?.id.client ?? allocateDocumentClient(view);
        const fragment = view.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
        // What this Undo or revert did to the text, so the card can take it out by content.
        const textBefore = readBlocks(fragment, draftSchema);
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
          delta: captureDelta(textBefore, readBlocks(fragment, draftSchema)),
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
