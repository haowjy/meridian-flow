/** A created file is submitted under the name the server will store. */

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContextEntry } from "@/client/api/projects-api";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { type CreateEntryForm, useCreateEntryForm } from "./use-create-entry-form";

const mocks = vi.hoisted(() => ({
  setLocation: vi.fn(async () => ({})),
  reserveDocument: vi.fn(async () => ({
    key: "key",
    content: { kind: "opened", handle: { release: vi.fn() } },
  })),
  createEntry: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ status: "created" })),
}));
vi.mock("@/client/query/useCreateContextEntry", () => ({
  useCreateContextEntry: () => ({ mutateAsync: mocks.createEntry }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("./account-feature-context", () => ({
  useAccountResourceReplica: () => ({
    findParentAtLocation: async () => ({ kind: "folder", folderId: "Book" }),
    reserveDocument: mocks.reserveDocument,
    setLocation: mocks.setLocation,
  }),
}));

async function create(typed: string, kind: "file" | "folder" = "file") {
  const onCreated = vi.fn();
  const onDone = vi.fn();
  let form!: CreateEntryForm;
  function Probe() {
    form = useCreateEntryForm({
      projectId: "project",
      scheme: "manuscript",
      kind,
      parent: "/Book",
      onDone,
      onCreated,
    });
    return null;
  }
  await withReactRoot(<Probe />, async () => {
    await act(async () => {
      form.inputProps.onChange({ target: { value: typed } } as never);
    });
    await act(async () => {
      form.inputProps.onKeyDown({
        key: "Enter",
        preventDefault() {},
        nativeEvent: { isComposing: false },
      } as never);
    });
  });
  return { onCreated, onDone, issue: form.issue };
}

describe("useCreateEntryForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["Chapter 13", "Chapter 13"],
    ["Chapter 13.md", "Chapter 13"],
    ["Chapter 13.txt", "Chapter 13"],
    ["notes.txt", "notes"],
    ["Vol. 2", "Vol. 2"],
  ])("submits %s as the prose name %s and reports its canonical path", async (typed, name) => {
    const { onCreated, onDone } = await create(typed);
    expect(mocks.setLocation).toHaveBeenCalledWith(
      "project",
      "key",
      expect.objectContaining({ name, parent: { kind: "folder", folderId: "Book" } }),
    );
    expect(onCreated).toHaveBeenCalledWith(`/Book/${name}`);
    expect(onDone).toHaveBeenCalled();
  });

  it("creates a visible-extension file under its own name", async () => {
    const { onCreated } = await create("outline.json");
    expect(mocks.setLocation).not.toHaveBeenCalled();
    expect(mocks.createEntry).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/Book/outline.json", type: "file" }),
    );
    expect(onCreated).toHaveBeenCalledWith("/Book/outline.json");
  });

  it("refuses a prose name that would show as a data file, without submitting", async () => {
    const { onCreated } = await create("data.json.md");
    expect(mocks.setLocation).not.toHaveBeenCalled();
    expect(mocks.createEntry).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("submits a folder name as typed", async () => {
    await create("v1.json", "folder");
    expect(mocks.createEntry).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/Book/v1.json", type: "folder" }),
    );
  });
});

describe("server conflicts", () => {
  beforeEach(() =>
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    }),
  );
  afterEach(() => vi.unstubAllGlobals());
  it("shows the server conflict occupant kind without reporting creation", async () => {
    mocks.createEntry.mockResolvedValueOnce({
      status: "conflict",
      uri: "manuscript://Book/Lore",
      occupantKind: "folder",
    });
    const result = await create("Lore", "folder");
    expect(result.issue?.message).toContain("A folder named Lore already exists");
    expect(result.onDone).not.toHaveBeenCalled();
    expect(result.onCreated).not.toHaveBeenCalled();
  });
});

describe("creation conflict HTTP boundary", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    {
      name: "outline.json",
      type: "file",
      occupantKind: "folder",
      copy: "A folder named outline.json already exists",
    },
    {
      name: "Taken.md",
      type: "folder",
      occupantKind: "file",
      copy: "A file named Taken.md already exists",
    },
  ] as const)("shows the $occupantKind copy for server-only conflict creating $name", async ({
    name,
    type,
    occupantKind,
    copy,
  }) => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "conflict",
              uri: `manuscript://Book/${name}`,
              occupantKind,
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    mocks.createEntry.mockImplementationOnce(async (...args) => {
      const body = args[0] as { type: "file" | "folder"; path: string };
      return createContextEntry("project", "manuscript", body);
    });
    const result = await create(name, type);
    expect(result.issue?.message).toContain(copy);
    expect(result.onCreated).not.toHaveBeenCalled();
    expect(result.onDone).not.toHaveBeenCalled();
  });
});
