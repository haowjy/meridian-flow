/** Opening a tab states its Work; a stale Work never survives the merge. */
import { describe, expect, it } from "vitest";

import type { ContextTab } from "@/client/stores";
import { type EditorWorkspaceSnapshot, reduceEditorWorkspace } from "./editor-workspace-state";

const scratch = (workId?: string): ContextTab =>
  ({
    kind: "tracked",
    tabInstanceId: "tab-1",
    documentId: "doc-1",
    scheme: "scratch",
    path: "/side/note.md",
    name: "note.md",
    provisionalName: false,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
    ...(workId ? { workId } : {}),
  }) as ContextTab;

describe("reduceEditorWorkspace open", () => {
  it("drops a stale Work when the document reopens as No Work's", () => {
    const current: EditorWorkspaceSnapshot = {
      version: 1,
      accountId: "account",
      projects: { project: { tabs: [scratch("no-work-row")], selectedTabIdByWork: {} } },
    };
    const result = reduceEditorWorkspace(current, {
      kind: "open",
      projectId: "project",
      tab: scratch(),
    });
    const tab = result.snapshot.projects.project?.tabs[0];
    expect(tab).toMatchObject({ documentId: "doc-1", scheme: "scratch" });
    expect(tab).not.toHaveProperty("workId");
  });

  it("keeps a named Work the reopened tab states", () => {
    const current: EditorWorkspaceSnapshot = {
      version: 1,
      accountId: "account",
      projects: { project: { tabs: [scratch("work-a")], selectedTabIdByWork: {} } },
    };
    const result = reduceEditorWorkspace(current, {
      kind: "open",
      projectId: "project",
      tab: scratch("work-a"),
    });
    expect(result.snapshot.projects.project?.tabs[0]).toMatchObject({ workId: "work-a" });
  });
});
