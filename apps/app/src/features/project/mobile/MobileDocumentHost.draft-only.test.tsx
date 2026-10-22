// @vitest-environment jsdom
/** The phone hosts a pending draft by its draft room alone (no live room before Apply), and every editable document through the shared host with the phone presentation. */

import { act, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ServerContextTab } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { PHONE_DOCUMENT_PRESENTATION } from "../context/document-presentation";
import { MobileDocumentHost } from "./MobileDocumentHost";

// This host witness owns route/session binding; MobileDocumentReview's suite owns chrome.
vi.mock("./MobileDocumentReview", () => ({
  MobileDocumentReview: ({ children }: { children: ReactNode }) => children,
}));

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

vi.mock("@/features/editor/PassageNotice", () => ({ PassageNotice: () => null }));
vi.mock("@/features/editor/WriterHandoffLossNotice", () => ({
  WriterHandoffLossNotice: () => null,
}));
vi.mock("../dock/DockDocumentIdentity", () => ({ useDockArchivedWork: () => null }));
vi.mock("../context/use-live-document-binding", () => ({ useLiveDocumentBinding: live.binding }));
vi.mock("../context/account-feature-context", () => ({
  useContextRemovalCoordinator: () => coordinator,
}));
vi.mock("../context/use-context-removal-project", () => ({
  useContextRemovalProject: () => selection.value,
}));
vi.mock("@/features/draft-review/DraftReviewProvider", () => ({
  useDraftReview: () => ({
    controller: {},
    fileForDocument: () => null,
    reviewRoomNameForDraft: () => null,
    setActiveEditorDocumentId: vi.fn(),
  }),
}));
const hosted = vi.hoisted(() => ({ presentation: null as unknown }));
vi.mock("../context/ContextDocumentHost", () => ({
  ContextDocumentHost: (props: {
    tab: { documentId: string };
    readOnly?: boolean;
    presentation?: unknown;
  }) => {
    hosted.presentation = props.presentation;
    return (
      <div
        data-document-host
        data-document={props.tab.documentId}
        data-read-only={String(props.readOnly === true)}
      />
    );
  },
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
  reviews: { "work-a": { itemKey: "draft-a", tabInstanceToken: "tab-a" } },
};

describe("MobileDocumentHost draft-only review", () => {
  it("hosts the draft, binds the route to the draft's document, and opens no live room", async () => {
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
        const host = document.querySelector("[data-document-host]");
        expect(host?.getAttribute("data-document")).toBe("document-draft");
        expect(host?.getAttribute("data-read-only")).toBe("false");
        expect(hosted.presentation).toBe(PHONE_DOCUMENT_PRESENTATION);
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

  it("hosts an ordinary editable document through the shared host, not a direct live binding", async () => {
    // The shared session boundary is what resumes a stranded adoption and offers Retry.
    live.binding.mockClear();
    const { reviews: _drafted, ...ordinary } = draftTab;
    await withReactRoot(
      <MobileDocumentHost
        projectId="project-a"
        editorWorkId="work-a"
        route={{
          requested: true,
          scheme: "manuscript",
          path: "/new-chapter.md",
          tab: ordinary,
          catalogResolved: true,
          addressState: "settled" as const,
          isError: false,
          isFetching: false,
        }}
      />,
      async () => {
        await act(async () => undefined);
        const host = document.querySelector("[data-document-host]");
        expect(host?.getAttribute("data-document")).toBe("document-draft");
        expect(host?.getAttribute("data-read-only")).toBe("false");
        expect(hosted.presentation).toBe(PHONE_DOCUMENT_PRESENTATION);
        expect(live.binding).not.toHaveBeenCalled();
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

  it("keeps the route, rejecting nothing, when the address failed to admit its document", async () => {
    // The route boundary owns the failure and its retry; navigating away would lose the address.
    coordinator.rejectRouteCandidate.mockClear();
    await withReactRoot(unadmitted("failed"), async () => {
      await act(async () => undefined);
      expect(coordinator.rejectRouteCandidate).not.toHaveBeenCalled();
    });
  });
});
