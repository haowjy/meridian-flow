import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createProposalReviewRuntime, type Proposal } from "@meridian/cm6-collab";
import {
  invokeSelectedProposalAction,
  resolveSelectedProposalId,
  sortPendingProposals,
} from "@/features/documents/components/AIProposalReviewPanel";

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
    yjsUpdate: undefined,
    description: null,
    createdByUserId: "user-1",
    createdAt: "2026-02-16T10:30:00Z",
    ...overrides,
  };
}

function createBaseDoc(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  return doc;
}

function buildRelativeUpdate(baseDoc: Y.Doc, applyEdit: (doc: Y.Doc) => void): string {
  const working = new Y.Doc();
  Y.applyUpdate(working, Y.encodeStateAsUpdate(baseDoc));

  const before = Y.encodeStateVector(working);
  applyEdit(working);
  const update = Y.encodeStateAsUpdate(working, before);

  let raw = "";
  for (let i = 0; i < update.length; i += 1) {
    raw += String.fromCharCode(update[i] ?? 0);
  }
  return btoa(raw);
}

describe("proposal review runtime", () => {
  it("derives a ready review model from current yjs state + update bytes", () => {
    const ydoc = createBaseDoc("hello");
    const runtime = createProposalReviewRuntime({ ydoc });

    const update = buildRelativeUpdate(ydoc, (doc) => {
      doc.getText("content").insert(5, " world");
    });

    const model = runtime.deriveProposalReview(
      makeProposal({
        id: "proposal-ready",
        yjsUpdate: update,
      }),
    );

    expect(model.availability).toBe("ready");
    if (model.availability === "ready") {
      expect(model.baseText).toBe("hello");
      expect(model.proposedText).toBe("hello world");
      expect(model.hasChanges).toBe(true);
    }
  });

  it("returns unavailable when proposal update bytes are missing", () => {
    const ydoc = createBaseDoc("hello");
    const runtime = createProposalReviewRuntime({ ydoc });

    const model = runtime.deriveProposalReview(
      makeProposal({
        id: "proposal-missing",
        yjsUpdate: undefined,
      }),
    );

    expect(model.availability).toBe("unavailable");
    if (model.availability === "unavailable") {
      expect(model.reason).toBe("missing_update");
    }
  });

  it("returns unavailable when proposal payload is malformed", () => {
    const ydoc = createBaseDoc("hello");
    const runtime = createProposalReviewRuntime({ ydoc });

    const model = runtime.deriveProposalReview(
      makeProposal({
        id: "proposal-invalid",
        yjsUpdate: "%%%not_base64%%%",
      }),
    );

    expect(model.availability).toBe("unavailable");
    if (model.availability === "unavailable") {
      expect(model.reason).toBe("invalid_update");
    }
  });
});

describe("proposal review panel helpers", () => {
  it("sorts pending proposals by createdAt ASC then id ASC", () => {
    const sorted = sortPendingProposals([
      makeProposal({ id: "b", createdAt: "2026-02-16T10:30:00Z" }),
      makeProposal({ id: "a", createdAt: "2026-02-16T10:30:00Z" }),
      makeProposal({ id: "c", createdAt: "2026-02-16T10:20:00Z" }),
    ]);

    expect(sorted.map((proposal) => proposal.id)).toEqual(["c", "a", "b"]);
  });

  it("resolves selection fallback when current proposal disappears", () => {
    const proposals = sortPendingProposals([
      makeProposal({ id: "proposal-2", createdAt: "2026-02-16T10:31:00Z" }),
      makeProposal({ id: "proposal-1", createdAt: "2026-02-16T10:30:00Z" }),
    ]);

    expect(resolveSelectedProposalId("missing", proposals)).toBe("proposal-1");
    expect(resolveSelectedProposalId("proposal-2", proposals)).toBe("proposal-2");
    expect(resolveSelectedProposalId(null, proposals)).toBe("proposal-1");
  });

  it("invokes accept/reject callbacks only when there is a selected proposal", () => {
    const accept = vi.fn();
    const reject = vi.fn();

    expect(invokeSelectedProposalAction("proposal-1", accept)).toBe(true);
    expect(invokeSelectedProposalAction(null, reject)).toBe(false);

    expect(accept).toHaveBeenCalledWith("proposal-1");
    expect(reject).not.toHaveBeenCalled();
  });
});
