import type { ResourceProjectionSnapshot, ResourceRecord } from "@meridian/resource-replica";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ContextTab, useContextTabsStore } from "@/client/stores";
import { validateContextDeskTabs } from "./browser-editor-tab-validation";

const mocks = vi.hoisted(() => ({ availability: vi.fn() }));
const resources = {
  readProjection: vi.fn<() => Promise<ResourceProjectionSnapshot>>(async () => ({
    records: [],
    catalogs: [],
  })),
};
vi.mock("@/client/query/project-context-availability", () => ({
  lookupProjectContextAvailability: mocks.availability,
}));

beforeEach(() => {
  mocks.availability.mockReset();
  resources.readProjection.mockReset().mockResolvedValue({ records: [], catalogs: [] });
  useContextTabsStore.setState({ byProject: {}, _deskHydrated: true });
});

function validate() {
  return validateContextDeskTabs({
    resources,
    scope: { projectId: "project", generation: 1 },
    isLiveScope: () => true,
  });
}

const restored: ContextTab = {
  tabInstanceId: "restored-member",
  kind: "tracked",
  documentId: "a",
  scheme: "manuscript",
  path: "/a.md",
  name: "a.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};

describe("server tab validation", () => {
  it("repairs existing browser-local membership by exact availability", async () => {
    useContextTabsStore.setState({
      byProject: { project: { tabs: [restored], selectedTabIdByWork: {} } },
    });
    mocks.availability.mockResolvedValue({
      projectId: "project",
      resolutionId: "lookup-1",
      resolutions: [
        {
          kind: "available",
          documentId: "a",
          generation: "1",
          authority: { kind: "project", projectId: "project" },
          entry: {
            kind: "file",
            entryId: "a",
            scope: { kind: "project", projectId: "project" },
            sourceId: "source",
            parentId: "source",
            name: "renamed.md",
            aliases: [],
            path: ["renamed.md"],
            uri: "manuscript://renamed.md",
            provisionalName: false,
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
        },
      ],
    });

    await validate();

    expect(mocks.availability).toHaveBeenCalledWith("project", ["a"]);
    expect(useContextTabsStore.getState().byProject.project?.tabs).toEqual([
      expect.objectContaining({ documentId: "a", path: "/renamed.md", name: "renamed.md" }),
    ]);
  });

  it("preserves existing membership when exact availability is unresolved", async () => {
    useContextTabsStore.setState({
      byProject: { project: { tabs: [restored], selectedTabIdByWork: {} } },
    });
    mocks.availability.mockRejectedValue(new Error("offline"));

    await validate();

    expect(useContextTabsStore.getState().byProject.project?.tabs).toEqual([
      expect.objectContaining(restored),
    ]);
  });
});

describe("device-local tab validation", () => {
  it("drops a stale New tab after positive local-resource absence", async () => {
    const local: ContextTab = {
      tabInstanceId: "member",
      kind: "new",
      documentId: "missing-local-id",
      name: "Untitled",
      resourceHandle: "missing-resource",
    };
    useContextTabsStore.setState({
      byProject: { project: { tabs: [local], selectedTabIdByWork: { "": local.documentId } } },
    });

    await validate();

    expect(resources.readProjection).toHaveBeenCalledOnce();
    expect(useContextTabsStore.getState().byProject.project).toEqual({
      tabs: [],
      selectedTabIdByWork: {},
    });
  });

  it("preserves a New tab when local projection is temporarily unreadable", async () => {
    const local: ContextTab = {
      tabInstanceId: "member",
      kind: "new",
      documentId: "local-id",
      name: "Untitled",
      resourceHandle: "resource-local",
    };
    useContextTabsStore.setState({
      byProject: { project: { tabs: [local], selectedTabIdByWork: { "": local.documentId } } },
    });
    resources.readProjection.mockRejectedValue(new Error("IndexedDB unavailable"));

    await validate();

    expect(useContextTabsStore.getState().byProject.project?.tabs).toEqual([local]);
  });

  it("does not restore an account resource that is invisible to this project", async () => {
    const source = localPlacement();
    const foreign: ResourceRecord = {
      resource: {
        ...source.resource,
        canonical: {
          scheme: "manuscript",
          path: "/Foreign.md",
          name: "Foreign.md",
          workId: null,
        },
        lifecycle: { kind: "acknowledged", availabilityGeneration: "1" },
      },
      intents: source.intents.map((intent) => ({ ...intent, projectId: "other-project" })),
    };
    const local: ContextTab = {
      tabInstanceId: "member",
      kind: "new",
      documentId: "local-id",
      name: "Untitled",
      resourceHandle: "resource-local",
    };
    useContextTabsStore.setState({
      byProject: { project: { tabs: [local], selectedTabIdByWork: { "": local.documentId } } },
    });
    resources.readProjection.mockResolvedValue({ records: [foreign], catalogs: [] });

    await validate();

    expect(useContextTabsStore.getState().byProject.project).toEqual({
      tabs: [],
      selectedTabIdByWork: {},
    });
  });

  it("restores a durable local placement without remote admission", async () => {
    const local: ContextTab = {
      tabInstanceId: "member",
      kind: "tracked",
      documentId: "local-id",
      scheme: "manuscript",
      path: "/before.md",
      name: "before.md",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
      resourceHandle: "resource-local",
      origin: "local-resource",
    };
    useContextTabsStore.setState({
      byProject: { project: { tabs: [local], selectedTabIdByWork: { "": local.documentId } } },
    });
    resources.readProjection.mockResolvedValue({
      records: [localPlacement()],
      catalogs: [],
    });

    await validate();

    expect(resources.readProjection).toHaveBeenCalledOnce();
    expect(mocks.availability).not.toHaveBeenCalled();
    expect(useContextTabsStore.getState().byProject.project).toEqual({
      tabs: [
        expect.objectContaining({
          kind: "tracked",
          documentId: "local-id",
          path: "/chapters/Opening.md",
          resourceHandle: "resource-local",
          origin: "local-resource",
        }),
      ],
      selectedTabIdByWork: { "": "local-id" },
    });
  });
});

function localPlacement(): ResourceRecord {
  return {
    resource: {
      handle: "resource-local",
      revision: 2,
      identity: { documentId: "local-id", revision: 1 },
      content: { kind: "exact", databaseName: "exact", schema: null },
      canonical: null,
      lifecycle: { kind: "local" },
      aliases: {},
      obligations: { createEligibility: { eligibleAt: 1 } },
    },
    intents: [
      {
        projectId: "project",
        handle: "resource-local",
        intentId: "create",
        sequence: 1,
        identityRevision: 1,
        desired: { kind: "create", folderPath: "" },
        attempts: [],
        state: "pending",
      },
      {
        projectId: "project",
        handle: "resource-local",
        intentId: "place",
        sequence: 2,
        identityRevision: 1,
        desired: {
          kind: "set-location",
          destination: {
            scheme: "manuscript",
            folderPath: "chapters",
            name: "Opening.md",
            workId: null,
          },
        },
        attempts: [],
        state: "pending",
      },
    ],
  };
}
