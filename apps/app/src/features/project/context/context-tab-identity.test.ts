/**
 * context-tab-identity — work-scoped tab/route matching tests.
 */
import { describe, expect, it } from "vitest";

import type { ContextTab } from "@/client/stores";

import {
  contextTabMatchesRoute,
  contextTabRouteKey,
  findContextTabForRoute,
} from "./context-tab-identity";

function workTab(workId: string, path: string, documentId: string): ContextTab {
  return {
    documentId,
    scheme: "work",
    path,
    name: "notes.md",
    workId,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  };
}

describe("context-tab-identity", () => {
  it("matches work-scoped tabs only when workId agrees", () => {
    const tab = workTab("work-a", "/notes.md", "doc-a");
    expect(contextTabMatchesRoute(tab, "work", "/notes.md", "work-a")).toBe(true);
    expect(contextTabMatchesRoute(tab, "work", "/notes.md", "work-b")).toBe(false);
  });

  it("ignores workId for non-work-scoped schemes", () => {
    const tab: ContextTab = {
      documentId: "doc-kb",
      scheme: "kb",
      path: "/readme.md",
      name: "readme.md",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
    };
    expect(contextTabMatchesRoute(tab, "kb", "/readme.md", null)).toBe(true);
    expect(contextTabMatchesRoute(tab, "kb", "/readme.md", "work-a")).toBe(true);
  });

  it("keys work-scoped routes with workId", () => {
    expect(contextTabRouteKey("project", "work", "/notes.md", "work-a")).toBe(
      "project:work:work-a:/notes.md",
    );
    expect(contextTabRouteKey("project", "kb", "/notes.md", null)).toBe("project:kb:/notes.md");
  });

  it("findContextTabForRoute prefers the tab for the active work", () => {
    const tabs = [workTab("work-a", "/notes.md", "doc-a"), workTab("work-b", "/notes.md", "doc-b")];
    expect(findContextTabForRoute(tabs, "work", "/notes.md", "work-b")?.documentId).toBe("doc-b");
    expect(findContextTabForRoute(tabs, "work", "/notes.md", "work-a")?.documentId).toBe("doc-a");
  });
});
