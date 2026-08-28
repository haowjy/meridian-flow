import { describe, expect, it } from "vitest";
import { DeviceContextDeskStore } from "./context-desk-storage";

function memoryStorage(initial: string | null = null) {
  let raw = initial;
  const writes: string[] = [];
  return {
    storage: {
      getItem: () => raw,
      removeItem: () => {
        raw = null;
      },
      setItem: (_key: string, value: string) => {
        raw = value;
        writes.push(value);
      },
    },
    read: () => raw,
    writes,
  };
}

describe("context desk V2 persistence", () => {
  it("immediately round-trips multiple empty tabs and exact Work selection", () => {
    const memory = memoryStorage();
    const store = new DeviceContextDeskStore(memory.storage);
    store.setUser("user-1");
    store.replace({
      project: {
        tabs: [
          { kind: "new", documentId: "older", name: "Untitled", workId: "work-a" },
          { kind: "new", documentId: "newer", name: "Untitled", workId: "work-a" },
        ],
        selectedTabIdByWork: { "work-a": "older" },
      },
    });
    expect(JSON.parse(memory.writes.at(-1) ?? "null")).toMatchObject({ version: 2 });
    expect(new DeviceContextDeskStore(memory.storage).setUser("user-1")).toEqual({
      project: {
        tabs: [
          { kind: "new", documentId: "older", name: "Untitled", workId: "work-a" },
          { kind: "new", documentId: "newer", name: "Untitled", workId: "work-a" },
        ],
        selectedTabIdByWork: { "work-a": "older" },
      },
    });
  });

  it("omits draft-only tabs, their selections, and transient review ownership", () => {
    const memory = memoryStorage();
    const store = new DeviceContextDeskStore(memory.storage);
    store.setUser("user-1");
    store.replace({
      project: {
        selectedTabIdByWork: { a: "draft", b: "kept" },
        tabs: [
          { kind: "new", documentId: "draft", name: "Draft", workId: "a", draftOnly: true },
          {
            kind: "tracked",
            documentId: "kept",
            scheme: "manuscript",
            path: "/c.md",
            name: "c.md",
            editable: true,
            filetype: "markdown",
            schemaType: "document",
            reviewWorkId: "review",
          },
        ],
      },
    });
    const raw = memory.read() ?? "";
    expect(raw).not.toContain("reviewWorkId");
    expect(JSON.parse(raw).projects.project.tabs).toHaveLength(1);
    expect(JSON.parse(raw).projects.project.selectedTabIdByWork).toEqual({ b: "kept" });
  });

  it("rejects V1, activeTabId, dangling and Work-incompatible selections", () => {
    const invalidDesks = [
      { userId: "user-1", projects: {} },
      {
        version: 2,
        userId: "user-1",
        projects: { p: { tabs: [], selectedTabIdByWork: {}, activeTabId: null } },
      },
      {
        version: 2,
        userId: "user-1",
        projects: { p: { tabs: [], selectedTabIdByWork: { a: "missing" } } },
      },
      {
        version: 2,
        userId: "user-1",
        projects: {
          p: {
            tabs: [{ kind: "new", documentId: "n", name: "Untitled", workId: "a" }],
            selectedTabIdByWork: { b: "n" },
          },
        },
      },
    ];
    for (const value of invalidDesks) {
      const memory = memoryStorage(JSON.stringify(value));
      expect(new DeviceContextDeskStore(memory.storage).setUser("user-1")).toEqual({});
      expect(memory.read()).toBeNull();
    }
  });

  it("rejects and removes a tracked empty-Scratch row", () => {
    const memory = memoryStorage(
      JSON.stringify({
        version: 2,
        userId: "user-1",
        projects: {
          project: {
            tabs: [
              {
                kind: "tracked",
                documentId: "illegal-empty",
                scheme: "scratch",
                path: "",
                name: "Untitled",
                workId: "work-a",
                editable: true,
                filetype: "markdown",
                schemaType: "document",
                origin: "local-untitled",
              },
            ],
            selectedTabIdByWork: { "work-a": "illegal-empty" },
          },
        },
      }),
    );

    expect(new DeviceContextDeskStore(memory.storage).setUser("user-1")).toEqual({});
    expect(memory.read()).toBeNull();
  });
});
