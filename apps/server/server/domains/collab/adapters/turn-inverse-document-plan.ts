/** Pure attempt-local text planning for one captured inverse document. */
import { appendRestorationLinks } from "@meridian/agent-edit/diff";
import type { ComputedInverseEdit } from "@meridian/agent-edit/integration";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import type { BranchId } from "@meridian/contracts";
import type { EditOrigin } from "@meridian/database";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { InverseDestination } from "../domain/inverse-draft-destination.js";
import { appendInverseRestorationFacts } from "../domain/provenance.js";
import type { PreparedDocumentInverse, TurnInverseQuery } from "../domain/turn-inverse-service.js";

export type PlannedInverse = {
  plan: PreparedDocumentInverse;
  documentId: import("@meridian/contracts").DocumentId;
  edits: Map<ComputedInverseEdit, ComputedInverseEdit["parts"]>;
  updates: { draftId: string | null; update: Uint8Array }[];
  drafts: Map<InverseDestination, PlannedDraft>;
  live: boolean;
  source: "agent" | "writer";
  committed: ComputedInverseEdit[];
  reversed: Map<BranchId | null, number>;
  outcomes: { documentId: string; branchId: BranchId | null; draftId: string | null }[];
};

export type PlannedDraft = {
  destination: Exclude<InverseDestination, { kind: "live" } | { state: "gone" }>;
  draftId: string;
  revision: number;
  branchId: BranchId;
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
  const drafts = new Map<InverseDestination, PlannedDraft>();
  for (const step of plan.steps) {
    let view = document.live;
    if (step.destination.kind === "draft") {
      if (step.destination.state === "gone")
        throw new Error("A gone destination cannot have a text step");
      const destination = step.destination;
      const draft: PlannedDraft = drafts.get(destination) ?? {
        destination,
        draftId: destination.draftId,
        revision: destination.revision,
        branchId: destination.branchId,
        view: destination.view,
        edits: [],
        origins: new Map(),
      };
      drafts.set(destination, draft);
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
              if (step.destination.kind === "draft") appendRestorationLinks(view, part.aliases);
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
    drafts,
    live: plan.steps.some((step) => step.destination.kind === "live"),
    source: query.model ? "agent" : "writer",
    committed: [],
    reversed: new Map(),
    outcomes: [],
  };
}
