// @vitest-environment jsdom
/** The document an address names, and alias admission under delayed navigation.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - alias-repair error ownership
 */
import type { DocumentAddressResult } from "@meridian/contracts/protocol";
import { act } from "react";
import { expect, it, vi } from "vitest";
import type { CatalogFile } from "@/client/query/context-catalog-projection";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { addressedDocument, ProjectAddressDocument } from "./ProjectAddressDocument";
import type { ProjectAddress } from "./project-address";
import { createProjectNavigation } from "./project-navigation";

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
    () => ({}),
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
        observationVersion: "1",
        entryId: "doc-id",
        parentId: "source",
        sourceId: "source",
        scope: { kind: "project", projectId: "project-id" },
        name: "doc",
        path: ["doc"],
        uri: "kb://project/doc",
        aliases: [],
        hasProperties: false,
        provisionalName: false,
        extension: "md",
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      },
    },
  } as DocumentAddressResult;
}

it("keeps a proven local resource handle on the document an address names", () => {
  const localFile: CatalogFile = {
    kind: "file",
    entryId: "doc-id",
    parentId: "source",
    documentId: "doc-id",
    extension: "",
    name: "old.md",
    aliases: [],
    path: "/old.md",
    uri: "kb://project/old.md",
    provisionalName: false,
    hasProperties: false,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
    resourceHandle: "resource-id",
    resourceState: "acknowledged",
    resourceOrigin: "local",
    localContent: true,
  };
  const addressed = addressedDocument(
    {
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      destination: { kind: "document", scheme: "kb", path: "doc" },
    },
    documentResult("current"),
    localFile,
    undefined,
  );
  expect(addressed?.tab).toMatchObject({
    documentId: "doc-id",
    name: "doc",
    path: "/doc",
    resourceHandle: "resource-id",
    origin: "local-resource",
  });
});

it("settles a rejected alias repair as an error while it owns the entry", async () => {
  const href = "/p/550e8400-e29b-41d4-a716-446655440000/editor/kb/before";
  const navigation = navigationFixture(href, {
    replaceEntry: () => {
      throw new Error("router rejected replacement");
    },
    navigate: vi.fn(),
  });
  const address: ProjectAddress = {
    projectId: "550e8400-e29b-41d4-a716-446655440000",
    destination: { kind: "document", scheme: "kb", path: "before" },
  };
  const onAdmission = vi.fn();
  try {
    await withReactRoot(
      <ProjectAddressDocument
        href={href}
        entryKey="entry"
        address={address}
        result={documentResult("alias")}
        workId={"00000000-0000-4000-8000-000000000009"}
        navigation={navigation}
        onAdmission={onAdmission}
      />,
      async () => {
        expect(onAdmission).toHaveBeenLastCalledWith(expect.objectContaining({ issue: "error" }));
        await act(async () => undefined);
        expect(onAdmission).toHaveBeenLastCalledWith(expect.objectContaining({ issue: "error" }));
      },
    );
  } finally {
    navigation.dispose();
  }
});

it("keeps a review address out of the live view and repairs only its review address", async () => {
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
      href={href}
      entryKey="entry"
      address={{
        projectId,
        destination: { kind: "document", scheme: "manuscript", path: "doc" },
      }}
      result={result}
      reviewItemKey="draft-1"
      workId={noWorkId}
      navigation={navigation}
      onAdmission={onAdmission}
    />,
    async () => {
      await act(async () => {});
      // A review address never admits the live document.
      expect(onAdmission).not.toHaveBeenCalled();
      expect(replaceEntry).toHaveBeenCalledOnce();
      // A review address names its draft's owner itself, so a copy opens the same draft.
      expect(replaceEntry.mock.calls[0]?.[0]).toBe(`${href}?owner=work%3A${noWorkId}&item=draft-1`);
    },
  );
  navigation.dispose();
});
