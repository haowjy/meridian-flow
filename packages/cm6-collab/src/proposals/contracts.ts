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
  proposals: Proposal[];
}

export interface ProposalNewEvent {
  type: "proposal:new";
  proposal: Proposal;
}

export interface ProposalStatusChangedEvent {
  type: "proposal:statusChanged";
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
  outcomes: ProposalGroupAcceptOutcome[];
}

export type ProposalServerEvent =
  | ProposalSnapshotEvent
  | ProposalNewEvent
  | ProposalStatusChangedEvent
  | ProposalGroupAcceptResultEvent;

export function isProposalSnapshotEvent(
  event: unknown,
): event is ProposalSnapshotEvent {
  if (!isRecord(event)) {
    return false;
  }
  return event.type === "proposal:snapshot" && Array.isArray(event.proposals);
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
  return event.type === "proposal:groupAcceptResult" && Array.isArray(event.outcomes);
}

function isRecord(event: unknown): event is Record<string, unknown> {
  return event != null && typeof event === "object";
}

export interface ProposalAcceptCommand {
  type: "proposal:accept";
  proposalId: string;
  idempotencyKey: string;
}

export interface ProposalRejectCommand {
  type: "proposal:reject";
  proposalId: string;
}

export interface ProposalGroupAcceptCommand {
  type: "proposal:groupAccept";
  groupId: string;
  idempotencyKey: string;
}

export function buildProposalAcceptCommand(params: {
  proposalId: string;
  idempotencyKey: string;
}): ProposalAcceptCommand {
  return {
    type: "proposal:accept",
    proposalId: params.proposalId,
    idempotencyKey: params.idempotencyKey,
  };
}

export function buildProposalRejectCommand(params: {
  proposalId: string;
}): ProposalRejectCommand {
  return {
    type: "proposal:reject",
    proposalId: params.proposalId,
  };
}

export function buildProposalGroupAcceptCommand(params: {
  groupId: string;
  idempotencyKey: string;
}): ProposalGroupAcceptCommand {
  return {
    type: "proposal:groupAccept",
    groupId: params.groupId,
    idempotencyKey: params.idempotencyKey,
  };
}
