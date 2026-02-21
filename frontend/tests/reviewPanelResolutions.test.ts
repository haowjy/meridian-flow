import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@meridian/cm6-collab", () => ({
  commitChunkEditSession: vi.fn(),
  cancelChunkEditSession: vi.fn(),
  startChunkEditSession: vi.fn(),
  updateChunkEditSession: vi.fn(),
}));

let setChunkResolutionStatus: typeof import("@/features/documents/components/AIProposalReviewPanel").setChunkResolutionStatus;
let countChunkResolutions: typeof import("@/features/documents/components/AIProposalReviewPanel").countChunkResolutions;

beforeAll(async () => {
  const panel = await import(
    "@/features/documents/components/AIProposalReviewPanel"
  );
  setChunkResolutionStatus = panel.setChunkResolutionStatus;
  countChunkResolutions = panel.countChunkResolutions;
});

describe("review panel resolution helpers", () => {
  it("counts accepted_with_edits as accepted while preserving rejected count", () => {
    let resolutions = new Map<
      string,
      Map<string, "accepted" | "accepted_with_edits" | "rejected">
    >();
    resolutions = setChunkResolutionStatus(
      resolutions,
      "proposal-1",
      "chunk-1",
      "accepted",
    );
    resolutions = setChunkResolutionStatus(
      resolutions,
      "proposal-1",
      "chunk-2",
      "accepted_with_edits",
    );
    resolutions = setChunkResolutionStatus(
      resolutions,
      "proposal-1",
      "chunk-3",
      "rejected",
    );

    expect(countChunkResolutions(resolutions.get("proposal-1"))).toEqual({
      acceptedCount: 2,
      rejectedCount: 1,
    });
  });
});
