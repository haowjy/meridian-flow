/** Workspace identity and restore contracts independent of storage and other browser contexts. */
import { expect, it } from "vitest";
import type { ContextTab } from "./context-tabs-store";
import {
  type EditorWorkspaceSnapshot,
  parseEditorWorkspace,
  reduceEditorWorkspace,
} from "./editor-workspace-state";

const local: ContextTab = {
  kind: "new",
  tabInstanceId: "member-a",
  documentId: "A",
  name: "Untitled",
  lineageHandle: "lineage-a",
  identityRevision: 1,
};
const empty: EditorWorkspaceSnapshot = { version: 1, accountId: "account", projects: {} };
const opened = () =>
  reduceEditorWorkspace(empty, { kind: "open", projectId: "project", tab: local }).snapshot;

it("preserves remint identity, selection and idempotency through restoration", () => {
  const selected = reduceEditorWorkspace(opened(), {
    kind: "select",
    projectId: "project",
    workId: "",
    tabInstanceId: "member-a",
  }).snapshot;
  const command = {
    kind: "publish-remint" as const,
    lineageHandle: "lineage-a",
    minimumIdentityRevision: 2,
    documentId: "B",
  };
  const result = reduceEditorWorkspace(selected, command);
  expect(result.snapshot.projects.project).toMatchObject({
    tabs: [{ documentId: "B", tabInstanceId: "member-a", identityRevision: 2 }],
    selectedTabIdByWork: { "": "B" },
  });
  expect(reduceEditorWorkspace(result.snapshot, command).kind).toBe("already-committed");
  expect(parseEditorWorkspace(JSON.stringify(result.snapshot))).toEqual(result.snapshot);
});

it("does not publish adoption after close or remove a reopened member with an old close", () => {
  const close = { kind: "close" as const, projectId: "project", tabInstanceId: "member-a" };
  const closed = reduceEditorWorkspace(opened(), close).snapshot;
  expect(
    reduceEditorWorkspace(closed, {
      kind: "publish-adoption",
      lineageHandle: "lineage-a",
      adoptionRevision: 2,
      trackedTab: {
        kind: "tracked",
        documentId: "A",
        scheme: "unfiled",
        path: "/Untitled.md",
        name: "Untitled.md",
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      },
    }).kind,
  ).toBe("not-referenced");
  const reopened = reduceEditorWorkspace(closed, {
    kind: "open",
    projectId: "project",
    tab: { ...local, tabInstanceId: "member-b" },
  }).snapshot;
  expect(reduceEditorWorkspace(reopened, close).snapshot.projects.project?.tabs).toEqual([
    { ...local, tabInstanceId: "member-b" },
  ]);
});

it.each([
  "scratch",
  "uploads",
] as const)("excludes %s views without deleting local documents", (scheme) => {
  const restored = parseEditorWorkspace(
    JSON.stringify({
      ...empty,
      projects: {
        project: {
          tabs: [
            local,
            {
              kind: "viewer",
              tabInstanceId: "resource-view",
              documentId: "resource",
              scheme,
              path: "/Map.png",
              name: "Map.png",
              editable: false,
              fileType: "image",
            },
          ],
          selectedTabIdByWork: { "": "resource" },
        },
      },
    }),
  );
  expect(restored?.projects.project).toEqual({ tabs: [local], selectedTabIdByWork: {} });
});

it("rejects an incompatible layout protocol", () => {
  expect(parseEditorWorkspace(JSON.stringify({ ...empty, version: 3 }))).toBeNull();
});
