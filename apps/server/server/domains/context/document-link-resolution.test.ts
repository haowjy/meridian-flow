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
const none = { kind: "none", projectId: "p" } as const;
const a = { kind: "work", projectId: "p", workId: "a" } as const;
const b = { kind: "work", projectId: "p", workId: "b" } as const;
function fixture() {
  const catalog = new InMemoryContextCatalog();
  const authority = (id: string) => {
    const workSlug = decodeWorkSlug(`work-${id}`);
    if (!workSlug) throw new Error("invalid fixture slug");
    return resolvedWorkAuthority({ kind: "work", workId: id, workSlug });
  };
  const works = new Map([
    ["a", authority("a")],
    ["b", authority("b")],
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
        ? authority(scope.workId)
        : scope.kind === "none"
          ? { kind: "none" }
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
    works,
    resolve: (target: DocumentLinkTarget, workId: string | null = "a", userId = "u") =>
      resolver.resolve({ projectId: "p", userId, workId, target }),
  };
}

describe("catalog-backed document links", () => {
  it("matches titles, filenames and aliases only in current scopes", async () => {
    const f = fixture();
    const local = f.add(a, "scratch", "notes/Gate.md", ["North entrance"]);
    f.add(b, "scratch", "Gate.md");
    f.add(b, "scratch", "Other.md");
    expect(await f.resolve({ kind: "wikilink", name: "gate" })).toMatchObject({
      documentId: local.entryId,
    });
    expect(await f.resolve({ kind: "wikilink", name: "North entrance" })).toMatchObject({
      documentId: local.entryId,
    });
    expect(await f.resolve({ kind: "wikilink", name: "Other" })).toBeNull();
    expect(await f.resolve({ kind: "wikilink", name: "Gate" }, null)).toBeNull();
    f.add(project, "manuscript", "Gate.md");
    expect(await f.resolve({ kind: "wikilink", name: "Gate" })).toBeNull();
  });
  it.each([
    [project, "manuscript", "chapters/Gate.md"],
    [project, "kb", "Gate.md"],
    [user, "user", "Gate.md"],
    [none, "uploads", "Gate Map.png"],
    [none, "scratch", "Gate.md"],
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
    const noWork = f.add(none, "scratch", "Gate.md");
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
  it("does not use another user's personal scope or a missing/deleted Work", async () => {
    const f = fixture();
    const file = f.add(user, "user", "Secret.md");
    expect(await f.resolve({ kind: "scheme", uri: file.uri }, "a", "other")).toBeNull();
    const note = f.add(b, "scratch", "Other.md");
    f.works.delete("b");
    expect(await f.resolve({ kind: "scheme", uri: note.uri })).toBeNull();
    expect(await f.resolve({ kind: "wikilink", name: "Secret" }, "foreign")).toBeNull();
  });
  it("observes current catalog files and deletion without a separate resolution cache", async () => {
    const f = fixture();
    expect(await f.resolve({ kind: "wikilink", name: "Future" })).toBeNull();
    const file = f.add(project, "manuscript", "Future.md");
    expect(await f.resolve({ kind: "wikilink", name: "Future" })).toMatchObject({
      documentId: file.entryId,
    });
    f.catalog.commit(project, [{ operation: "delete", entryId: file.entryId }]);
    expect(await f.resolve({ kind: "scheme", uri: file.uri })).toBeNull();
  });
});
