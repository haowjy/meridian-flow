import type {
  Proposal,
  ProposalGroupAcceptResultEvent,
  ProposalNewEvent,
  ProposalSnapshotEvent,
  ProposalStatusChangedEvent,
  ProposalUpdateDataEvent,
} from "./contracts";

export interface ProposalStateSnapshot {
  proposals: Map<string, Proposal>;
  lastGroupAcceptResult: ProposalGroupAcceptResultEvent | null;
}

export interface CreateProposalManagerOptions {
  onStateChange?: (state: ProposalStateSnapshot) => void;
}

/**
 * Proposal state runtime that is transport-agnostic.
 * The host app routes validated WS JSON proposal events into this manager.
 */
export class ProposalManager {
  private proposals = new Map<string, Proposal>();
  private lastGroupAcceptResult: ProposalGroupAcceptResultEvent | null = null;
  private readonly onStateChange?: (state: ProposalStateSnapshot) => void;

  constructor(options: CreateProposalManagerOptions = {}) {
    this.onStateChange = options.onStateChange;
  }

  getState(): ProposalStateSnapshot {
    return {
      proposals: new Map(this.proposals),
      lastGroupAcceptResult: cloneGroupAcceptResult(this.lastGroupAcceptResult),
    };
  }

  onProposalSnapshot(event: ProposalSnapshotEvent): void {
    const next = new Map<string, Proposal>();
    for (const proposal of event.proposals) {
      if (proposal.status === "proposed") {
        next.set(proposal.id, proposal);
      }
    }
    this.proposals = next;
    this.emit();
  }

  onProposalNew(event: ProposalNewEvent): void {
    const { proposal } = event;
    if (proposal.status !== "proposed") {
      this.proposals.delete(proposal.id);
      this.emit();
      return;
    }

    this.proposals.set(proposal.id, proposal);
    this.emit();
  }

  onProposalStatusChanged(event: ProposalStatusChangedEvent): void {
    if (event.status !== "accepted" && event.status !== "rejected") {
      return;
    }

    this.proposals.delete(event.proposalId);
    this.emit();
  }

  /**
   * Updates an existing proposal's yjsUpdate field in-place.
   * Called when the server responds to a proposal:requestUpdate command
   * with the lazy-fetched update data.
   */
  onProposalUpdateData(event: ProposalUpdateDataEvent): void {
    const existing = this.proposals.get(event.proposalId);
    if (!existing) {
      return;
    }
    // Update the proposal in-place with the yjsUpdate data
    this.proposals.set(event.proposalId, {
      ...existing,
      yjsUpdate: event.yjsUpdate,
    });
    this.emit();
  }

  onProposalGroupAcceptResult(event: ProposalGroupAcceptResultEvent): void {
    this.lastGroupAcceptResult = cloneGroupAcceptResult(event);
    this.emit();
  }

  /** Quick check for gating expensive derivations (e.g. reviewRevision bump). */
  hasProposals(): boolean {
    return this.proposals.size > 0;
  }

  clear(): void {
    this.proposals.clear();
    this.lastGroupAcceptResult = null;
    this.emit();
  }

  private emit(): void {
    this.onStateChange?.(this.getState());
  }
}

export function createProposalManager(
  options?: CreateProposalManagerOptions,
): ProposalManager {
  return new ProposalManager(options);
}

function cloneGroupAcceptResult(
  event: ProposalGroupAcceptResultEvent | null,
): ProposalGroupAcceptResultEvent | null {
  if (event == null) {
    return null;
  }

  return {
    type: event.type,
    documentId: event.documentId,
    outcomes: event.outcomes.map((outcome) => ({
      proposalId: outcome.proposalId,
      status: outcome.status,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    })),
  };
}
