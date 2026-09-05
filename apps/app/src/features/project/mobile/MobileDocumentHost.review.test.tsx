// @vitest-environment jsdom
/** Phone document hosting publishes and renders the Editor review scope. */

import { act, StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
} from "@/features/chat/DraftReviewProvider";
import {
  AccountFeatureTestProvider,
  useContextRemovalCoordinator,
} from "@/test-support/account-feature-provider";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ProjectContextRemovalController } from "../context/ProjectContextRemovalController";
import { useContextRemovalProject } from "../context/use-context-removal-project";
import type { AiDraftLaunchTarget } from "../dock/editor-review-handoff";
import {
  EditorReviewHandoffProvider,
  EditorReviewIntentClaimant,
  useOpenEditorReview,
} from "../dock/editor-review-handoff";
import type { OpenContextRoute } from "../routing/ProjectContextRoute";
import { MobileDocumentHost } from "./MobileDocumentHost";
import { resolveMobileDocumentRoute } from "./mobile-document-route";

const mocks = vi.hoisted(() => ({
  editorProps: [] as Array<Record<string, unknown>>,
  enterInlineReview: vi.fn(),
  liveSession: { suspendPresence: vi.fn(), resumePresence: vi.fn() },
  liveOpener: { open: vi.fn() },
  openTab: vi.fn(),
  registry: {
    retain: vi.fn(),
    release: vi.fn(),
    get: vi.fn(() => ({ suspendPresence: vi.fn(), resumePresence: vi.fn() })),
    observeRetainedLiveDocuments: (observer: (snapshot: readonly unknown[]) => void) => {
      observer([]);
      return () => undefined;
    },
    revokeDocument: vi.fn(),
    revokeAccess: vi.fn(),
  },
  desk: {
    byProject: {
      "project-1": {
        tabs: [],
        selectedTabIdByWork: {},
      },
    },
    _deskHydrated: true,
  },
}));

vi.mock("../context/account-feature-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../context/account-feature-context")>();
  return {
    ...actual,
    useProjectDocumentLiveOpener: () => mocks.liveOpener,
  };
});
vi.mock("../context/project-document-live-opener-context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../context/project-document-live-opener-context")>();
  return {
    ...actual,
    useProjectDocumentLiveOpener: () => mocks.liveOpener,
  };
});

vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: unknown }) => children,
}));
vi.mock("@/client/stores", () => ({
  commitContextAvailability: vi.fn(),
  commitDraftApplyMetadata: vi.fn(),
  commitPlannedContextRemoval: vi.fn(),
  commitReviewOverlayClose: vi.fn(),
  getContextTabs: () => mocks.desk.byProject["project-1"] ?? { tabs: [], selectedTabIdByWork: {} },
  useContextTabsActions: () => ({ openTab: mocks.openTab }),
  useContextTabsStore: Object.assign(() => null, { getState: () => mocks.desk }),
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

const file = {
  kind: "file" as const,
  entryId: target.documentId,
  parentId: "source",
  path: target.contextPath,
  name: "shared.md",
  documentId: target.documentId,
  editable: true as const,
  filetype: "markdown" as const,
  schemaType: "document" as const,
};
const catalog = { findPath: vi.fn((_path: string) => file) };

function mobileRoute(path: string | null) {
  return resolveMobileDocumentRoute({
    enabled: path !== null,
    scheme: path ? "manuscript" : null,
    path,
    workId: target.workId,
    catalog: catalog as unknown as CatalogContextView,
    isError: false,
    isFetching: false,
  });
}

vi.mock("@/client/query/useContextCatalog", () => ({
  useContextCatalogView: () => ({
    catalog,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

let openReview: ((target: AiDraftLaunchTarget) => Promise<void>) | null = null;
let settledDocumentId: string | null = null;
let removalCoordinator: ReturnType<typeof useContextRemovalCoordinator> | null = null;
let setDirectPath: ((path: string | null) => void) | null = null;

function CoordinatorCapture() {
  removalCoordinator = useContextRemovalCoordinator();
  return null;
}

function CommandCapture() {
  openReview = useOpenEditorReview();
  return null;
}

function RemovalObserver() {
  const selection = useContextRemovalProject("project-1").selection;
  useEffect(() => {
    settledDocumentId = selection.status === "bound" ? selection.identity.documentId : null;
  }, [selection]);
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
          <ProjectContextRemovalController
            projectId="project-1"
            activeScreen="context"
            activeContextScheme="manuscript"
            activeContextPath={route.contextPath}
            editorWorkId={route.workId}
            route={{ readSearch: () => ({ screen: "context" }), updateSearch: () => undefined }}
          />
          <EditorReviewIntentClaimant
            editorWorkId={route.workId}
            activeScheme="manuscript"
            activePath={route.contextPath}
          />
          <MobileDocumentHost
            projectId="project-1"
            editorWorkId={route.workId}
            route={mobileRoute(route.contextPath)}
          />
          <RemovalObserver />
        </DraftReviewBoundary>
      ) : null}
    </EditorReviewHandoffProvider>
  );
}

function DirectMobileHarness() {
  const [path, setPath] = useState<string | null>(target.contextPath);
  setDirectPath = setPath;
  const review = useMemo(
    () =>
      ({
        controller: {
          workId: target.workId,
          inlineReview: null,
          enterInlineReview: vi.fn(),
          exitInlineReview: vi.fn(),
        },
        groups: [],
        drafts: { status: "ready", groups: [] },
        groupForDocument: () => null,
        reviewRoomNameForDraft: () => null,
        activeEditorDocumentId: null,
        setActiveEditorDocumentId: vi.fn(),
      }) as unknown as DraftReviewContextValue,
    [],
  );
  return (
    <DraftReviewBoundary value={review}>
      <MobileDocumentHost
        projectId="project-1"
        editorWorkId={target.workId}
        route={mobileRoute(path)}
      />
    </DraftReviewBoundary>
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
    mocks.liveOpener.open.mockReset();
    mocks.liveOpener.open.mockResolvedValue({
      kind: "opened",
      document: file,
      admission: {
        projectId: "project-1",
        documentId: target.documentId,
        generation: "1",
        bind: async () => ({
          projectId: "project-1",
          documentId: target.documentId,
          generation: "1",
          session: mocks.liveSession,
          release: vi.fn(),
        }),
      },
    });
    catalog.findPath.mockReset();
    catalog.findPath.mockReturnValue(file);
    setDirectPath = null;
    settledDocumentId = null;
  });

  it("claims a committed Chat-to-Editor handoff and renders its review room", async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    await withReactRoot(
      <StrictMode>
        <AccountFeatureTestProvider accountId="account-1">
          <CoordinatorCapture />
          <PhoneRouteHarness navigate={navigate} />
        </AccountFeatureTestProvider>
      </StrictMode>,
      async () => {
        await act(async () => {
          await openReview?.(target);
        });

        expect(mocks.enterInlineReview).toHaveBeenCalledOnce();
        expect(removalCoordinator?.getProjectSnapshot("project-1").selection).toMatchObject({
          status: "bound",
          identity: { documentId: target.documentId },
        });
        expect(settledDocumentId).toBe(target.documentId);
        expect(mocks.enterInlineReview).toHaveBeenCalledWith(target.documentId, target.draftId);
        expect(mocks.editorProps.at(-1)).toMatchObject({
          documentId: target.documentId,
          workId: target.workId,
          reviewDraftId: target.draftId,
          reviewRoomName: "review-room-b",
          reviewWorkId: target.workId,
          editable: false,
        });
      },
    );
  });

  it("releases on route replacement and exit", async () => {
    const releases = new Map<string, ReturnType<typeof vi.fn>>();
    const second = { ...file, documentId: "document-second", entryId: "document-second" };
    catalog.findPath.mockImplementation((path) => (path === "chapters/second.md" ? second : file));
    mocks.liveOpener.open.mockImplementation(async (input: { documentId: string }) => {
      const release = vi.fn();
      releases.set(input.documentId, release);
      return {
        kind: "opened",
        document: file,
        admission: {
          projectId: "project-1",
          documentId: input.documentId,
          generation: "1",
          bind: async () => ({
            projectId: "project-1",
            documentId: input.documentId,
            generation: "1",
            session: mocks.liveSession,
            release,
          }),
        },
      };
    });

    await withReactRoot(
      <AccountFeatureTestProvider accountId="account-1">
        <DirectMobileHarness />
      </AccountFeatureTestProvider>,
      async () => {
        await act(async () => undefined);
        await act(async () => setDirectPath?.("chapters/second.md"));
        expect(releases.get(target.documentId)).toHaveBeenCalledOnce();
        await act(async () => setDirectPath?.(null));
        expect(releases.get("document-second")).toHaveBeenCalledOnce();
      },
    );
  });

  it.each([
    "not-editable",
    "unavailable",
  ] as const)("does not render an editor for %s", async (kind) => {
    mocks.liveOpener.open.mockResolvedValue(
      kind === "not-editable" ? { kind, document: file } : { kind, reason: "not-visible" },
    );
    await withReactRoot(
      <AccountFeatureTestProvider accountId="account-1">
        <DirectMobileHarness />
      </AccountFeatureTestProvider>,
      async () => {
        await act(async () => undefined);
        expect(mocks.editorProps).toHaveLength(0);
        expect(document.body.textContent).toContain("Couldn't open this document.");
      },
    );
  });
});
