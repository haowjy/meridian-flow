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
  options: { aliases?: string[]; workId?: string | null } = {},
): LinkableDocument {
  const filename = uri.slice(uri.lastIndexOf("/") + 1);
  return {
    documentId,
    uri,
    filename,
    title: filename.replace(/\.[^.]+$/, ""),
    location: "",
    aliases: options.aliases ?? [],
    workId: options.workId ?? null,
  };
}

const kael = document("doc-kael", "manuscript://cast/Kael.md", { aliases: ["The Warden"] });
const gate = document("doc-gate", "manuscript://chapters/The Second Gate.md");
const notes = document("doc-notes", "scratch://@revision-pass/notes.md", { workId: "work-1" });

function index(documents: LinkableDocument[], complete = true): LinkableDocumentIndex {
  return { documents, revision: documents.map((entry) => entry.documentId).join(), complete };
}

const everything = index([kael, gate, notes]);

function resolvedId(request: DocumentLinkTarget, from = everything): string | null {
  const answer = projectLinkAnswer(from, request);
  return answer.kind === "resolved" ? answer.document.documentId : null;
}

describe("projectLinkAnswer", () => {
  it("matches a wikilink by title, filename, or alias, ignoring case and padding", () => {
    expect(resolvedId({ kind: "wikilink", name: "Kael" })).toBe("doc-kael");
    expect(resolvedId({ kind: "wikilink", name: "Kael.md" })).toBe("doc-kael");
    expect(resolvedId({ kind: "wikilink", name: "the warden" })).toBe("doc-kael");
    expect(resolvedId({ kind: "wikilink", name: "  THE SECOND GATE " })).toBe("doc-gate");
  });

  it("answers with the document's resolver spelling", () => {
    expect(projectLinkAnswer(everything, { kind: "wikilink", name: "notes" })).toEqual({
      kind: "resolved",
      document: {
        documentId: "doc-notes",
        title: "notes",
        scheme: "scratch",
        path: "notes.md",
        uri: "scratch://@revision-pass/notes.md",
        workId: "work-1",
      },
    });
  });

  it("matches a scheme path with or without its extension", () => {
    expect(resolvedId({ kind: "scheme", uri: "manuscript://cast/Kael.md" })).toBe("doc-kael");
    expect(resolvedId({ kind: "scheme", uri: "manuscript://cast/Kael" })).toBe("doc-kael");
    expect(resolvedId({ kind: "scheme", uri: "kb://cast/Kael.md" })).toBeNull();
  });

  it("resolves a relative path against the holder's URI", () => {
    const base = "manuscript://chapters/The Second Gate.md";
    expect(resolvedId({ kind: "relative", path: "../cast/Kael.md", baseUri: base })).toBe(
      "doc-kael",
    );
    expect(resolvedId({ kind: "relative", path: "./The Second Gate", baseUri: base })).toBe(
      "doc-gate",
    );
  });

  it("lets a contextual scratch URI match the scope's Work", () => {
    expect(resolvedId({ kind: "scheme", uri: "scratch://notes.md" })).toBe("doc-notes");
    expect(resolvedId({ kind: "scheme", uri: "scratch://@revision-pass/notes.md" })).toBe(
      "doc-notes",
    );
  });

  it("leaves zero local matches and another Work's scratch to the server", () => {
    expect(projectLinkAnswer(everything, { kind: "wikilink", name: "Ilsever" })).toEqual({
      kind: "unknown",
    });
    expect(
      projectLinkAnswer(everything, { kind: "scheme", uri: "scratch://@other-work/notes.md" }),
    ).toEqual({ kind: "unknown" });
  });

  it("never answers from an incomplete index, even with one match", () => {
    expect(projectLinkAnswer(index([kael], false), { kind: "wikilink", name: "Kael" })).toEqual({
      kind: "unknown",
    });
  });

  it("calls two matches ambiguous and names both", () => {
    const kbKael = document("doc-kb-kael", "kb://Kael.md");
    const answer = projectLinkAnswer(index([kael, kbKael]), { kind: "wikilink", name: "Kael" });

    expect(answer.kind).toBe("ambiguous");
    expect(
      answer.kind === "ambiguous" && answer.candidates.map((entry) => entry.documentId),
    ).toEqual(["doc-kael", "doc-kb-kael"]);
  });

  it("leaves a single match whose URI does not parse to the server", () => {
    const ghost = { ...document("doc-ghost", "manuscript://Ghost.md"), uri: "nope://Ghost.md" };
    expect(projectLinkAnswer(index([ghost]), { kind: "wikilink", name: "Ghost" })).toEqual({
      kind: "unknown",
    });
  });
});

describe("createProjectLinkResolver", () => {
  const server = vi.mocked(resolveDocumentLink);
  const scope = { projectId: "project-1", workId: "work-1", baseUri: null };

  beforeEach(() => {
    server.mockReset();
    server.mockResolvedValue({ document: null });
  });

  it("answers a name two local documents carry as ambiguous, without asking the server", async () => {
    const kbKael = document("doc-kb-kael", "kb://Kael.md");
    const resolve = createProjectLinkResolver(scope, index([kael, kbKael]));

    await expect(resolve({ kind: "wikilink", name: "Kael" })).resolves.toBe("ambiguous");
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

    await expect(resolve({ kind: "wikilink", name: "Ilsever" })).resolves.toBeNull();
    expect(server).toHaveBeenCalledWith("project-1", {
      workId: "work-1",
      target: { kind: "wikilink", name: "Ilsever" },
    });
  });
});
