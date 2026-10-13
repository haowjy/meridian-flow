// @vitest-environment jsdom
/** Navigate first: an explicit review launch commits its destination without waiting on a live-identity lookup. */
import "fake-indexeddb/auto";
import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";
import { createEditorDocumentCommand } from "./editor-document-command";
import { parseProjectAddress } from "./project-address";
import { createProjectNavigation } from "./project-navigation";

const projectId = "550e8400-e29b-41d4-a716-446655440000";
const workId = "700db898-57fb-4ffa-8366-46ad6a3880be";

function setup(lookup: () => Promise<{ kind: "failed" }>) {
  const history = createMemoryHistory({ initialEntries: [`/p/${projectId}/chats`] });
  const navigation = createProjectNavigation(
    {
      read: () => ({
        href: history.location.href,
        key: history.location.state.__TSR_key ?? "",
        state: { ...history.location.state },
      }),
      subscribe: (listener) => history.subscribe(listener),
      flush: () => history.flush(),
      settlePendingTraversal: () => undefined,
      replaceEntry: (href, state) => history.replace(href, state),
      navigate: async (href, options) => {
        if (options.replace) history.replace(href, options.state);
        else history.push(href, options.state);
      },
    },
    () => ({ work: { kind: "none" } }),
  );
  const parsed = parseProjectAddress(`/p/${projectId}/chats`);
  if (parsed.kind !== "valid") throw new Error("Invalid fixture address");
  const open = createEditorDocumentCommand({
    projectId,
    accountId: "writer",
    read: () => ({
      navigation,
      address: parsed.address,
      editorWorkId: workId,
      noWorkId: null,
      documentCatalog: null,
    }),
    lookup,
    admitDraftReview: () => undefined,
  });
  return { open, history };
}

describe("review launch navigation", () => {
  it("moves to the review's screen at once, with no live-identity lookup, even when that lookup fails", async () => {
    const lookup = vi.fn(async () => ({ kind: "failed" as const }));
    const { open, history } = setup(lookup);
    const result = await open(
      { scheme: "manuscript", path: "/chapters/new.md", documentId: "doc-1", workId },
      { replaceIfSameDocument: true, itemKey: "draft-1:doc-1" },
    );
    expect(result.kind).toBe("applied");
    expect(lookup).not.toHaveBeenCalled();
    expect(history.location.href).toContain("/editor/manuscript/chapters/new.md");
    expect(history.location.href).toContain("draft-1");
  });

  it("re-selecting a draft-only tab keeps its review identity (item=), since no live document exists", async () => {
    const { open, history } = setup(vi.fn(async () => ({ kind: "failed" as const })));
    const tab = {
      kind: "tracked" as const,
      documentId: "doc-1",
      scheme: "manuscript" as const,
      path: "Scene",
      name: "Scene",
      editable: true,
      filetype: "markdown" as const,
      schemaType: "document" as const,
      draftOnly: true,
      reviewWorkId: workId,
      reviewItemKey: "draft-1:doc-1",
      tabInstanceId: "tab-1",
    } as never;
    const result = await open(
      { scheme: "manuscript", path: "Scene", documentId: "doc-1", workId },
      { tab },
    );
    expect(result.kind).toBe("applied");
    expect(history.location.href).toContain("item=draft-1");
  });
});
