// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { createEditorDocumentCommand } from "./editor-document-command";
import { parseProjectAddress } from "./project-address";
import { createProjectNavigation } from "./project-navigation";

const projectId = "550e8400-e29b-41d4-a716-446655440000";
const workId = "700db898-57fb-4ffa-8366-46ad6a3880be";

function setup(
  path = `/p/${projectId}/chats`,
  addressDocumentId?: string,
  presented: readonly never[] = [],
) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const navigation = createProjectNavigation({
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
  });
  const cut = path.indexOf("?");
  const parsed =
    cut < 0 ? parseProjectAddress(path) : parseProjectAddress(path.slice(0, cut), path.slice(cut));
  if (parsed.kind !== "valid") throw new Error("Invalid fixture address");
  const open = createEditorDocumentCommand({
    read: () => ({
      navigation,
      address: parsed.address,
      editorWorkId: workId,
      documentTree: null,
      addressDocumentId,
    }),
    presented: () => presented,
  });
  return { open, history };
}

describe("review launch navigation", () => {
  it("moves to the review's screen at once, from the path the launch carries", async () => {
    const { open, history } = setup();
    const result = await open(
      { scheme: "manuscript", path: "/chapters/new.md", documentId: "doc-1" },
      { replaceIfSameDocument: true, itemKey: "draft-1:doc-1" },
    );
    expect(result.kind).toBe("applied");
    expect(history.location.href).toContain("/editor/manuscript/chapters/new.md");
    expect(history.location.href).toContain("draft-1");
  });

  it("a live answer opened with its prepared tab never carries a parked hidden sibling's item key", async () => {
    const hidden = {
      kind: "tracked" as const,
      documentId: "doc-hidden",
      scheme: "manuscript" as const,
      path: "/Scene.md",
      name: "Scene.md",
      editable: true,
      filetype: "markdown" as const,
      schemaType: "document" as const,
    } as never;
    const { open, history } = setup(
      `/p/${projectId}/editor/manuscript/Scene.md?owner=work:${workId}&item=draft-hidden:doc-hidden`,
      "doc-hidden",
      [hidden],
    );
    const live = { ...(hidden as object), documentId: "doc-live" } as never;
    await open(
      { scheme: "manuscript", path: "/Scene.md", documentId: "doc-live" },
      { document: live },
    );
    expect(history.location.href).not.toContain("item=");
  });
});
