// @vitest-environment jsdom
/**
 * A link to a document that exists only in a draft installs a draft-only review
 * tab through real tab construction (never a live open or Recent entry), and a
 * new-tab gesture places it without moving the current route.
 */
import { act, useEffect } from "react";
import { expect, it, vi } from "vitest";
import { getContextTabs, useContextTabsStore } from "@/client/stores";
import type { LinkDestination, LinkDocumentRef } from "@/features/links";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ProjectDocumentNavigationProvider } from "../context/open-project-document";
import { ProjectDocumentLiveOpenerContext } from "../context/project-document-live-opener-context";
import { recentOpening } from "../context/recent-opening";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import { EditorReviewHandoffProvider } from "./editor-review-handoff";
import { useReviewingLinkDestination } from "./useAiDraftLauncher";

const hidden: LinkDocumentRef = {
  documentId: "document-h",
  review: {
    workId: "work-a",
    itemKey: "branch-1:document-h",
    contextLocation: { scheme: "manuscript", path: "/Kael.md" },
    documentName: "Kael",
  },
};

async function follow(gesture: "current" | "new-tab") {
  const prior = useContextTabsStore.getState();
  useContextTabsStore.setState({ byProject: {} });
  const liveOpen = vi.fn();
  const openLive = vi.fn();
  let destination: LinkDestination | undefined;
  const route: OpenContextRoute = vi.fn(async (_target, options) => {
    if (options?.tab) useContextTabsStore.getState().openTab("project-a", options.tab);
    return { kind: "applied" } as const;
  });
  function Probe() {
    const d = useReviewingLinkDestination(openLive);
    useEffect(() => {
      destination = d;
    }, [d]);
    return null;
  }
  try {
    await withReactRoot(
      <ProjectDocumentLiveOpenerContext.Provider value={{ open: liveOpen } as never}>
        <ProjectDocumentNavigationProvider projectId="project-a">
          <EditorReviewHandoffProvider projectId="project-a" openContextRoute={route}>
            <Probe />
          </EditorReviewHandoffProvider>
        </ProjectDocumentNavigationProvider>
      </ProjectDocumentLiveOpenerContext.Provider>,
      async () => {
        await act(async () => {
          await destination?.(hidden, gesture);
        });
      },
    );
    return { tabs: getContextTabs("project-a").tabs, route, liveOpen, openLive };
  } finally {
    useContextTabsStore.setState(prior, true);
  }
}

it("a hidden link with no existing tab becomes a draft-only review, not a live tab", async () => {
  const { tabs, route, liveOpen, openLive } = await follow("current");
  expect(tabs).toHaveLength(1);
  expect(tabs[0]).toMatchObject({
    documentId: "document-h",
    reviews: {
      "work-a": { itemKey: "branch-1:document-h", tabInstanceToken: expect.any(String) },
    },
  });
  expect(recentOpening("project-a", tabs[0], "now")).toBeNull();
  expect(route).toHaveBeenCalledOnce();
  expect(liveOpen).not.toHaveBeenCalled();
  expect(openLive).not.toHaveBeenCalled();
});

it("a new-tab gesture installs the review in the background without navigating", async () => {
  const { tabs, route, liveOpen, openLive } = await follow("new-tab");
  expect(tabs).toHaveLength(1);
  expect(tabs[0]).toMatchObject({ documentId: "document-h", reviews: expect.any(Object) });
  expect(route).not.toHaveBeenCalled();
  expect(liveOpen).not.toHaveBeenCalled();
  expect(openLive).not.toHaveBeenCalled();
});
