// @vitest-environment jsdom
/** The phone hosts a pending new-document draft by its branch alone: no live room is acquired before Apply. */

import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ServerContextTab } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { MobileDocumentHost } from "./MobileDocumentHost";

const live = vi.hoisted(() => ({
  binding: vi.fn(() => ({ state: { kind: "idle" }, retry: vi.fn() })),
}));
const coordinator = vi.hoisted(() => ({
  bindRouteSelection: vi.fn(),
  rejectRouteCandidate: vi.fn(),
  activate: vi.fn(),
}));
const selection = vi.hoisted(() => ({
  value: {
    selection: {
      status: "candidate" as const,
      revision: 3,
      locator: { scheme: "manuscript", path: "/new-chapter.md", workId: "work-a" },
    },
    transitionRevision: 1,
  },
}));

vi.mock("../context/use-live-document-binding", () => ({ useLiveDocumentBinding: live.binding }));
vi.mock("../context/use-refused-edits-reopen", () => ({ useRefusedEditsReopen: () => null }));
vi.mock("../context/account-feature-context", () => ({
  useContextRemovalCoordinator: () => coordinator,
}));
vi.mock("../context/use-context-removal-project", () => ({
  useContextRemovalProject: () => selection.value,
}));
vi.mock("@/features/chat/DraftReviewProvider", () => ({
  useDraftReview: () => ({
    controller: {},
    reviewRoomNameForDraft: () => null,
    setActiveEditorDocumentId: vi.fn(),
  }),
}));
vi.mock("../context/ContextEditorMountHost", () => ({
  ContextEditorMountHost: (props: {
    trackedTabs: { documentId: string }[];
    activeTabId: string | null;
    readOnly?: boolean;
  }) => (
    <div
      data-mount-host
      data-tabs={props.trackedTabs.map((tab) => tab.documentId).join(",")}
      data-active={props.activeTabId ?? ""}
      data-read-only={String(props.readOnly === true)}
    />
  ),
}));

const draftTab: ServerContextTab = {
  kind: "tracked",
  documentId: "document-draft",
  scheme: "manuscript",
  path: "/new-chapter.md",
  name: "new-chapter.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
  draftOnly: true,
  reviewWorkId: "work-a",
  reviewDraftId: "draft-a",
};

describe("MobileDocumentHost draft-only review", () => {
  it("hosts the branch read-only, binds the route to the draft's document, and opens no live room", async () => {
    await withReactRoot(
      <MobileDocumentHost
        projectId="project-a"
        editorWorkId="work-a"
        route={{
          requested: true,
          scheme: "manuscript",
          path: "/new-chapter.md",
          tab: draftTab,
          catalogResolved: true,
          addressState: "settled" as const,
          isError: false,
          isFetching: false,
        }}
      />,
      async () => {
        await act(async () => undefined);
        const host = document.querySelector("[data-mount-host]");
        expect(host?.getAttribute("data-tabs")).toBe("document-draft");
        expect(host?.getAttribute("data-active")).toBe("document-draft");
        expect(host?.getAttribute("data-read-only")).toBe("true");
        expect(document.body.textContent).not.toContain("Couldn't open this document.");
        expect(live.binding).not.toHaveBeenCalled();
        expect(coordinator.bindRouteSelection).toHaveBeenCalledWith("project-a", 3, {
          kind: "server",
          documentId: "document-draft",
        });
        expect(coordinator.activate).not.toHaveBeenCalled();
      },
    );
  });

  const unadmitted = (addressState: "pending" | "failed" | "settled") => (
    <MobileDocumentHost
      projectId="project-a"
      editorWorkId="work-a"
      route={{
        requested: true,
        scheme: "manuscript",
        path: "/new-chapter.md",
        tab: null,
        // The live catalog settled without the document, as it does for any pending draft.
        catalogResolved: true,
        addressState,
        isError: false,
        isFetching: false,
      }}
    />
  );

  it("does not reject the route while the address has not admitted its document", async () => {
    coordinator.rejectRouteCandidate.mockClear();
    await withReactRoot(unadmitted("pending"), async () => {
      await act(async () => undefined);
      expect(coordinator.rejectRouteCandidate).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain("Couldn't open this document.");
    });
  });

  it("rejects an absent document once the address has settled", async () => {
    coordinator.rejectRouteCandidate.mockClear();
    await withReactRoot(unadmitted("settled"), async () => {
      await act(async () => undefined);
      expect(coordinator.rejectRouteCandidate).toHaveBeenCalledWith("project-a", 3);
    });
  });

  it("keeps the route, rejecting nothing, when the address failed to admit its document", async () => {
    // The route boundary owns the failure and its retry; navigating away would lose the address.
    coordinator.rejectRouteCandidate.mockClear();
    await withReactRoot(unadmitted("failed"), async () => {
      await act(async () => undefined);
      expect(coordinator.rejectRouteCandidate).not.toHaveBeenCalled();
    });
  });
});
