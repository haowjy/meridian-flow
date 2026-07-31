/** Project link resolution route-core behavior and wire validation. */

import { describe, expect, it, vi } from "vitest";
import type { DocumentLinkRouteDeps } from "./document-link-route.js";
import {
  handleDocumentLinkResolveRequest,
  parseDocumentLinkResolveBody,
} from "./document-link-route.js";

const WORK_ID = "00000000-0000-4000-8000-000000000902";

function dependencies(owner = "user-1"): DocumentLinkRouteDeps {
  return {
    projectRepo: {
      findById: vi.fn().mockResolvedValue({
        id: "project-1",
        userId: owner,
        deletedAt: null,
      }),
    },
    documentLinks: {
      resolve: vi.fn().mockResolvedValue(null),
    },
  } as unknown as DocumentLinkRouteDeps;
}

describe("document-link route", () => {
  it("parses all three target variants and canonicalizes the optional work id", () => {
    expect(
      parseDocumentLinkResolveBody({
        target: { kind: "wikilink", name: "Kael" },
      }),
    ).toEqual({ workId: undefined, target: { kind: "wikilink", name: "Kael" } });
    expect(
      parseDocumentLinkResolveBody({
        workId: WORK_ID.toUpperCase(),
        target: { kind: "scheme", uri: "work://notes/plan.md" },
      }),
    ).toEqual({
      workId: WORK_ID,
      target: { kind: "scheme", uri: "work://notes/plan.md" },
    });
    expect(
      parseDocumentLinkResolveBody({
        target: {
          kind: "relative",
          path: "../characters/kael.md",
          baseUri: "manuscript://chapters/one.md",
        },
      }),
    ).toMatchObject({ target: { kind: "relative" } });
  });

  it("rejects malformed, oversized, and unknown requests", () => {
    for (const body of [
      null,
      { target: { kind: "wikilink", name: "" } },
      { target: { kind: "wikilink", name: "x".repeat(2_049) } },
      { workId: "not-a-uuid", target: { kind: "scheme", uri: "work://notes/a.md" } },
      { target: { kind: "relative", path: "a.md" } },
      { target: { kind: "external", uri: "https://example.com" } },
    ]) {
      expect(() => parseDocumentLinkResolveBody(body)).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    }
  });

  it("owner-gates before resolving and returns misses as ordinary null results", async () => {
    const deps = dependencies();
    await expect(
      handleDocumentLinkResolveRequest(deps, {
        projectId: "project-1",
        userId: "user-1" as never,
        target: { kind: "wikilink", name: "Future chapter" },
      }),
    ).resolves.toEqual({ document: null });
    expect(deps.documentLinks.resolve).toHaveBeenCalledWith({
      projectId: "project-1",
      workId: undefined,
      target: { kind: "wikilink", name: "Future chapter" },
    });

    const denied = dependencies("another-user");
    await expect(
      handleDocumentLinkResolveRequest(denied, {
        projectId: "project-1",
        userId: "user-1" as never,
        target: { kind: "wikilink", name: "Kael" },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(denied.documentLinks.resolve).not.toHaveBeenCalled();
  });
});
