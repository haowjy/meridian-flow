/** Pure attempt-local text planning for one captured inverse document. */
import type { ComputedInverseEdit } from "@meridian/agent-edit/integration";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import type { BranchId, LiveTreeState } from "@meridian/contracts";
import type { EditOrigin } from "@meridian/database";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { appendInverseRestorationFacts } from "../domain/provenance.js";
import type { PreparedDocumentInverse, TurnInverseQuery } from "../domain/turn-inverse-service.js";

export type PlannedInverse = {
  plan: PreparedDocumentInverse;
  documentId: import("@meridian/contracts").DocumentId;
  edits: Map<ComputedInverseEdit, ComputedInverseEdit["parts"]>;
  updates: { draftId: string | null; update: Uint8Array }[];
  drafts: Map<string, PlannedDraft>;
  live: boolean;
  source: "agent" | "writer";
  made: Map<number, LiveTreeState>;
  living: boolean;
  committed: ComputedInverseEdit[];
  stopped: boolean;
  reversed: Map<BranchId | null, number>;
};

export type PlannedDraft = {
  draftId: string;
  revision: number;
  view: Y.Doc;
  edits: ComputedInverseEdit[];
  origins: Map<ComputedInverseEdit, EditOrigin[]>;
};

export function planInverseDocument(
  plan: PreparedDocumentInverse,
  query: TurnInverseQuery,
): PlannedInverse {
  const document = plan.document;
  const edits = new Map<ComputedInverseEdit, ComputedInverseEdit["parts"]>();
  const drafts = new Map<string, PlannedDraft>();
  for (const step of plan.steps) {
    if (step.kind !== "text") continue;
    let view = document.live;
    if (step.draftId) {
      const captured = document.drafts.get(step.draftId);
      if (!captured) throw new Error("A draft text step's draft was not captured");
      const draft: PlannedDraft = drafts.get(step.draftId) ?? {
        draftId: step.draftId,
        revision: captured.documentDraft.revision,
        view: captured.doc,
        edits: [],
        origins: new Map(),
      };
      drafts.set(step.draftId, draft);
      draft.edits.push(step.edit);
      view = draft.view;
    }
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
  const text = plan.steps.filter((step) => step.kind === "text");
  return {
    plan,
    documentId: document.documentId,
    edits,
    updates: [],
    drafts,
    live: !text.length || text.some((step) => !step.draftId),
    source: query.model ? "agent" : "writer",
    made: new Map(),
    living: document.treeStates.live?.living ?? document.removal === null,
    committed: [],
    stopped: false,
    reversed: new Map(),
  };
}
