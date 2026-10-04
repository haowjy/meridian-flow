/** Canonical navigation and scope isolation over the real in-memory catalog port. */
import { canonicalContextUri } from "@meridian/contracts";
import type {
  CatalogFileEntry,
  CatalogScope,
  DocumentLinkTarget,
} from "@meridian/contracts/protocol";
import { decodeWorkSlug } from "@meridian/contracts/works";
import { describe, expect, it } from "vitest";
import {
  type ProjectWorkAuthorityResolver,
  resolvedWorkAuthority,
} from "../projects/domain/work-authority.js";
import { InMemoryContextCatalog } from "./adapters/in-memory-context-catalog.js";
import { createDocumentLinkResolver } from "./document-link-resolution.js";

const project = { kind: "project", projectId: "p" } as const;
const user = { kind: "user", userId: "u" } as const;
const noneWork = { kind: "work", projectId: "p", workId: "none-id" } as const;
const a = { kind: "work", projectId: "p", workId: "a" } as const;
const b = { kind: "work", projectId: "p", workId: "b" } as const;
function fixture() {
  const catalog = new InMemoryContextCatalog();
  const authority = (id: string) => {
    const workSlug = decodeWorkSlug(`work-${id}`);
    if (!workSlug) throw new Error("invalid fixture slug");
    return resolvedWorkAuthority({ workId: id, workSlug });
  };
  const works = new Map([
    ["a", authority("a")],
    ["b", authority("b")],
    ["none-id", resolvedWorkAuthority({ workId: "none-id", workSlug: null })],
  ]);
  const workAuthorityResolver: ProjectWorkAuthorityResolver = {
    async byId(projectId, id) {
      return projectId === "p" ? (works.get(id) ?? null) : null;
    },
    async bySlug(projectId, slug) {
      return projectId === "p"
        ? ([...works.values()].find((work) => work.workSlug === slug) ?? null)
        : null;
    },
    async noWork(projectId) {
      return projectId === "p" ? (works.get("none-id") ?? null) : null;
    },
    async lockById(projectId, id) {
      return this.byId(projectId, id);
    },
  };
  const resolver = createDocumentLinkResolver({ catalog, workAuthorityResolver });
  function add(
    scope: CatalogScope,
    scheme: "manuscript" | "kb" | "user" | "scratch" | "uploads",
    path: string,
    aliases: string[] = [],
  ) {
    const entryId = crypto.randomUUID();
    const uri = canonicalContextUri(
      scheme,
      path,
      scope.kind === "work"
        ? (works.get(scope.workId) ?? authority(scope.workId))
        : { kind: "contextual" },
    );
    const file: CatalogFileEntry = {
      kind: "file",
      entryId,
      scope,
      sourceId: "source",
      parentId: "source",
      name: path.split("/").at(-1) ?? path,
      aliases,
      path: path.split("/"),
      uri,
      provisionalName: false,
      editable: true,
      filetype: "markdown",
      schemaType: "document",
    };
    catalog.commit(scope, [{ operation: "upsert", entry: file }]);
    return file;
  }
  return {
    add,
    catalog,
    resolve: (target: DocumentLinkTarget, workId: string | null = "a", userId = "u") =>
      resolver.resolve({ projectId: "p", userId, workId, target }),
  };
}

describe("catalog-backed document links", () => {
  it("resolves the exact path first, else the one path with its extension omitted", async () => {
    const f = fixture();
    const exact = f.add(project, "manuscript", "Gate");
    const withExtension = f.add(project, "manuscript", "Gate.md");
    f.add(project, "manuscript", "Map.md");
    f.add(project, "manuscript", "Map.mdx");
    expect(await f.resolve({ kind: "scheme", uri: "manuscript://Gate" })).toMatchObject({
      documentId: exact.entryId,
    });
    expect(await f.resolve({ kind: "scheme", uri: "manuscript://Gate.md" })).toMatchObject({
      documentId: withExtension.entryId,
    });
    expect(await f.resolve({ kind: "scheme", uri: "manuscript://Map" })).toBeNull();
  });
  it.each([
    [project, "manuscript", "chapters/Gate.md"],
    [project, "kb", "Gate.md"],
    [user, "user", "Gate.md"],
    [noneWork, "uploads", "Gate Map.png"],
    [noneWork, "scratch", "Gate.md"],
    [b, "scratch", "notes/Gate.md"],
    [b, "uploads", "Gate.png"],
  ] as const)("opens an explicitly addressed file in %j / %s", async (scope, scheme, path) => {
    const f = fixture();
    const file = f.add(scope, scheme, path);
    expect(await f.resolve({ kind: "scheme", uri: file.uri })).toMatchObject({
      documentId: file.entryId,
      uri: file.uri,
      scheme,
    });
  });
  it("resolves contextual and relative paths without escaping their authority", async () => {
    const f = fixture();
    const file = f.add(a, "scratch", "Gate.md");
    const noWork = f.add(noneWork, "scratch", "Gate.md");
    expect(await f.resolve({ kind: "scheme", uri: "scratch://Gate" })).toMatchObject({
      documentId: file.entryId,
    });
    expect(await f.resolve({ kind: "scheme", uri: "scratch://Gate" }, null)).toMatchObject({
      documentId: noWork.entryId,
    });
    expect(
      await f.resolve(
        { kind: "relative", baseUri: "scratch://@work-a/notes/Plan.md", path: "../Gate.md" },
        "b",
      ),
    ).toMatchObject({ documentId: file.entryId });
    expect(
      await f.resolve({ kind: "relative", baseUri: file.uri, path: "../../Gate.md" }),
    ).toBeNull();
    expect(await f.resolve({ kind: "scheme", uri: "work://a/Gate.md" })).toBeNull();
  });
  it("does not use another user's personal scope", async () => {
    const f = fixture();
    const file = f.add(user, "user", "Secret.md");
    expect(await f.resolve({ kind: "scheme", uri: file.uri }, "a", "other")).toBeNull();
  });
  it("observes current catalog files and deletion without a separate resolution cache", async () => {
    const f = fixture();
    expect(await f.resolve({ kind: "scheme", uri: "manuscript://Future" })).toBeNull();
    const file = f.add(project, "manuscript", "Future.md");
    expect(await f.resolve({ kind: "scheme", uri: "manuscript://Future" })).toMatchObject({
      documentId: file.entryId,
    });
    f.catalog.commit(project, [{ operation: "delete", entryId: file.entryId }]);
    expect(await f.resolve({ kind: "scheme", uri: file.uri })).toBeNull();
  });
});
