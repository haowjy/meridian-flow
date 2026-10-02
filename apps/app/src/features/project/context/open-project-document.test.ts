/** Live opener admission binds the current registry session after room repair. */
import { describe, expect, it, vi } from "vitest";
import type { DocumentSession } from "@/core/editor/document-session";
import { ProjectDocumentLiveOpener } from "./open-project-document";

function session(status: "access-lost" | "synced"): DocumentSession {
  return {
    getSnapshot: () => ({ status, connectionState: null }),
  } as unknown as DocumentSession;
}

describe("ProjectDocumentLiveOpener", () => {
  it("returns the replacement session when an unavailable room is restarted", async () => {
    const stale = session("access-lost");
    const replacement = session("synced");
    const lease = { projectId: "project-a", documentId: "document-a", generation: "2" };
    const registry = {
      admit: vi.fn(async () => lease),
      retain: vi.fn(),
      get: vi.fn().mockReturnValueOnce(stale).mockReturnValue(replacement),
      release: vi.fn(),
      restartUnavailableRoom: vi.fn(async () => undefined),
    };
    const opener = new ProjectDocumentLiveOpener({
      availability: {
        resolveForOpen: vi.fn(async () => ({
          kind: "available",
          documentId: "document-a",
          generation: "2",
          entry: { editable: true },
        })),
      } as never,
      registry: registry as never,
      epochSignal: new AbortController().signal,
    });

    const opened = await opener.open({
      source: "server",
      projectId: "project-a",
      documentId: "document-a",
    });
    if (opened.kind !== "opened") throw new Error("expected opened admission");
    const binding = await opened.admission.bind("editor-host");

    expect(registry.restartUnavailableRoom).toHaveBeenCalledWith(lease);
    expect(binding.session).toBe(replacement);
    binding.release();
    expect(registry.release).toHaveBeenCalledWith("editor-host");
  });
});
