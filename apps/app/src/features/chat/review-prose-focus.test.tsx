// @vitest-environment jsdom
/**
 * The writer's saved rail preference must survive review, including the paths
 * that used to destroy it: a second draft opened while review is already
 * running, and a project change mid-review.
 */
import { act, useEffect, useState, useSyncExternalStore } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectContextRouteProvider } from "@/features/project/routing/ProjectContextRoute";
import type { ScreenKey } from "@/features/project/shell/screens";
import { withReactRoot } from "@/test-support/react-dom-harness";

type InlineReview = { documentId: string; draftId: string } | null;

let inlineReview: InlineReview = null;
const reviewListeners = new Set<() => void>();
const readInlineReview = () => inlineReview;
function subscribeInlineReview(listener: () => void) {
  reviewListeners.add(listener);
  return () => {
    reviewListeners.delete(listener);
  };
}
function setInlineReview(next: InlineReview) {
  inlineReview = next;
  for (const listener of reviewListeners) listener();
}

const navigate = vi.fn();
const openTab = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useParams: () => ({ projectId: "project-1" }),
  useSearch: () => ({ screen: "context", scheme: "manuscript", path: "work://manuscript/one.md" }),
}));
vi.mock("@/client/stores", () => ({
  useContextTabsActions: () => ({ openTab }),
}));
vi.mock("@/features/project/dock/editor-review-handoff", () => ({
  useOpenEditorReview:
    () =>
    (target: { workId: string; documentId: string; draftId: string; contextPath: string }) => {
      setInlineReview({ documentId: target.documentId, draftId: target.draftId });
      navigate({ scheme: "manuscript", path: target.contextPath, workId: target.workId });
      return Promise.resolve();
    },
}));
vi.mock("./DraftReviewProvider", () => ({
  useDraftReview: () => ({
    controller: {
      inlineReview: useSyncExternalStore(subscribeInlineReview, readInlineReview, readInlineReview),
      enterInlineReview: (documentId: string, draftId: string) =>
        setInlineReview({ documentId, draftId }),
    },
  }),
}));

const { DEFAULT_DOCK_PREFS, DEFAULT_SURFACE_PREFS, useProjectLayout, useProjectSurfacePrefsStore } =
  await import("@/features/project/layout");
const { useAiDraftLauncher } = await import("@/features/project/dock/useAiDraftLauncher");
const { useDraftReview } = await import("./DraftReviewProvider");
const { useReviewProseFocus } = await import("./review-prose-focus");

type DraftGroup = { documentId: string; contextPath: string };

type Shell = {
  openAiDraft: (group: DraftGroup, draftId: string) => void;
  /** What the writer sees: the rail as this render places it. */
  railCollapsed: boolean;
  /** The escape hatch — an explicit expand while review is running. */
  expandRail: () => void;
};

let shell: Shell | null = null;
let changeProject: (() => void) | null = null;

/** The slice of `DesktopProject` that decides the rail's width during review. */
function ReviewShell({ screen }: { screen: ScreenKey }) {
  const { openAiDraft } = useAiDraftLauncher();
  const proseFocus = useReviewProseFocus(screen, useDraftReview());
  const layout = useProjectLayout(screen, proseFocus.collapsedSlots);
  const setSurfaceCollapsed = useProjectSurfacePrefsStore((state) => state.setSurfaceCollapsed);
  useEffect(() => {
    shell = {
      openAiDraft: (group, draftId) => openAiDraft({ ...group, workId: "work-a", draftId }),
      railCollapsed: layout.threads.collapsed,
      expandRail: () => {
        proseFocus.release();
        setSurfaceCollapsed("threads", false);
      },
    };
  });
  return null;
}

/**
 * A project change remounts the review scope (the provider is keyed by
 * project + work) and resets the controller.
 */
function Harness() {
  const [project, setProject] = useState(0);
  useEffect(() => {
    changeProject = () => {
      setInlineReview(null);
      setProject((current) => current + 1);
    };
  });
  return (
    <ProjectContextRouteProvider openContextRoute={async (target) => navigate(target)}>
      <ReviewShell key={project} screen="context" />
    </ProjectContextRouteProvider>
  );
}

function savedRailCollapsed(): boolean {
  return useProjectSurfacePrefsStore.getState().prefs.threads.collapsed;
}

const documentOne: DraftGroup = {
  documentId: "document-one",
  contextPath: "work://manuscript/one.md",
};
const documentTwo: DraftGroup = {
  documentId: "document-two",
  contextPath: "work://manuscript/two.md",
};

describe("review prose focus", () => {
  beforeEach(() => {
    navigate.mockClear();
    setInlineReview(null);
    useProjectSurfacePrefsStore.setState({
      prefs: DEFAULT_SURFACE_PREFS,
      slotPrefs: { dock: DEFAULT_DOCK_PREFS },
    });
    shell = null;
    changeProject = null;
  });

  it("returns an expanded rail after a second draft is opened mid-review", async () => {
    await withReactRoot(<Harness />, async () => {
      expect(shell?.railCollapsed).toBe(false);

      await act(async () => shell?.openAiDraft(documentOne, "draft-one"));
      expect(shell?.railCollapsed).toBe(true);
      expect(navigate).toHaveBeenLastCalledWith({
        scheme: "manuscript",
        path: documentOne.contextPath,
        workId: "work-a",
      });

      // The defect: this second entry used to snapshot the already-collapsed
      // rail and restore THAT on exit.
      await act(async () => shell?.openAiDraft(documentTwo, "draft-two"));
      expect(shell?.railCollapsed).toBe(true);

      await act(async () => setInlineReview(null));
      expect(shell?.railCollapsed).toBe(false);
      expect(savedRailCollapsed()).toBe(false);
    });
  });

  it("keeps a collapsed rail collapsed when review ends", async () => {
    useProjectSurfacePrefsStore.getState().setSurfaceCollapsed("threads", true);

    await withReactRoot(<Harness />, async () => {
      await act(async () => shell?.openAiDraft(documentOne, "draft-one"));
      expect(shell?.railCollapsed).toBe(true);

      await act(async () => setInlineReview(null));
      expect(shell?.railCollapsed).toBe(true);
      expect(savedRailCollapsed()).toBe(true);
    });
  });

  it("never writes the rail preference, including across a project change", async () => {
    await withReactRoot(<Harness />, async () => {
      await act(async () => shell?.openAiDraft(documentOne, "draft-one"));
      expect(shell?.railCollapsed).toBe(true);
      expect(savedRailCollapsed()).toBe(false);

      await act(async () => changeProject?.());
      expect(shell?.railCollapsed).toBe(false);
      expect(savedRailCollapsed()).toBe(false);
    });
  });

  it("gives the rail back when the writer expands it during review", async () => {
    await withReactRoot(<Harness />, async () => {
      await act(async () => shell?.openAiDraft(documentOne, "draft-one"));
      expect(shell?.railCollapsed).toBe(true);

      await act(async () => shell?.expandRail());
      expect(shell?.railCollapsed).toBe(false);
      expect(inlineReview).not.toBeNull();

      // A later review yields the rail again.
      await act(async () => setInlineReview(null));
      await act(async () => shell?.openAiDraft(documentTwo, "draft-two"));
      expect(shell?.railCollapsed).toBe(true);
    });
  });
});
