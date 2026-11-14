/** A plain address resolves against the replay: a document, "not there", or "waiting for the list". */

import type { DocumentAddressResult } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import type { TreeViewResult } from "@/client/query/useProjectTree";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import type { TreeFile } from "@/core/project-tree/tree-view";
import { draftOnlyTarget, resolveReplayAddress } from "./local-document-address";

const file: TreeFile = {
  kind: "file",
  entryId: "document-id",
  parentId: "kb-source",
  documentId: "document-id",
  name: "Cached.md",
  extension: "",
  path: "/Cached.md",
  uri: "kb://Cached.md",
  provisionalName: false,
  hasProperties: false,
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};

function tree(isComplete: boolean, ...files: TreeFile[]): TreeViewResult {
  return {
    isComplete,
    isError: false,
    tree: {
      root: { entryId: "kb-source" },
      findPath: (path: string) => files.find((candidate) => candidate.path === path) ?? null,
      findDocument: (id: string) => files.find((candidate) => candidate.documentId === id) ?? null,
    } as never,
  };
}

const destination = { kind: "document" as const, scheme: "kb" as const, path: "Cached.md" };
const resolve = (result: TreeViewResult, boundDocumentId: string | null = null) =>
  resolveReplayAddress({
    projectId: "project-id",
    accountId: "account-id",
    destination,
    workId: null,
    rootThreadId: null,
    tree: result,
    boundDocumentId,
  });

describe("resolveReplayAddress", () => {
  it("finds the path's occupant when the route is bound to no document", () => {
    expect(resolve(tree(true, file))).toMatchObject({
      kind: "found",
      file: { documentId: "document-id" },
      result: { kind: "current", document: { authority: { kind: "project" } } },
    });
  });

  it("is not there only once the list has synced", () => {
    expect(resolve(tree(false))).toEqual({ kind: "waiting" });
    expect(resolve({ tree: null, isComplete: false, isError: false })).toEqual({ kind: "waiting" });
    expect(resolve(tree(true))).toEqual({ kind: "absent" });
  });

  it("finds a bound document by identity and never answers it with the path's occupant", () => {
    const moved = { ...file, documentId: "document-a", path: "/Moved.md" };
    expect(resolve(tree(true, file, moved), "document-a")).toMatchObject({
      kind: "found",
      file: { documentId: "document-a" },
    });
    expect(resolve(tree(true, file), "document-a")).toEqual({ kind: "held" });
  });
});

describe("draftOnlyTarget", () => {
  const resolved = {
    kind: "current",
    document: { kind: "available", documentId: "document-id" },
  } as DocumentAddressResult;
  const group = (draftOnly: boolean) =>
    ({ documentId: "document-id", draftOnly, draft: { itemKey: "draft-id" } }) as ReviewFileTarget;

  it("opens a review answer for a page a draft created as that draft, never live", () => {
    expect(draftOnlyTarget(resolved, "review", { files: [group(true)] })?.draft.itemKey).toBe(
      "draft-id",
    );
    expect(draftOnlyTarget(resolved, "review", { files: [group(false)] })).toBeUndefined();
    expect(draftOnlyTarget(resolved, "live", { files: [group(true)] })).toBeUndefined();
  });
});
