// @vitest-environment jsdom
/** The properties block is fetched only when the catalog says so, and is read-only. */
import type { DocumentProperties as Dto } from "@meridian/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ContextTab } from "@/client/stores";
import { useProjectSurfacePrefsStore } from "@/features/project/layout/surface-prefs-store";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { DocumentProperties } from "./DocumentProperties";

const fetchProperties = vi.fn<(projectId: string, documentId: string) => Promise<Dto>>();
let hasProperties = true;

vi.mock("@/client/api/document-properties-api", () => ({
  fetchDocumentProperties: (projectId: string, documentId: string) =>
    fetchProperties(projectId, documentId),
}));
vi.mock("@/client/query/useContextCatalog", () => ({
  useContextCatalogView: () => ({
    catalog: { findDocument: () => ({ hasProperties }) },
  }),
}));

const tab = {
  kind: "tracked",
  documentId: "doc-1",
  scheme: "manuscript",
  path: "/Chapter 1.md",
  name: "Chapter 1",
} as ContextTab;

const chapter: Dto = {
  entries: [
    { key: "aliases", value: ["Gate Opening", "First Chapter"] },
    { key: "tags", value: ["chapter"] },
    { key: "status", value: "revised" },
    { key: "draft", value: true },
    { key: "notes", value: null },
    { key: "sources", value: [{ book: "Ashfall", page: 12 }] },
  ],
  aliases: ["Gate Opening", "First Chapter"],
  unreadable: false,
  text: "aliases: [Gate Opening, First Chapter]\n",
};

/** Lets the query resolve and React render what it returned. */
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

async function show(run: (root: HTMLElement) => Promise<void>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await withReactRoot(
    <QueryClientProvider client={client}>
      <DocumentProperties projectId="project" tab={tab} />
    </QueryClientProvider>,
    async () => {
      await settle();
      await run(document.body);
    },
  );
}

const toggle = () => document.querySelector<HTMLButtonElement>("button[aria-expanded]");

beforeEach(() => {
  fetchProperties.mockReset();
  hasProperties = true;
  useProjectSurfacePrefsStore.setState({ documentPrefs: { propertiesOpen: false } });
});

it("makes no request and shows nothing for a document without properties", async () => {
  hasProperties = false;
  await show(async (root) => {
    expect(root.textContent).toBe("");
    expect(fetchProperties).not.toHaveBeenCalled();
  });
});

it("lists the keys in source order on the closed line", async () => {
  fetchProperties.mockResolvedValue(chapter);
  await show(async () => {
    expect(fetchProperties).toHaveBeenCalledWith("project", "doc-1");
    expect(toggle()?.textContent).toBe("Propertiesaliases, tags, status, draft, notes, sources");
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
  });
});

it("opens to chips, Yes, Empty and block YAML, with nothing to edit", async () => {
  fetchProperties.mockResolvedValue(chapter);
  useProjectSurfacePrefsStore.setState({ documentPrefs: { propertiesOpen: true } });
  await show(async (root) => {
    const region = root.querySelector("section[aria-label='Properties']");
    expect(region?.hasAttribute("hidden")).toBe(false);
    expect([...root.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual([
      "aliases",
      "tags",
      "status",
      "draft",
      "notes",
      "sources",
    ]);
    const values = [...root.querySelectorAll("dd")];
    expect([...(values[0]?.querySelectorAll("li") ?? [])].map((li) => li.textContent)).toEqual([
      "Gate Opening",
      "First Chapter",
    ]);
    expect(values[3]?.textContent).toBe("Yes");
    expect(values[4]?.textContent).toBe("Empty");
    expect(values[5]?.querySelector("pre")?.textContent).toBe("- book: Ashfall\n  page: 12");
    expect(region?.querySelector("input, textarea, button, [contenteditable]")).toBeNull();
  });
});

it("remembers one open or closed choice, and Left and Right set it", async () => {
  fetchProperties.mockResolvedValue(chapter);
  await show(async () => {
    await act(async () => toggle()?.click());
    expect(useProjectSurfacePrefsStore.getState().documentPrefs.propertiesOpen).toBe(true);
    await act(async () => {
      toggle()?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(useProjectSurfacePrefsStore.getState().documentPrefs.propertiesOpen).toBe(false);
    await act(async () => {
      toggle()?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(useProjectSurfacePrefsStore.getState().documentPrefs.propertiesOpen).toBe(true);
  });
});

it("shows unreadable YAML as written, with a plain note", async () => {
  fetchProperties.mockResolvedValue({
    entries: [],
    aliases: [],
    unreadable: true,
    text: "title: [unclosed\n",
  });
  await show(async (root) => {
    expect(toggle()?.textContent).toBe("PropertiesCouldn't be read");
    await act(async () => toggle()?.click());
    expect(root.textContent).toContain(
      "These properties couldn't be read, so they're shown as written.",
    );
    expect(root.querySelector("pre")?.textContent).toBe("title: [unclosed\n");
  });
});

it("shows nothing for frontmatter with no keys", async () => {
  fetchProperties.mockResolvedValue({
    entries: [],
    aliases: [],
    unreadable: false,
    text: "# note\n",
  });
  await show(async (root) => {
    expect(root.textContent).toBe("");
  });
});

it("says it couldn't load and retries from the open block", async () => {
  fetchProperties.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(chapter);
  await show(async (root) => {
    expect(toggle()?.textContent).toBe("PropertiesCouldn't load");
    await act(async () => toggle()?.click());
    expect(root.querySelector("[role=alert]")?.textContent).toContain("Couldn't load properties.");
    await act(async () => root.querySelector<HTMLButtonElement>("[role=alert] button")?.click());
    await settle();
    expect(root.querySelector("dl")).not.toBeNull();
  });
});
