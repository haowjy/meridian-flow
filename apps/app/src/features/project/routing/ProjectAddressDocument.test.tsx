// @vitest-environment jsdom
/** Authorized tab publication and alias admission under delayed navigation. */
import type { DocumentAddressResult } from "@meridian/contracts/protocol";
import { act, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { CatalogFile } from "@/client/query/context-catalog-projection";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { type AddressAdmission, ProjectAddressDocument } from "./ProjectAddressDocument";
import type { ProjectAddress } from "./project-address";
import { createProjectNavigation } from "./project-navigation";

const { openTab } = vi.hoisted(() => ({
  openTab: vi.fn(),
}));
vi.mock("@/client/stores", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/stores")>()),
  useContextTabsActions: () => ({ openTab }),
}));

beforeEach(() => openTab.mockReset());

function documentResult(kind: "current" | "alias"): DocumentAddressResult {
  return {
    kind,
    document: {
      kind: "available",
      documentId: "doc-id",
      generation: "1",
      authority: { kind: "project", projectId: "project-id" },
      entry: {
        kind: "file",
        entryId: "doc-id",
        parentId: "source",
        sourceId: "source",
        scope: { kind: "project", projectId: "project-id" },
        name: "doc",
        path: ["doc"],
        uri: "kb://project/doc",
        aliases: [],
        provisionalName: false,
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      },
    },
  } as DocumentAddressResult;
}

it.each([
  "current",
  "alias",
] as const)("publishes %s metadata without revealing an unresolved alias", async (kind) => {
  openTab.mockReturnValue({ kind: "opened" });
  const onAdmission = vi.fn();
  let finishReplace!: () => void;
  const href =
    kind === "alias"
      ? "/p/550e8400-e29b-41d4-a716-446655440000/editor/kb/before"
      : "/p/550e8400-e29b-41d4-a716-446655440000/editor/kb/doc";
  const navigate = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishReplace = resolve;
      }),
  );
  const navigation = createProjectNavigation(
    {
      read: () => ({ key: "entry", href, state: {} }),
      subscribe: () => () => undefined,
      flush: () => undefined,
      settlePendingTraversal: () => undefined,
      replaceEntry: () => undefined,
      navigate,
    },
    () => ({ workId: null }),
  );
  const address: ProjectAddress = {
    projectId: "550e8400-e29b-41d4-a716-446655440000",
    destination: {
      kind: "document",
      scheme: "kb",
      path: kind === "alias" ? "before" : "doc",
    },

    work: { kind: "none" },
    results: false,
  };
  const result = documentResult(kind);
  await withReactRoot(
    <ProjectAddressDocument
      projectId="project-id"
      href={href}
      entryKey="entry"
      address={address}
      result={result}
      workId={null}
      navigation={navigation}
      onAdmission={onAdmission}
    />,
    async () => {
      expect(openTab).toHaveBeenLastCalledWith(
        "project-id",
        expect.objectContaining({
          documentId: "doc-id",
          path: "/doc",
          kind: "tracked",
        }),
        expect.any(Function),
      );
      expect(onAdmission).toHaveBeenLastCalledWith(
        expect.objectContaining({
          documentId: "doc-id",
          issue: kind === "alias" ? "loading" : undefined,
        }),
      );
      if (kind === "alias") {
        expect(navigate).toHaveBeenCalledWith(
          "/p/550e8400-e29b-41d4-a716-446655440000/editor/kb/doc",
          expect.objectContaining({ replace: true }),
        );
        await act(async () => finishReplace());
      } else expect(navigate).not.toHaveBeenCalled();
    },
  );
  navigation.dispose();
});

it("preserves a proven local resource handle during readable-route admission", async () => {
  openTab.mockReturnValue({ kind: "opened" });
  const href = "/p/550e8400-e29b-41d4-a716-446655440000/editor/kb/doc";
  const navigation = createProjectNavigation(
    {
      read: () => ({ key: "entry", href, state: {} }),
      subscribe: () => () => undefined,
      flush: () => undefined,
      settlePendingTraversal: () => undefined,
      replaceEntry: () => undefined,
      navigate: vi.fn(),
    },
    () => ({ workId: null }),
  );
  const localFile: CatalogFile = {
    kind: "file",
    entryId: "doc-id",
    parentId: "source",
    documentId: "doc-id",
    name: "old.md",
    aliases: [],
    path: "/old.md",
    uri: "kb://project/old.md",
    provisionalName: false,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
    resourceHandle: "resource-id",
    resourceState: "acknowledged",
    resourceOrigin: "local",
    localContent: true,
  };

  await withReactRoot(
    <ProjectAddressDocument
      projectId="project-id"
      href={href}
      entryKey="entry"
      address={{
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        destination: { kind: "document", scheme: "kb", path: "doc" },

        work: { kind: "none" },
        results: false,
      }}
      result={documentResult("current")}
      localFile={localFile}
      workId={null}
      navigation={navigation}
      onAdmission={vi.fn()}
    />,
    async () => {
      expect(openTab).toHaveBeenLastCalledWith(
        "project-id",
        expect.objectContaining({
          documentId: "doc-id",
          name: "doc",
          path: "/doc",
          resourceHandle: "resource-id",
          origin: "local-resource",
        }),
        expect.any(Function),
      );
    },
  );
  navigation.dispose();
});

it("admits one semantic address when parent state rebuilds equivalent lookup objects", async () => {
  openTab.mockReturnValue({ kind: "opened" });
  const href = "/p/550e8400-e29b-41d4-a716-446655440000/editor/kb/doc";
  const navigation = createProjectNavigation(
    {
      read: () => ({ key: "entry", href, state: {} }),
      subscribe: () => () => undefined,
      flush: () => undefined,
      settlePendingTraversal: () => undefined,
      replaceEntry: () => undefined,
      navigate: vi.fn(),
    },
    () => ({ workId: null }),
  );
  function Harness() {
    const [admission, setAdmission] = useState<AddressAdmission | null>(null);
    return (
      <>
        <output>{admission?.issue ?? "settled"}</output>
        <ProjectAddressDocument
          projectId="project-id"
          href={href}
          entryKey="entry"
          address={{
            projectId: "550e8400-e29b-41d4-a716-446655440000",
            destination: { kind: "document", scheme: "kb", path: "doc" },

            work: { kind: "none" },
            results: false,
          }}
          result={documentResult("current")}
          workId={null}
          navigation={navigation}
          onAdmission={setAdmission}
        />
      </>
    );
  }
  try {
    await withReactRoot(<Harness />, async () => {
      expect(document.querySelector("output")?.textContent).toBe("settled");
      expect(openTab).toHaveBeenCalledOnce();
    });
  } finally {
    navigation.dispose();
  }
});

it.each([
  "current",
  "before-failure",
  "after-failure",
] as const)("settles a rejected alias replace only while it owns the entry (superseded: %s)", async (superseded) => {
  openTab.mockReturnValue({ kind: "opened" });
  let reject!: (error: unknown) => void;
  const pending = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const href = "/p/550e8400-e29b-41d4-a716-446655440000/editor/kb/before";
  const navigation = createProjectNavigation(
    {
      read: () => ({ key: "entry", href, state: {} }),
      subscribe: () => () => undefined,
      flush: () => undefined,
      settlePendingTraversal: () => undefined,
      replaceEntry: () => undefined,
      navigate: vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined),
    },
    () => ({ workId: null }),
  );
  const address: ProjectAddress = {
    projectId: "550e8400-e29b-41d4-a716-446655440000",
    destination: { kind: "document", scheme: "kb", path: "before" },

    work: { kind: "none" },
    results: false,
  };
  const onAdmission = vi.fn();
  void pending.catch(() => {
    if (superseded === "after-failure")
      queueMicrotask(() => {
        navigation.beginIntent();
      });
  });
  try {
    await withReactRoot(
      <ProjectAddressDocument
        projectId="project-id"
        href={href}
        entryKey="entry"
        address={address}
        result={documentResult("alias")}
        workId={null}
        navigation={navigation}
        onAdmission={onAdmission}
      />,
      async () => {
        expect(onAdmission).toHaveBeenLastCalledWith(expect.objectContaining({ issue: "loading" }));
        if (superseded === "before-failure") navigation.beginIntent();
        await act(async () => reject(new Error("router rejected replacement")));
        expect(onAdmission).toHaveBeenLastCalledWith(
          expect.objectContaining({
            issue: superseded === "current" ? "error" : "loading",
          }),
        );
      },
    );
  } finally {
    navigation.dispose();
  }
});

it.each([
  { label: "No Work's, in the No Work Editor's strip", workSlug: null, tabWorkId: undefined },
  { label: "a named Work's, in that Work's strip", workSlug: "drafting", tabWorkId: "work" },
] as const)("opens a Scratch document as $label, keeping its Work in the address", async ({
  workSlug,
  tabWorkId,
}) => {
  openTab.mockReturnValue({ kind: "opened" });
  const NO_WORK = "123e4567-e89b-42d3-a456-426614174000";
  const scratchWorkId = tabWorkId ? NO_WORK.replace("123e", "223e") : NO_WORK;
  const href = `/p/550e8400-e29b-41d4-a716-446655440000/editor/scratch/side/note.md?work=${scratchWorkId}`;
  const navigate = vi.fn(async () => undefined);
  const navigation = createProjectNavigation(
    {
      read: () => ({ key: "entry", href, state: {} }),
      subscribe: () => () => undefined,
      flush: () => undefined,
      settlePendingTraversal: () => undefined,
      replaceEntry: () => undefined,
      navigate,
    },
    () => ({ workId: null }),
  );
  const scope = { kind: "work", projectId: "project-id", workId: scratchWorkId } as const;
  const result = {
    kind: "current",
    document: {
      kind: "available",
      documentId: "doc-id",
      generation: "1",
      authority: { ...scope, workSlug },
      entry: {
        kind: "file",
        entryId: "doc-id",
        parentId: "folder",
        sourceId: "source",
        scope,
        name: "note.md",
        path: ["side", "note.md"],
        uri: `scratch://@${workSlug ?? ""}/side/note.md`,
        aliases: [],
        provisionalName: false,
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      },
    },
  } as DocumentAddressResult;
  const onAdmission = vi.fn();
  await withReactRoot(
    <ProjectAddressDocument
      projectId="project-id"
      href={href}
      entryKey="entry"
      address={{
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        destination: { kind: "document", scheme: "scratch", path: "side/note.md" },
        work: { kind: "id", id: scratchWorkId } as ProjectAddress["work"],
        results: false,
      }}
      result={result}
      workId={null}
      navigation={navigation}
      onAdmission={onAdmission}
    />,
    async () => {
      const tab = openTab.mock.lastCall?.[1];
      expect(tab).toMatchObject({ documentId: "doc-id", scheme: "scratch" });
      if (tabWorkId) expect(tab).toMatchObject({ workId: scratchWorkId });
      else expect(tab).not.toHaveProperty("workId");
      expect(navigate).not.toHaveBeenCalled();
      expect(onAdmission).toHaveBeenLastCalledWith(expect.objectContaining({ issue: undefined }));
    },
  );
});
