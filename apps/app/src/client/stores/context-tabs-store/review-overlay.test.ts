// @vitest-environment jsdom
/** Independent Work drafts of one document must not overwrite each other's overlay. */
import { expect, it } from "vitest";
import { getContextTabs, isEditorTab, useContextTabsStore } from "./context-tabs-store";

it("keeps overlay identity per document, Work and draft", () => {
  const store = useContextTabsStore.getState();
  const tab = {
    kind: "tracked" as const,
    documentId: "same",
    scheme: "kb" as const,
    path: "/Hero",
    name: "Hero",
    editable: true as const,
    filetype: "markdown" as const,
    schemaType: "document" as const,
    draftOnly: true,
  };
  const first = store.openTab("overlay-test", {
    ...tab,
    reviewWorkId: "work-a",
    reviewDraftId: "draft-a",
  });
  const second = store.openTab("overlay-test", {
    ...tab,
    reviewWorkId: "work-b",
    reviewDraftId: "draft-b",
  });
  expect(first.kind).toBe("opened");
  expect(second.kind).toBe("opened");
  if (first.kind !== "opened" || second.kind !== "opened") throw new Error("not opened");
  expect(first.tab.tabInstanceId).not.toBe(second.tab.tabInstanceId);
  const reopened = store.openTab("overlay-test", {
    ...tab,
    reviewWorkId: "work-b",
    reviewDraftId: "draft-b",
  });
  expect(reopened).toMatchObject({
    kind: "opened",
    tab: { tabInstanceId: second.tab.tabInstanceId },
  });
  expect(
    getContextTabs("overlay-test").tabs.map((row) =>
      row.kind !== "new" ? row.reviewDraftId : null,
    ),
  ).toEqual(["draft-a", "draft-b"]);
  expect(
    getContextTabs("overlay-test").tabs.filter((row) => isEditorTab(row, "work-b")),
  ).toMatchObject([{ reviewDraftId: "draft-b" }]);
  useContextTabsStore.setState({ _reviewOverlayByProject: {} });
});
