/** A rename compares and submits names the way the server stores them. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { type RenameEntryForm, useRenameEntryForm } from "./use-rename-entry-form";

const NO_WORK = "123e4567-e89b-42d3-a456-426614174000";
const mocks = vi.hoisted(() => ({
  setLocation: vi.fn(
    async (
      _project: string,
      _key: unknown,
      _destination: import("@meridian/resource-replica").ResourceDestination,
    ) => ({ operationId: "op-1" }),
  ),
  setFolderLocation: vi.fn(async () => ({ operationId: "op-2" })),
}));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => ({ works: [], noWork: { id: "123e4567-e89b-42d3-a456-426614174000" } }),
}));
vi.mock("./account-feature-context", () => ({
  useAccountResourceReplica: () => ({
    keyForDocument: async () => "key",
    parentForEntry: async () => ({ kind: "folder", folderId: "Book" }),
    setLocation: mocks.setLocation,
    setFolderLocation: mocks.setFolderLocation,
  }),
}));

type Case = {
  currentName: string;
  typed: string;
  siblings?: string[];
  siblingKind?: "file" | "dir";
  kind?: "file" | "folder";
};

async function rename({
  currentName,
  typed,
  siblings = [],
  siblingKind = "file",
  kind = "file",
}: Case) {
  const onDone = vi.fn();
  const onRenamed = vi.fn();
  let form!: RenameEntryForm;
  function Probe() {
    form = useRenameEntryForm({
      projectId: "project",
      entryId: "entry",
      owner: { workId: NO_WORK },
      scheme: "manuscript",
      currentName,
      siblings: [
        { entryId: "entry", name: currentName, kind: kind === "folder" ? "dir" : "file" },
        ...siblings.map((name, index) => ({
          entryId: `sibling-${index}`,
          name,
          kind: siblingKind,
        })),
      ],
      kind,
      onDone,
      onRenamed,
    });
    return null;
  }
  await withReactRoot(
    <QueryClientProvider client={new QueryClient()}>
      <Probe />
    </QueryClientProvider>,
    async () => {
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
    },
    { drainMacrotask: true },
  );
  return { onDone, onRenamed, issue: form.issue };
}

describe("useRenameEntryForm", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prefills the stored name", async () => {
    let draft = "";
    function Probe() {
      draft = useRenameEntryForm({
        projectId: "project",
        entryId: "entry",
        owner: { workId: NO_WORK },
        scheme: "manuscript",
        currentName: "Chapter 13",
        siblings: [],
        kind: "file",
        onDone: () => {},
      }).draft;
      return null;
    }
    await withReactRoot(
      <QueryClientProvider client={new QueryClient()}>
        <Probe />
      </QueryClientProvider>,
    );
    expect(draft).toBe("Chapter 13");
  });

  it("treats the stored name typed with a prose suffix as no change (D5)", async () => {
    const { onDone } = await rename({ currentName: "Chapter 13", typed: "Chapter 13.md" });
    expect(mocks.setLocation).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it("submits the typed name without losing suffix provenance", async () => {
    const { onRenamed } = await rename({ currentName: "Chapter 13", typed: "Chapter 14.md" });
    expect(mocks.setLocation).toHaveBeenCalledWith(
      "project",
      "key",
      expect.objectContaining({
        name: "Chapter 14.md",
        parent: { kind: "folder", folderId: "Book" },
      }),
    );
    expect(onRenamed).toHaveBeenCalledWith("op-1");
  });

  it("keeps a dotted name whole", async () => {
    await rename({ currentName: "Chapter 13", typed: "Vol. 2" });
    expect(mocks.setLocation).toHaveBeenCalledWith(
      "project",
      "key",
      expect.objectContaining({ name: "Vol. 2" }),
    );
  });

  it("keeps the extension of a bare rename (D13)", async () => {
    await rename({ currentName: "config.toml", typed: "settings" });
    expect(mocks.setLocation).toHaveBeenCalledWith(
      "project",
      "key",
      expect.objectContaining({ name: "settings" }),
    );
  });

  it("collides with a sibling by stored name, however it was typed", async () => {
    for (const typed of ["Chapter 12", "Chapter 12.md"]) {
      const { issue, onDone } = await rename({
        currentName: "Chapter 13",
        typed,
        siblings: ["Chapter 12"],
      });
      expect(issue).toMatchObject({ level: "error" });
      expect(onDone).not.toHaveBeenCalled();
    }
    expect(mocks.setLocation).not.toHaveBeenCalled();
  });

  it("refuses a name that would show as a data file with the codec's message", async () => {
    const { issue } = await rename({ currentName: "Chapter 13", typed: "data.json.md" });
    expect(issue?.message).toContain("would show as `data.json`");
    expect(mocks.setLocation).not.toHaveBeenCalled();
  });

  it("does not let a folder take a document's name (D15)", async () => {
    const { issue } = await rename({
      currentName: "Maps",
      typed: "Lore",
      siblings: ["Lore"],
      kind: "folder",
    });
    expect(issue).toMatchObject({ level: "error" });
    expect(mocks.setFolderLocation).not.toHaveBeenCalled();
  });

  it("submits a folder name as typed", async () => {
    await rename({ currentName: "Maps", typed: "v1.json", kind: "folder" });
    expect(mocks.setFolderLocation).toHaveBeenCalledWith(
      "project",
      "entry",
      expect.objectContaining({ name: "v1.json" }),
    );
  });
});

it("preserves explicitly typed prose types on a text rename", async () => {
  for (const typed of ["settings.md", "settings.txt", "Notes.md"]) {
    await rename({ currentName: "config.toml", typed });
    expect(mocks.setLocation).toHaveBeenLastCalledWith(
      "project",
      "key",
      expect.objectContaining({ name: typed }),
    );
  }
});

it("retains another folder with a codec-equivalent name during rename validation", async () => {
  const conflict = await rename({
    currentName: "Lore.md",
    typed: "Lore",
    siblings: ["Lore"],
    siblingKind: "dir",
    kind: "folder",
  });
  expect(conflict.issue?.message).toContain("A folder named Lore");
  expect(conflict.onDone).not.toHaveBeenCalled();
  const distinct = await rename({
    currentName: "Maps",
    typed: "Lore.md",
    siblings: ["Lore"],
    siblingKind: "dir",
    kind: "folder",
  });
  expect(distinct.issue).toBeNull();
  expect(distinct.onRenamed).toHaveBeenCalledWith("op-2");
});
