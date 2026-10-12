/** Shared account/thread row model and mounted creation provenance. */

import type { ChatSubmissionOwner } from "./owner";
import type { ChatSubmission } from "./store";

export type Row = {
  threadId: string;
  turnId: string;
  fresh: boolean;
  failed?: boolean;
  localFailure?: boolean;
  ambiguous?: boolean;
  busy?: boolean;
  status?: "error";
  attempt?: { session: object; submissionId: string; signal: AbortSignal };
};
type RecoveryState = {
  recordId: string;
  submissionId: string;
  editable?: boolean;
  busy?: boolean;
  moving?: boolean;
};
export type CreationState =
  | { kind: "unknown" | "confirmed" | "dissolved" }
  | {
      kind: "root-unconfirmed";
      creation: NonNullable<ChatSubmission["creation"]>;
      projectId: string;
    };
export type ThreadModel = {
  creation: CreationState;
  reconciling: boolean;
  epoch: number;
  rows: Map<string, Row>;
  presentation: Map<string, RecoveryState>;
  bindings: Set<ChatSubmissionOwner>;
};
const models = new Map<string, ThreadModel>();
export function threadModel(accountId: string, threadId: string, epoch: number): ThreadModel {
  const id = JSON.stringify([accountId, threadId]);
  let model = models.get(id);
  if (!model || model.epoch !== epoch) {
    model = {
      epoch,
      creation: { kind: "unknown" },
      reconciling: false,
      rows: new Map(),
      presentation: new Map(),
      bindings: new Set(),
    };
    models.set(id, model);
  }
  return model;
}
/** The existing account/thread model is the sole source of mounted creation provenance. */
export function chatSubmissionMountState(accountId: string, threadId: string, epoch: number) {
  const model = models.get(JSON.stringify([accountId, threadId]));
  const bindings = model?.epoch === epoch ? [...model.bindings] : [];
  return {
    mounted: bindings.length > 0,
    creating: model?.epoch === epoch && model.creation.kind === "root-unconfirmed",
  };
}

/** Positive server evidence belongs to every binding, even before journal cleanup finishes. */
export function confirmChatCreation(accountId: string, threadId: string, epoch: number) {
  const model = threadModel(accountId, threadId, epoch);
  model.creation = { kind: "confirmed" };
}
