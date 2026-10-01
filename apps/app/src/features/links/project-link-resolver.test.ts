/**
 * The local projection of a link onto a scope's document index: the contract
 * every surface that follows a link shares with the server resolver.
 */

import type { DocumentLinkTarget } from "@meridian/contracts/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveDocumentLink } from "@/client/api/document-links-api";

import { createProjectLinkResolver, projectLinkAnswer } from "./project-link-resolver";
import type { LinkableDocument, LinkableDocumentIndex } from "./useLinkableDocuments";

vi.mock("@/client/api/document-links-api", () => ({ resolveDocumentLink: vi.fn() }));

function document(
  documentId: string,
  uri: string,
  options: { workId?: string | null } = {},
): LinkableDocument {
  const filename = uri.slice(uri.lastIndexOf("/") + 1);
  return {
    documentId,
    uri,
    filename,
    title: filename.replace(/\.[^.]+$/, ""),
    location: "",
    aliases: [],
    workId: options.workId ?? null,
  };
}

const kael = document("doc-kael", "manuscript://cast/Kael.md");
const gate = document("doc-gate", "manuscript://chapters/The Second Gate.md");
const notes = document("doc-notes", "scratch://@revision-pass/notes.md", { workId: "work-1" });

function index(documents: LinkableDocument[], complete = true): LinkableDocumentIndex {
  return { documents, revision: documents.map((entry) => entry.documentId).join(), complete };
}

const everything = index([kael, gate, notes]);

function resolvedId(request: DocumentLinkTarget, from = everything): string | null {
  return projectLinkAnswer(from, request)?.documentId ?? null;
}

describe("projectLinkAnswer", () => {
  it("answers with the document's resolver spelling", () => {
    expect(projectLinkAnswer(everything, { kind: "scheme", uri: "scratch://notes.md" })).toEqual({
      documentId: "doc-notes",
      title: "notes",
      scheme: "scratch",
      path: "notes.md",
      uri: "scratch://@revision-pass/notes.md",
      workId: "work-1",
    });
  });

  it("matches a scheme path with or without its extension", () => {
    expect(resolvedId({ kind: "scheme", uri: "manuscript://cast/Kael.md" })).toBe("doc-kael");
    expect(resolvedId({ kind: "scheme", uri: "manuscript://cast/Kael" })).toBe("doc-kael");
    expect(resolvedId({ kind: "scheme", uri: "kb://cast/Kael.md" })).toBeNull();
  });

  it("prefers the exact path, and refuses an omitted extension two documents fit", () => {
    const bare = document("doc-bare", "manuscript://cast/Kael");
    const mdx = document("doc-mdx", "manuscript://cast/Kael.mdx");
    expect(resolvedId({ kind: "scheme", uri: "manuscript://cast/Kael" }, index([kael, bare]))).toBe(
      "doc-bare",
    );
    expect(
      resolvedId({ kind: "scheme", uri: "manuscript://cast/Kael" }, index([kael, mdx])),
    ).toBeNull();
  });

  it("ignores a fragment or query on a scheme or relative href", () => {
    expect(resolvedId({ kind: "scheme", uri: "manuscript://cast/Kael.md#scene-2" })).toBe(
      "doc-kael",
    );
    expect(
      resolvedId({
        kind: "relative",
        path: "../cast/Kael.md?view=outline#scene-2",
        baseUri: "manuscript://chapters/The Second Gate.md",
      }),
    ).toBe("doc-kael");
  });

  it("resolves a relative path against the holder's URI", () => {
    const base = "manuscript://chapters/The Second Gate.md";
    expect(resolvedId({ kind: "relative", path: "../cast/Kael.md", baseUri: base })).toBe(
      "doc-kael",
    );
    expect(resolvedId({ kind: "relative", path: "./The Second Gate", baseUri: base })).toBe(
      "doc-gate",
    );
    expect(resolvedId({ kind: "relative", path: "The%20Second%20Gate.md", baseUri: base })).toBe(
      "doc-gate",
    );
  });

  it("lets a contextual scratch URI match the scope's Work", () => {
    expect(resolvedId({ kind: "scheme", uri: "scratch://notes.md" })).toBe("doc-notes");
    expect(resolvedId({ kind: "scheme", uri: "scratch://@revision-pass/notes.md" })).toBe(
      "doc-notes",
    );
  });

  it("leaves nothing at the address and another Work's scratch to the server", () => {
    expect(projectLinkAnswer(everything, { kind: "scheme", uri: "manuscript://Ilsever.md" })).toBe(
      null,
    );
    expect(
      projectLinkAnswer(everything, { kind: "scheme", uri: "scratch://@other-work/notes.md" }),
    ).toBeNull();
  });

  it("never answers from an incomplete index, even with one match", () => {
    expect(
      projectLinkAnswer(index([kael], false), { kind: "scheme", uri: "manuscript://cast/Kael.md" }),
    ).toBeNull();
  });

  it("treats `[[name]]`-looking text as nothing it can resolve", () => {
    expect(
      resolvedId({
        kind: "relative",
        path: "[[Kael]]",
        baseUri: "manuscript://chapters/The Second Gate.md",
      }),
    ).toBeNull();
  });
});

describe("createProjectLinkResolver", () => {
  const server = vi.mocked(resolveDocumentLink);
  const scope = { projectId: "project-1", workId: "work-1", baseUri: null };

  beforeEach(() => {
    server.mockReset();
    server.mockResolvedValue({ document: null });
  });

  it("answers locally without asking the server", async () => {
    const resolve = createProjectLinkResolver(scope, everything);

    await expect(resolve({ kind: "scheme", uri: "manuscript://cast/Kael" })).resolves.toMatchObject(
      { documentId: "doc-kael" },
    );
    expect(server).not.toHaveBeenCalled();
  });

  it("throws for a relative link with no base, so it reads as unasked rather than missing", async () => {
    const resolve = createProjectLinkResolver(scope, everything);

    await expect(resolve({ kind: "relative", path: "./Kael.md" })).rejects.toThrow();
    expect(server).not.toHaveBeenCalled();
  });

  it("asks the server with the scope's Work and the projected target", async () => {
    server.mockResolvedValue({ document: null });
    const resolve = createProjectLinkResolver(scope, everything);

    await expect(resolve({ kind: "scheme", uri: "kb://Ilsever.md" })).resolves.toBeNull();
    expect(server).toHaveBeenCalledWith("project-1", {
      workId: "work-1",
      target: { kind: "scheme", uri: "kb://Ilsever.md" },
    });
  });
});
