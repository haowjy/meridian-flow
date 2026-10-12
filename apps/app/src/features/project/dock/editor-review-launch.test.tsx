// @vitest-environment jsdom
/** Review launches retain the row's locator and reuse the real draft-overlay mount. */
import { CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import { act, useEffect } from "react";
import { expect, it } from "vitest";
import { getContextTabs, useContextTabsStore } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { isDrafted } from "../../../../../server/server/domains/file-policy/domain/policy";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import {
  type AiDraftLaunchTarget,
  EditorReviewHandoffProvider,
  useOpenEditorReview,
} from "./editor-review-handoff";

it.each(
  CONTEXT_URI_SCHEMES.filter(isDrafted),
)("launches creates and edits at the row's %s locator, retaining one overlay on repeat", async (scheme) => {
  const prior = useContextTabsStore.getState();
  useContextTabsStore.setState({ byProject: {}, _reviewOverlayByProject: {} });
  let launch: ReturnType<typeof useOpenEditorReview> | undefined;
  let destination: Parameters<OpenContextRoute>[0] | undefined;
  const navigate: OpenContextRoute = async (target, options) => {
    destination = target;
    if (options?.tab) useContextTabsStore.getState().openTab("project-a", options.tab);
    return { kind: "applied" };
  };
  function Command() {
    const command = useOpenEditorReview();
    useEffect(() => {
      launch = command;
    }, [command]);
    return null;
  }
  try {
    await withReactRoot(
      <EditorReviewHandoffProvider projectId="project-a" openContextRoute={navigate}>
        <Command />
      </EditorReviewHandoffProvider>,
      async () => {
        for (const isNewDocument of [true, false]) {
          useContextTabsStore.setState({ byProject: {}, _reviewOverlayByProject: {} });
          const target: AiDraftLaunchTarget = {
            workId: "work-a",
            documentId: "document-a",
            draftId: "branch-a",
            contextLocation: { scheme, path: "folder/chapter.md" },
            isNewDocument,
          };
          await act(async () => {
            await launch?.(target);
          });
          expect(destination).toMatchObject({
            scheme,
            path: "folder/chapter.md",
            workId: "work-a",
            documentId: "document-a",
          });
          const before = getContextTabs("project-a").tabs[0];
          expect(before).toMatchObject({ scheme, path: "folder/chapter.md" });
          await act(async () => {
            await launch?.(target);
            await launch?.(target);
          });
          const tabs = getContextTabs("project-a").tabs;
          expect(tabs).toHaveLength(1);
          expect(tabs[0].tabInstanceId).toBe(before.tabInstanceId);
          if (isNewDocument)
            expect(tabs[0]).toMatchObject({
              draftOnly: true,
              reviewWorkId: "work-a",
              reviewDraftId: "branch-a",
            });
        }
      },
    );
  } finally {
    useContextTabsStore.setState(prior, true);
  }
});
