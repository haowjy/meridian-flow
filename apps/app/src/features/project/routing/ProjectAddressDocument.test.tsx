// @vitest-environment jsdom
/** Authorized tab publication and alias admission under delayed navigation. */
import type { DocumentAddressResult } from "@meridian/contracts/protocol";
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { CatalogFile } from "@/client/query/context-catalog-projection";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ProjectAddressDocument } from "./ProjectAddressDocument";
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

function navigationFixture(
  href: string,
  overrides: Partial<Parameters<typeof createProjectNavigation>[0]> = {},
) {
  return createProjectNavigation(
    {
      read: () => ({ key: "entry", href, state: {} }),
      subscribe: () => () => undefined,
      flush: () => undefined,
      settlePendingTraversal: () => undefined,
      replaceEntry: () => undefined,
      navigate: vi.fn(),
      ...overrides,
    },
    () => ({ work: { kind: "none" } }),
  );
}

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

it("preserves a proven local resource handle during readable-route admission", async () => {
  openTab.mockReturnValue({ kind: "opened" });
  const href = "/p/550e8400-e29b-41d4-a716-446655440000/editor/kb/doc";
  const navigation = navigationFixture(href, {
    replaceEntry: () => undefined,
    navigate: vi.fn(),
  });
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
      workId={"00000000-0000-4000-8000-000000000009"}
      noWorkId={"00000000-0000-4000-8000-000000000009"}
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

it.each([
  "current",
  "before-replace",
] as const)("settles a rejected alias repair only while it owns the entry (superseded: %s)", async (superseded) => {
  const href = "/p/550e8400-e29b-41d4-a716-446655440000/editor/kb/before";
  let navigation!: ReturnType<typeof createProjectNavigation>;
  openTab.mockImplementation(() => {
    if (superseded === "before-replace") navigation.beginIntent();
    return { kind: "opened" };
  });
  navigation = navigationFixture(href, {
    replaceEntry: () => {
      throw new Error("router rejected replacement");
    },
    navigate: vi.fn(),
  });
  const address: ProjectAddress = {
    projectId: "550e8400-e29b-41d4-a716-446655440000",
    destination: { kind: "document", scheme: "kb", path: "before" },

    work: { kind: "none" },
    results: false,
  };
  const onAdmission = vi.fn();
  try {
    await withReactRoot(
      <ProjectAddressDocument
        projectId="project-id"
        href={href}
        entryKey="entry"
        address={address}
        result={documentResult("alias")}
        workId={"00000000-0000-4000-8000-000000000009"}
        noWorkId={"00000000-0000-4000-8000-000000000009"}
        navigation={navigation}
        onAdmission={onAdmission}
      />,
      async () => {
        expect(onAdmission).toHaveBeenLastCalledWith(
          expect.objectContaining({ issue: superseded === "current" ? "error" : "loading" }),
        );
        await act(async () => undefined);
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

it("keeps a draft-only document out of the live view and repairs only its review address", async () => {
  const noWorkId = "00000000-0000-4000-8000-000000000009";
  const projectId = "550e8400-e29b-41d4-a716-446655440000";
  const href = `/p/${projectId}/editor/manuscript/doc`;
  const replaceEntry = vi.fn();
  const navigation = navigationFixture(href, { replaceEntry });
  const result = documentResult("current");
  if (result.kind === "unavailable") throw new Error("Invalid fixture");
  result.document.entry.uri = "manuscript://doc";
  const onAdmission = vi.fn();
  await withReactRoot(
    <ProjectAddressDocument
      projectId={projectId}
      href={href}
      entryKey="entry"
      address={{
        projectId,
        destination: { kind: "document", scheme: "manuscript", path: "doc" },
        work: { kind: "none" },
        results: false,
      }}
      result={result}
      draftOnlyId="draft-1"
      workId={noWorkId}
      noWorkId={noWorkId}
      navigation={navigation}
      onAdmission={onAdmission}
    />,
    async () => {
      await act(async () => {});
      expect(openTab).not.toHaveBeenCalled();
      expect(onAdmission).not.toHaveBeenCalled();
      expect(replaceEntry).toHaveBeenCalledOnce();
      // A No Work review address names its Work itself, so a copy opens the same draft.
      expect(replaceEntry.mock.calls[0]?.[0]).toBe(`${href}?work=&draft=draft-1`);
    },
  );
  navigation.dispose();
});
