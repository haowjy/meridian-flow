/** Effective document reads follow the destination (D40). */

import { describe, expect, it, vi } from "vitest";
import { createEffectiveDocumentReader } from "./effective-document-reader.js";

describe("effective document reader destinations (D40)", () => {
  function reader(staged?: { destination: "live" | "draft" }) {
    const branches = {
      resolveThreadBranch: vi.fn(),
      resolveWorkDraftBranchForThread: vi.fn(),
    };
    const branchPulls = { pullThreadPeer: vi.fn(), flushLivePull: vi.fn() };
    const readVersionedMarkdown = vi.fn(async () => ({
      ok: true as const,
      value: { content: "Live text.", revision: "y1:live" },
    }));
    const effective = createEffectiveDocumentReader({
      branches: branches as never,
      branchCoordinator: {} as never,
      branchPulls: branchPulls as never,
      liveCoordinator: {} as never,
      agentEdit: {
        responseDocuments: () => ({ staged: [], created: [] }),
        hasResponseDocument: () => staged !== undefined,
        responseDestination: () =>
          staged?.destination === "draft"
            ? { kind: "draft", workId: "work-a", workSlug: "a" }
            : staged && { kind: "live" },
      } as never,
      documents: { readVersionedMarkdown } as never,
      model: {} as never,
      codec: {} as never,
    });
    return { effective, readVersionedMarkdown };
  }

  it("leaves out this reply's drafted writes when it reads live", async () => {
    const { effective, readVersionedMarkdown } = reader({ destination: "draft" });

    const read = await effective.readEffectiveMarkdown({
      documentId: "00000000-0000-4000-8000-000000000358" as never,
      threadId: "00000000-0000-4000-8000-000000000357" as never,
      responseId: "response-1",
      destination: "live",
    });

    expect(read).toEqual({ ok: true, value: { content: "Live text.", revision: "y1:live" } });
    expect(readVersionedMarkdown).toHaveBeenCalledOnce();
  });
});
