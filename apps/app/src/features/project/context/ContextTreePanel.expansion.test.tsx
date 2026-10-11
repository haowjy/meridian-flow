// @vitest-environment jsdom
/** Folder clicks share the persisted disclosure owner's default at every depth. */
import { act, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ContextTreePanel } from "./ContextTreePanel";

vi.mock("./account-feature-context", () => ({ useAccountId: () => "account" }));
vi.mock("./TreeCreationProvider", () => ({ useOptionalTreeCreation: () => null }));
vi.mock("./LinkUpdateNote", () => ({ LinkUpdateNote: () => null }));
vi.mock("./ContextEntryActions", () => ({
  ContextEntryMenu: ({ children }: { children: ReactNode }) => children,
  EntryKebabButton: () => null,
  DeleteConfirmationDialog: () => null,
  useDeleteConfirmation: () => ({ requestDelete: () => {} }),
}));
vi.mock("@/client/query/useContextCatalog", () => {
  const folder = (entryId: string, parentId: string | null, path: string) => ({
    kind: "dir",
    entryId,
    parentId,
    name: entryId,
    path,
    uri: `manuscript://${path}`,
  });
  const root = folder("root", null, "");
  const top = folder("top", "root", "top");
  const nested = folder("nested", "top", "top/nested");
  const leaf = folder("leaf", "nested", "top/nested/leaf");
  const entries = [top, nested, leaf];
  const catalog = {
    root,
    children: (parentId: string) => entries.filter((entry) => entry.parentId === parentId),
    findPath: (path: string) => entries.find((entry) => entry.path === path) ?? null,
  };
  return {
    useContextCatalogViews: (_projectId: string, schemes: string[]) =>
      Object.fromEntries(
        schemes.map((scheme) => [scheme, { catalog, isComplete: true, isError: false }]),
      ),
  };
});

it("opens untouched top-level and nested folders with one click each", async () => {
  await withReactRoot(
    <ContextTreePanel
      projectId="project"
      editorWorkId={null}
      activeScheme={null}
      activePath={null}
      onSelectFile={() => {}}
      onRequestCreate={() => {}}
      onCreateDone={() => {}}
    />,
    async () => {
      const section = document.querySelector("section");
      const header = section?.querySelector<HTMLButtonElement>("button[aria-expanded]");
      expect(header?.getAttribute("aria-expanded")).toBe("false");
      await act(async () => header?.click());
      const row = (name: string) =>
        section?.querySelector<HTMLElement>(`[aria-label="Toggle folder ${name}"]`);
      const top = row("top");
      expect(top?.getAttribute("aria-expanded")).toBe("false");
      expect(row("nested")).toBeNull();
      await act(async () => top?.click());
      expect(top?.getAttribute("aria-expanded")).toBe("true");
      const nested = row("nested");
      expect(nested?.getAttribute("aria-expanded")).toBe("false");
      expect(row("leaf")).toBeNull();
      await act(async () => nested?.click());
      expect(nested?.getAttribute("aria-expanded")).toBe("true");
      expect(row("leaf")).not.toBeNull();
      await act(async () => top?.click());
      expect(top?.getAttribute("aria-expanded")).toBe("false");
      expect(row("nested")).toBeNull();
    },
  );
});
