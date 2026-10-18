// @vitest-environment jsdom
/** Review launches retain the row's locator and reuse the real draft-overlay mount. */
import { act, useEffect } from "react";
import { expect, it } from "vitest";
import { getContextTabs, useContextTabsStore } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import {
  type AiDraftLaunchTarget,
  EditorReviewHandoffProvider,
  useOpenEditorReview,
} from "./editor-review-handoff";

// The locator is passed through unparsed; the default scheme and the cross-source one witness it.
it.each([
  "manuscript",
  "user",
] as const)("launches creates and edits at the row's %s locator, retaining one overlay on repeat", async (scheme) => {
  const prior = useContextTabsStore.getState();
  useContextTabsStore.setState({ byProject: {} });
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
        for (const isNew of [true, false]) {
          useContextTabsStore.setState({ byProject: {} });
          const target: AiDraftLaunchTarget = {
            workId: "work-a",
            documentId: "document-a",
            itemKey: "draft-a",
            contextLocation: { scheme, path: "folder/chapter.md" },
            isNew,
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
          if (isNew)
            expect(tabs[0]).toMatchObject({
              reviews: {
                "work-a": { itemKey: "draft-a", tabInstanceToken: expect.any(String) },
              },
            });
        }
      },
    );
  } finally {
    useContextTabsStore.setState(prior, true);
  }
});
