// @vitest-environment jsdom
/** A failed first-content journal write retries while the same editor remains mounted. */
import { act } from "react";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ContextEditorMountHost } from "./ContextEditorMountHost";

const runtime = vi.hoisted(() => {
  const state = { session: null as unknown };
  return {
    state,
    resources: {
      openDocument: async () => ({
        kind: "opened",
        handle: {
          documentId: "document",
          get session() {
            return state.session;
          },
          release() {},
        },
      }),
    },
  };
});
vi.mock("./account-feature-context", () => ({
  useAccountResourceReplica: () => runtime.resources,
}));
vi.mock("@/features/chat/DraftReviewProvider", () => ({
  useDraftReview: () => ({
    controller: { inlineReview: null },
    reviewRoomNameForDraft: () => null,
    setActiveEditorDocumentId: () => undefined,
  }),
}));
vi.mock("@/features/editor/EditorView", () => ({ EditorView: () => null }));
vi.mock("./use-live-document-binding", () => ({
  useLiveDocumentBinding: () => ({
    state: { kind: "absent" },
    retry() {},
    adoptAndAcknowledge: async () => ({ kind: "unclaimed" }),
  }),
}));

it("retries eligibility persistence after a transient failure", async () => {
  const document = new Y.Doc();
  runtime.state.session = {
    document,
    fragmentName: "default",
    whenLocalPersistenceSynced: async () => undefined,
    suspendPresence() {},
    resumePresence() {},
  };
  const becameNonEmpty = vi
    .fn<(documentId: string) => Promise<void>>()
    .mockRejectedValueOnce(new Error("metadata temporarily unavailable"))
    .mockResolvedValue(undefined);

  await withReactRoot(
    <ContextEditorMountHost
      projectId="project"
      workId={null}
      trackedTabs={[
        {
          tabInstanceId: "member",
          kind: "new",
          documentId: "document",
          name: "Untitled",
          resourceHandle: "resource",
        },
      ]}
      activeTabId="document"
      active
      onUntitledBecameNonEmpty={becameNonEmpty}
    />,
    async () => {
      const text = new Y.XmlText();
      text.insert(0, "first words");
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.push([text]);
      await act(async () => {
        document.getXmlFragment("default").push([paragraph]);
        await Promise.resolve();
      });
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(becameNonEmpty).toHaveBeenCalledTimes(2);
      expect(becameNonEmpty).toHaveBeenLastCalledWith("document");
    },
  );
});
