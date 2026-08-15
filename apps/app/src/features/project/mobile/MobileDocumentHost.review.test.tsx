// @vitest-environment jsdom
/** Phone document hosting publishes and renders the Editor review scope. */

import type { ProjectContextTreeDirectory } from "@meridian/contracts/protocol";
import { act, useCallback, useMemo, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
} from "@/features/chat/DraftReviewProvider";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  EditorReviewHandoffProvider,
  EditorReviewIntentClaimant,
  useOpenEditorReview,
} from "../dock/editor-review-handoff";
import type { AiDraftLaunchTarget } from "../dock/useAiDraftLauncher";
import type { OpenContextRoute } from "../routing/ProjectContextRoute";
import { MobileDocumentHost } from "./MobileDocumentHost";

const mocks = vi.hoisted(() => ({
  editorProps: [] as Array<Record<string, unknown>>,
  enterInlineReview: vi.fn(),
  openTab: vi.fn(),
  registry: {
    retain: vi.fn(),
    release: vi.fn(),
    get: vi.fn(() => ({ suspendPresence: vi.fn(), resumePresence: vi.fn() })),
  },
}));

vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: unknown }) => children,
}));
vi.mock("@/client/stores", () => ({
  useContextTabsActions: () => ({ openTab: mocks.openTab }),
}));
vi.mock("@/core/editor/document-session-registry", () => ({
  getDocumentSessionRegistry: () => mocks.registry,
}));
vi.mock("@/features/editor/EditorView", () => ({
  EditorView: (props: Record<string, unknown>) => {
    mocks.editorProps.push(props);
    return <div data-testid="phone-editor" />;
  },
}));
vi.mock("@/features/editor/PassageNotice", () => ({ PassageNotice: () => null }));

const target: AiDraftLaunchTarget = {
  workId: "work-b",
  documentId: "document-shared",
  draftId: "draft-b",
  contextPath: "chapters/shared.md",
};

const tree = {
  kind: "dir",
  path: "/",
  name: "Manuscript",
  children: [
    {
      kind: "file",
      path: target.contextPath,
      name: "shared.md",
      documentId: target.documentId,
      editable: true,
      filetype: "markdown",
      schemaType: "document",
    },
  ],
} as unknown as ProjectContextTreeDirectory;

vi.mock("@/client/query/useProjectContextTree", () => ({
  useProjectContextTree: () => ({
    tree,
    capabilities: null,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

let openReview: ((target: AiDraftLaunchTarget) => Promise<void>) | null = null;

function CommandCapture() {
  openReview = useOpenEditorReview();
  return null;
}

function PhoneRouteHarness({ navigate }: { navigate: OpenContextRoute }) {
  const [route, setRoute] = useState<AiDraftLaunchTarget | null>(null);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [inlineReview, setInlineReview] = useState<{
    documentId: string;
    draftId: string;
  } | null>(null);
  const enterInlineReview = useCallback((documentId: string, draftId: string) => {
    mocks.enterInlineReview(documentId, draftId);
    setInlineReview({ documentId, draftId });
  }, []);
  const editorReview = useMemo(
    () =>
      ({
        controller: {
          workId: target.workId,
          inlineReview,
          enterInlineReview,
          exitInlineReview: () => setInlineReview(null),
        },
        groups: [{ documentId: target.documentId, drafts: [{ draftId: target.draftId }] }],
        drafts: { status: "ready", groups: [] },
        groupForDocument: (documentId: string | null | undefined) =>
          documentId === target.documentId
            ? { documentId: target.documentId, drafts: [{ draftId: target.draftId }] }
            : null,
        reviewRoomNameForDraft: (documentId: string, draftId: string) =>
          inlineReview?.documentId === documentId && inlineReview.draftId === draftId
            ? "review-room-b"
            : null,
        activeEditorDocumentId: activeDocumentId,
        setActiveEditorDocumentId: setActiveDocumentId,
      }) as unknown as DraftReviewContextValue,
    [activeDocumentId, enterInlineReview, inlineReview],
  );
  const openContextRoute = useCallback<OpenContextRoute>(
    async (next) => {
      await navigate(next);
      if (!next.workId) throw new Error("Review route requires Work identity");
      setRoute({ ...target, workId: next.workId, contextPath: next.path });
    },
    [navigate],
  );

  return (
    <EditorReviewHandoffProvider projectId="project-1" openContextRoute={openContextRoute}>
      <CommandCapture />
      {route ? (
        <DraftReviewBoundary value={editorReview}>
          <EditorReviewIntentClaimant
            editorWorkId={route.workId}
            activeScheme="manuscript"
            activePath={route.contextPath}
          />
          <MobileDocumentHost
            projectId="project-1"
            editorWorkId={route.workId}
            activeContextScheme="manuscript"
            activeContextPath={route.contextPath}
          />
        </DraftReviewBoundary>
      ) : null}
    </EditorReviewHandoffProvider>
  );
}

describe("MobileDocumentHost review binding", () => {
  beforeEach(() => {
    openReview = null;
    mocks.editorProps.length = 0;
    mocks.enterInlineReview.mockClear();
    mocks.openTab.mockClear();
    mocks.registry.retain.mockClear();
    mocks.registry.release.mockClear();
  });

  it("claims a committed Chat-to-Editor handoff and renders its review room", async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    await withReactRoot(<PhoneRouteHarness navigate={navigate} />, async () => {
      await act(async () => {
        await openReview?.(target);
      });

      expect(mocks.enterInlineReview).toHaveBeenCalledOnce();
      expect(mocks.enterInlineReview).toHaveBeenCalledWith(target.documentId, target.draftId);
      expect(mocks.editorProps.at(-1)).toMatchObject({
        documentId: target.documentId,
        workId: target.workId,
        reviewDraftId: target.draftId,
        reviewRoomName: "review-room-b",
        reviewWorkId: target.workId,
        editable: false,
      });
    });
  });
});
