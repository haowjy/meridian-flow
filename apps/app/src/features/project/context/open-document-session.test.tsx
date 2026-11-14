// @vitest-environment jsdom
/** The live-room binding at the desktop editor host. */

import { act, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentSession } from "@/core/editor/document-session";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { AdmittedLiveDocument } from "./open-project-document";
import { ProjectDocumentLiveOpenerContext } from "./project-document-live-opener-context";

const reportError = vi.fn();

vi.mock("./account-feature-context", () => ({
  useOptionalProjectContextAvailabilityCoordinator: () => null,
  useLiveDocumentSessionRegistry: () => ({
    whenRefusedRoomDropped: () => null,
    observeDraftRoom: () => () => undefined,
  }),
}));

import { OpenDocumentSessionBoundary } from "./open-document-session";

function session(): DocumentSession {
  return {
    getSnapshot: () => ({ status: "synced", schemaFence: null }),
    subscribe: () => () => undefined,
  } as unknown as DocumentSession;
}

function admission(boundSession: DocumentSession): AdmittedLiveDocument {
  return {
    projectId: "project-a",
    documentId: "document-a",
    generation: "2",
    bind: async () => ({
      projectId: "project-a",
      documentId: "document-a",
      generation: "2",
      session: boundSession,
      release: vi.fn(),
    }),
  };
}

/** No open is in flight from a door, so no transfer to take over. */
const noTransfer = {
  transferToken: () => null,
  takeTransfer: () => null,
  disposeTransfer: () => undefined,
};

describe("OpenDocumentSessionBoundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("reportError", reportError);
  });

  it("binds the live room through the opener", async () => {
    const serverSession = session();
    const opener = {
      ...noTransfer,
      open: vi.fn(async () => ({ kind: "opened", admission: admission(serverSession) })),
    };
    const observed: Array<{ value: DocumentSession | null; failed: boolean }> = [];

    await withReactRoot(
      <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
        <OpenDocumentSessionBoundary
          projectId="project-a"
          documentId="document-a"
          availabilityRevision="catalog-1"
        >
          {(value, failed) => {
            observed.push({ value, failed });
            return null;
          }}
        </OpenDocumentSessionBoundary>
      </ProjectDocumentLiveOpenerContext.Provider>,
      async () => {
        await act(async () => undefined);
        expect(opener.open).toHaveBeenCalledOnce();
        expect(observed.at(-1)).toEqual({ value: serverSession, failed: false });
      },
    );
  });
});
