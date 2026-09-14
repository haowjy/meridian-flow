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
  resourceHandle: "resource-a",
};
const empty: EditorWorkspaceSnapshot = { version: 1, accountId: "account", projects: {} };
const opened = () =>
  reduceEditorWorkspace(empty, { kind: "open", projectId: "project", tab: local }).snapshot;

it("preserves resource identity, selection and idempotency through remint restoration", () => {
  const selected = reduceEditorWorkspace(opened(), {
    kind: "select",
    projectId: "project",
    workId: "",
    tabInstanceId: "member-a",
  }).snapshot;
  const command = {
    kind: "reconcile-resource" as const,
    projectId: "project",
    resourceHandle: "resource-a",
    tab: { ...local, documentId: "B" },
  };
  const result = reduceEditorWorkspace(selected, command);
  expect(result.snapshot.projects.project).toMatchObject({
    tabs: [{ documentId: "B", tabInstanceId: "member-a", resourceHandle: "resource-a" }],
    selectedTabIdByWork: { "": "B" },
  });
  expect(reduceEditorWorkspace(result.snapshot, command).kind).toBe("already-committed");
  expect(parseEditorWorkspace(JSON.stringify(result.snapshot))).toEqual(result.snapshot);
});

it("projects a resource rename onto an open server tab without claiming local content", () => {
  const serverTab: ContextTab = {
    kind: "tracked",
    tabInstanceId: "server-member",
    documentId: "server-document",
    scheme: "manuscript",
    path: "/Old.md",
    name: "Old.md",
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  };
  const current = reduceEditorWorkspace(empty, {
    kind: "open",
    projectId: "project",
    tab: serverTab,
  }).snapshot;
  const result = reduceEditorWorkspace(current, {
    kind: "reconcile-resource",
    projectId: "project",
    resourceHandle: "catalog:server-document",
    tab: { ...serverTab, path: "/New.md", name: "New.md" },
  });

  expect(result.snapshot.projects.project?.tabs).toEqual([
    { ...serverTab, path: "/New.md", name: "New.md" },
  ]);
});

it("clears stale local ownership when server admission has no exact content", () => {
  const materialized: ContextTab = {
    kind: "tracked",
    tabInstanceId: "member",
    documentId: "document",
    scheme: "manuscript",
    path: "/Document.md",
    name: "Document.md",
    editable: true,
    filetype: "markdown",
    schemaType: "document",
    resourceHandle: "resource",
    origin: "local-resource",
  };
  const current = reduceEditorWorkspace(empty, {
    kind: "open",
    projectId: "project",
    tab: materialized,
  }).snapshot;
  const { resourceHandle: _resourceHandle, origin: _origin, ...serverAdmission } = materialized;
  const result = reduceEditorWorkspace(current, {
    kind: "open",
    projectId: "project",
    tab: serverAdmission,
  });

  expect(result.snapshot.projects.project?.tabs[0]).not.toHaveProperty("resourceHandle");
  expect(result.snapshot.projects.project?.tabs[0]).not.toHaveProperty("origin");
});

it("does not publish adoption after close or remove a reopened member with an old close", () => {
  const close = { kind: "close" as const, projectId: "project", tabInstanceId: "member-a" };
  const closed = reduceEditorWorkspace(opened(), close).snapshot;
  expect(
    reduceEditorWorkspace(closed, {
      kind: "reconcile-resource",
      projectId: "project",
      resourceHandle: "resource-a",
      tab: {
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
