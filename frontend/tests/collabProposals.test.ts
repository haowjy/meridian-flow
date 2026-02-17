import { describe, expect, it } from "vitest";
import {
  buildProposalAcceptCommand,
  buildProposalRejectCommand,
  createProposalManager,
  type Proposal,
} from "@meridian/cm6-collab";

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "proposal-1",
    documentId: "doc-1",
    source: "ai",
    producerAgentType: "editing_agent",
    threadId: "thread-1",
    turnId: null,
    agentRunId: "run-1",
    proposalGroupId: null,
    status: "proposed",
    yjsUpdate: "base64-update",
    description: null,
    createdByUserId: "user-1",
    createdAt: "2026-02-16T10:30:00Z",
    ...overrides,
  };
}

describe("proposal manager", () => {
  it("replaces pending proposals on snapshot", () => {
    const manager = createProposalManager();
    manager.onProposalNew({
      type: "proposal:new",
      proposal: makeProposal({ id: "old-proposal" }),
    });

    manager.onProposalSnapshot({
      type: "proposal:snapshot",
      proposals: [makeProposal({ id: "snapshot-proposal", yjsUpdate: undefined })],
    });

    const state = manager.getState();
    expect(Array.from(state.proposals.keys())).toEqual(["snapshot-proposal"]);
  });

  it("upserts proposal on proposal:new", () => {
    const manager = createProposalManager();

    manager.onProposalNew({
      type: "proposal:new",
      proposal: makeProposal({ id: "proposal-upsert", description: "first" }),
    });
    manager.onProposalNew({
      type: "proposal:new",
      proposal: makeProposal({ id: "proposal-upsert", description: "second" }),
    });

    const state = manager.getState();
    expect(state.proposals.size).toBe(1);
    expect(state.proposals.get("proposal-upsert")?.description).toBe("second");
  });

  it("removes proposal when status changes to terminal", () => {
    const manager = createProposalManager();
    manager.onProposalNew({
      type: "proposal:new",
      proposal: makeProposal({ id: "proposal-terminal" }),
    });

    manager.onProposalStatusChanged({
      type: "proposal:statusChanged",
      proposalId: "proposal-terminal",
      status: "accepted",
    });

    const state = manager.getState();
    expect(state.proposals.has("proposal-terminal")).toBe(false);
  });

  it("stores group accept results without forcing proposal transitions", () => {
    const manager = createProposalManager();
    manager.onProposalNew({
      type: "proposal:new",
      proposal: makeProposal({ id: "proposal-group" }),
    });

    manager.onProposalGroupAcceptResult({
      type: "proposal:groupAcceptResult",
      outcomes: [{ proposalId: "proposal-group", status: "accepted" }],
    });

    const state = manager.getState();
    expect(state.lastGroupAcceptResult?.outcomes).toEqual([
      { proposalId: "proposal-group", status: "accepted" },
    ]);
    expect(state.proposals.has("proposal-group")).toBe(true);
  });
});

describe("proposal command builders", () => {
  it("builds proposal:accept payload shape", () => {
    expect(
      buildProposalAcceptCommand({
        proposalId: "proposal-123",
        idempotencyKey: "idem-123",
      }),
    ).toEqual({
      type: "proposal:accept",
      proposalId: "proposal-123",
      idempotencyKey: "idem-123",
    });
  });

  it("builds proposal:reject payload shape", () => {
    expect(
      buildProposalRejectCommand({
        proposalId: "proposal-456",
      }),
    ).toEqual({
      type: "proposal:reject",
      proposalId: "proposal-456",
    });
  });
});
