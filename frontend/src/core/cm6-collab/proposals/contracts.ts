export interface Proposal {
  id: string;
  documentId: string;
  source: "ai" | "template" | "user_suggestion";
  producerAgentType: string;
  threadId: string;
  turnId: string | null;
  agentRunId: string;
  proposalGroupId: string | null;
  status: "proposed";
  yjsUpdate?: string;
  description: string | null;
  createdByUserId: string;
  createdAt: string;
}

export interface ProposalSnapshotEvent {
  type: "proposal:snapshot";
  documentId: string;
  proposals: Proposal[];
}

export interface ProposalNewEvent {
  type: "proposal:new";
  proposal: Proposal;
}

export interface ProposalStatusChangedEvent {
  type: "proposal:statusChanged";
  documentId: string;
  proposalId: string;
  status: "accepted" | "rejected";
}

export interface ProposalGroupAcceptOutcome {
  proposalId: string;
  status: "accepted" | "skipped";
  error?: string;
}

export interface ProposalGroupAcceptResultEvent {
  type: "proposal:groupAcceptResult";
  documentId: string;
  outcomes: ProposalGroupAcceptOutcome[];
}

export interface ProposalUpdateDataEvent {
  type: "proposal:updateData";
  documentId: string;
  proposalId: string;
  yjsUpdate: string;
}

export type ProposalServerEvent =
  | ProposalSnapshotEvent
  | ProposalNewEvent
  | ProposalStatusChangedEvent
  | ProposalGroupAcceptResultEvent
  | ProposalUpdateDataEvent;

export function isProposalSnapshotEvent(
  event: unknown,
): event is ProposalSnapshotEvent {
  if (!isRecord(event)) {
    return false;
  }
  return (
    event.type === "proposal:snapshot" &&
    typeof event.documentId === "string" &&
    Array.isArray(event.proposals)
  );
}

export function isProposalNewEvent(
  event: unknown,
): event is ProposalNewEvent {
  if (!isRecord(event)) {
    return false;
  }
  return event.type === "proposal:new" && typeof event.proposal === "object";
}

export function isProposalStatusChangedEvent(
  event: unknown,
): event is ProposalStatusChangedEvent {
  if (!isRecord(event)) {
    return false;
  }
  return (
    event.type === "proposal:statusChanged" &&
    typeof event.documentId === "string" &&
    typeof event.proposalId === "string" &&
    (event.status === "accepted" || event.status === "rejected")
  );
}

export function isProposalGroupAcceptResultEvent(
  event: unknown,
): event is ProposalGroupAcceptResultEvent {
  if (!isRecord(event)) {
    return false;
  }
  return (
    event.type === "proposal:groupAcceptResult" &&
    typeof event.documentId === "string" &&
    Array.isArray(event.outcomes)
  );
}

export function isProposalUpdateDataEvent(
  event: unknown,
): event is ProposalUpdateDataEvent {
  if (!isRecord(event)) {
    return false;
  }
  return (
    event.type === "proposal:updateData" &&
    typeof event.documentId === "string" &&
    typeof event.proposalId === "string" &&
    typeof event.yjsUpdate === "string"
  );
}

function isRecord(event: unknown): event is Record<string, unknown> {
  return event != null && typeof event === "object";
}

export interface ProposalAcceptCommand {
  type: "proposal:accept";
  documentId: string;
  proposalId: string;
  idempotencyKey: string;
}

export interface ProposalRejectCommand {
  type: "proposal:reject";
  documentId: string;
  proposalId: string;
}

export interface ProposalRequestUpdateCommand {
  type: "proposal:requestUpdate";
  documentId: string;
  proposalId: string;
}

export function buildProposalRequestUpdateCommand(params: {
  documentId: string;
  proposalId: string;
}): ProposalRequestUpdateCommand {
  return {
    type: "proposal:requestUpdate",
    documentId: params.documentId,
    proposalId: params.proposalId,
  };
}

export interface ProposalGroupAcceptCommand {
  type: "proposal:groupAccept";
  documentId: string;
  groupId: string;
  idempotencyKey: string;
}

export function buildProposalAcceptCommand(params: {
  documentId: string;
  proposalId: string;
  idempotencyKey: string;
}): ProposalAcceptCommand {
  return {
    type: "proposal:accept",
    documentId: params.documentId,
    proposalId: params.proposalId,
    idempotencyKey: params.idempotencyKey,
  };
}

export function buildProposalRejectCommand(params: {
  documentId: string;
  proposalId: string;
}): ProposalRejectCommand {
  return {
    type: "proposal:reject",
    documentId: params.documentId,
    proposalId: params.proposalId,
  };
}

export function buildProposalGroupAcceptCommand(params: {
  documentId: string;
  groupId: string;
  idempotencyKey: string;
}): ProposalGroupAcceptCommand {
  return {
    type: "proposal:groupAccept",
    documentId: params.documentId,
    groupId: params.groupId,
    idempotencyKey: params.idempotencyKey,
  };
}

/**
 * Client-side-only chunk resolution marker for partial proposal flows.
 * Distinguishes plain accept from accept-with-edits without changing
 * backend event contracts.
 */
export type ProposalChunkResolutionStatus =
  | "accepted"
  | "accepted_with_edits"
  | "rejected";

export interface ProposalChunkResolution {
  chunkId: string;
  status: ProposalChunkResolutionStatus;
}

/**
 * Client-side partial accept command: identifies which chunks from a proposal
 * were accepted by the user. Used for local finalization logic.
 * The actual Yjs edits are applied directly to the Y.Doc; the backend is
 * sent a standard reject command to close the proposal.
 */
export interface ProposalPartialAcceptCommand {
  type: "proposal:partialAccept";
  documentId: string;
  proposalId: string;
  /** Chunk IDs that were accepted (their edits are already applied to the Y.Doc). */
  acceptedChunkIds: string[];
  /** Chunk IDs that were rejected (no edits applied). */
  rejectedChunkIds: string[];
  /** Optional richer per-chunk local marker including edited accepts. */
  resolutions?: ProposalChunkResolution[];
}

export function buildProposalPartialAcceptCommand(params: {
  documentId: string;
  proposalId: string;
  acceptedChunkIds: string[];
  rejectedChunkIds: string[];
  resolutions?: ProposalChunkResolution[];
}): ProposalPartialAcceptCommand {
  return {
    type: "proposal:partialAccept",
    documentId: params.documentId,
    proposalId: params.proposalId,
    acceptedChunkIds: params.acceptedChunkIds,
    rejectedChunkIds: params.rejectedChunkIds,
    ...(params.resolutions !== undefined
      ? { resolutions: params.resolutions }
      : {}),
  };
}
