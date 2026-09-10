// @vitest-environment jsdom
/** Open-tab binding lifetime is independent from warm editor view lifetime. */
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DocumentSession } from "@/core/editor/document-session";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ServerTabSessionBoundary } from "./ContextEditorMountHost";
import { ProjectDocumentLiveOpenerContext } from "./project-document-live-opener-context";

describe("ServerTabSessionBoundary", () => {
  it("survives warm-view eviction and releases only when the actual tab closes", async () => {
    const session = {} as DocumentSession;
    const release = vi.fn();
    const bind = vi.fn(async () => ({
      projectId: "project-a",
      documentId: "document-a",
      generation: "1",
      session,
      release,
    }));
    const opener = {
      open: vi.fn(async () => ({
        kind: "opened" as const,
        document: {} as never,
        admission: {
          projectId: "project-a",
          documentId: "document-a",
          generation: "1",
          bind,
        },
      })),
    };
    let setWarm!: (warm: boolean) => void;
    let setOpen!: (open: boolean) => void;
    const seen: Array<DocumentSession | null> = [];

    function Harness() {
      const [warm, updateWarm] = useState(true);
      const [open, updateOpen] = useState(true);
      setWarm = updateWarm;
      setOpen = updateOpen;
      return (
        <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
          {open ? (
            <ServerTabSessionBoundary projectId="project-a" documentId="document-a">
              {(bound) => {
                if (warm) seen.push(bound);
                return null;
              }}
            </ServerTabSessionBoundary>
          ) : null}
        </ProjectDocumentLiveOpenerContext.Provider>
      );
    }

    await withReactRoot(<Harness />, async () => {
      await act(async () => undefined);
      expect(seen).toContain(session);
      expect(bind).toHaveBeenCalledOnce();

      await act(async () => setWarm(false));
      expect(release).not.toHaveBeenCalled();

      await act(async () => setOpen(false));
      expect(release).toHaveBeenCalledOnce();
    });
  });
});
