/** Ordering and failure-contract coverage for document projection refresh effects. */
import { describe, expect, it, vi } from "vitest";
import { createProjectionEffectsDocumentWriteHook } from "./document-projection-refresher.js";
import type { DocumentProjectionEffects } from "./ports/document-projection-effects.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000501";
const THREAD_ID = "00000000-0000-4000-8000-000000000502";

describe("projection effects document write hook", () => {
  it("settles activity and projection independently and reports the first failure", async () => {
    const activityFailure = new Error("activity failed");
    const projectionFailure = new Error("projection failed");
    const effects: DocumentProjectionEffects = {
      touchDocumentActivity: vi.fn(async () => {
        throw activityFailure;
      }),
      updateProjection: vi.fn(async () => {
        throw projectionFailure;
      }),
      applyPushCompletion: vi.fn(),
    };
    const hook = createProjectionEffectsDocumentWriteHook(effects);
    const at = new Date("2026-07-24T12:00:00.000Z");

    await expect(
      hook({
        documentId: DOCUMENT_ID,
        threadId: THREAD_ID,
        markdown: "projection",
        at,
      }),
    ).rejects.toBe(activityFailure);
    expect(effects.touchDocumentActivity).toHaveBeenCalledWith({
      documentId: DOCUMENT_ID,
      threadId: THREAD_ID,
      at,
    });
    expect(effects.updateProjection).toHaveBeenCalledWith({
      documentId: DOCUMENT_ID,
      markdown: "projection",
      at,
    });
  });
});
