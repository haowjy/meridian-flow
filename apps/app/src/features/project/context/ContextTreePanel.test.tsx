/**
 * ContextTreePanel row-menu creation tests: the New file / New folder entry
 * actions route the shared creation state to a nested parent path, so the
 * inline CreateRow renders under the target folder, submits a prefixed path,
 * and validates collisions against that folder's children.
 *
 * Radix menu primitives are mocked open (repo-wide JSDOM pattern) — real
 * open/close behavior is a live-probe concern; these tests own the dispatch
 * wiring and the creation coordinator.
 */

import type {
  ProjectContextTreeDirectory,
  ProjectContextTreeFile,
} from "@meridian/contracts/protocol";
import { act, type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...subs: unknown[]) =>
    strings.raw.map((part, index) => part + (subs[index] ?? "")).join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
}));

// Both menu triggers render their items open and inline: context-menu items
// mount as siblings of the row (portal elided), kebab items inside it.
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  return {
    ...actual,
    ContextMenu: {
      Root: ({ children }: { children?: ReactNode }) => <div data-entry-menu-root>{children}</div>,
      Trigger: ({ children }: { children?: ReactNode }) => children,
      Portal: ({ children }: { children?: ReactNode }) => children,
      Content: ({ children }: { children?: ReactNode }) => (
        <div data-context-menu-content>{children}</div>
      ),
      Item: ({ children, onSelect }: { children?: ReactNode; onSelect?: () => void }) => (
        <button type="button" data-context-menu-item onClick={() => onSelect?.()}>
          {children}
        </button>
      ),
      Separator: () => <hr data-context-menu-separator />,
    },
  };
});
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuContent: ({
    children,
    onClick,
  }: {
    children?: ReactNode;
    onClick?: (event: React.MouseEvent) => void;
  }) => (
    // Forward the real content's stopPropagation so item clicks don't also
    // activate the row underneath (kebab items nest inside the row div).
    // biome-ignore lint/a11y/noStaticElementInteractions: test double
    // biome-ignore lint/a11y/useKeyWithClickEvents: test double
    <div data-dropdown-menu-content onClick={onClick}>
      {children}
    </div>
  ),
  DropdownMenuItem: ({ children, onSelect }: { children?: ReactNode; onSelect?: () => void }) => (
    <button type="button" data-dropdown-menu-item onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr data-dropdown-menu-separator />,
}));

const createEntryMock = vi.fn().mockResolvedValue({});
vi.mock("@/client/query/useCreateContextEntry", () => ({
  useCreateContextEntry: () => ({ mutateAsync: createEntryMock, isPending: false }),
}));
vi.mock("@/client/query/useDeleteContextEntry", () => ({
  useDeleteContextEntry: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/client/query/useContextWorkId", () => ({
  useContextWorkId: () => null,
  contextRequestOptionsForScheme: () => undefined,
}));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => ({ works: [] }),
}));

function file(name: string, path: string): ProjectContextTreeFile {
  return {
    kind: "file",
    documentId: `doc-${name}`,
    name,
    path,
    uri: `manuscript://${path}`,
    provisionalName: false,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  };
}

function dir(
  name: string,
  path: string,
  children: ProjectContextTreeDirectory["children"] = [],
): ProjectContextTreeDirectory {
  return { kind: "dir", name, path, uri: `manuscript://${path}`, children };
}

// alpha/ is depth 1 (auto-expanded); alpha/notes is depth 2 (starts collapsed).
const manuscriptTree = dir("", "/", [
  dir("alpha", "/alpha", [file("existing.md", "/alpha/existing.md"), dir("notes", "/alpha/notes")]),
  file("top.md", "/top.md"),
]);

vi.mock("@/client/query/useProjectContextTree", () => ({
  useProjectContextTree: (_projectId: string, scheme: string) => ({
    tree: scheme === "manuscript" ? manuscriptTree : dir("", "/"),
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

const { ContextTreePanel } = await import("./ContextTreePanel");

/** Controlled harness mirroring NavigationDrawer's creation wiring. */
function Panel({ onSelectFile = () => {} }: { onSelectFile?: () => void }) {
  const [creating, setCreating] =
    useState<React.ComponentProps<typeof ContextTreePanel>["creating"]>(null);
  return (
    <ContextTreePanel
      projectId="project-1"
      activeThreadId={null}
      activeScheme={null}
      activePath={null}
      onSelectFile={onSelectFile}
      creating={creating}
      onRequestCreate={(scheme, kind, parentPath) => setCreating({ scheme, kind, parentPath })}
      onCreateDone={() => setCreating(null)}
    />
  );
}

/** The mocked menu root wrapping the row whose visible label matches. */
function entryMenuRoot(label: string): HTMLElement {
  const roots = [...document.querySelectorAll<HTMLElement>("[data-entry-menu-root]")];
  const hit = roots.find((root) =>
    [...root.querySelectorAll<HTMLElement>('[role="button"]')].some((row) =>
      row.textContent?.includes(label),
    ),
  );
  if (!hit) throw new Error(`no entry menu root for ${label}`);
  return hit;
}

function menuItemLabels(root: HTMLElement, selector: string): string[] {
  return [...root.querySelectorAll<HTMLElement>(selector)].map(
    (item) => item.textContent?.trim() ?? "",
  );
}

async function clickMenuItem(root: HTMLElement, selector: string, label: string): Promise<void> {
  const item = [...root.querySelectorAll<HTMLElement>(selector)].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!item) throw new Error(`no menu item ${label}`);
  await act(async () => item.click());
}

function createInput(): HTMLInputElement {
  const input =
    document.querySelector<HTMLInputElement>('input[aria-label="Folder name"]') ??
    document.querySelector<HTMLInputElement>('input[aria-label="File name"]');
  if (!input) throw new Error("no create input");
  return input;
}

async function typeAndCommit(input: HTMLInputElement, name: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(input, name);
    // react-dom is in input-event-polyfill mode here (support was probed
    // before the harness attached a DOM), so value changes are only noticed
    // on key events — the keyup delivers onChange before Enter submits.
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent("keyup", { key: "e", bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

/**
 * react-dom decides input-event support at import time; in the node harness
 * there is no DOM then, so it falls back to the IE polyfill and calls
 * `attachEvent` on whatever gains focus. Stub it on the JSDOM prototype
 * before any create input mounts (focuses itself on mount).
 */
function shimLegacyFocusEvents(): void {
  Object.assign(window.HTMLElement.prototype, {
    attachEvent: () => {},
    detachEvent: () => {},
  });
}

async function renderPanel(run: () => Promise<void> | void): Promise<void> {
  await withReactRoot(<Panel />, async () => {
    shimLegacyFocusEvents();
    await run();
  });
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  createEntryMock.mockClear();
  vi.unstubAllGlobals();
});

describe("ContextTreePanel row menus", () => {
  it("offers New file, New folder, Rename, Delete on folder and file rows in both triggers", async () => {
    await renderPanel(() => {
      const expected = ["New file", "New folder", "Rename", "Delete"];
      for (const label of ["alpha", "top.md"]) {
        const root = entryMenuRoot(label);
        expect(menuItemLabels(root, "[data-context-menu-item]")).toEqual(expected);
        expect(menuItemLabels(root, "[data-dropdown-menu-item]")).toEqual(expected);
        // Destructive action stays separated from the creation/rename group.
        expect(root.querySelector("[data-context-menu-separator]")).not.toBeNull();
      }
    });
  });

  it("creates a folder inside the target folder from its context menu", async () => {
    await renderPanel(async () => {
      await clickMenuItem(entryMenuRoot("alpha"), "[data-context-menu-item]", "New folder");
      const input = createInput();
      expect(input.getAttribute("aria-label")).toBe("Folder name");
      // Nested at child depth: /alpha sits at depth 1 (24px), children at 2.
      const row = input.closest<HTMLElement>("div[style]");
      expect(row?.style.paddingLeft).toBe("40px");
      await typeAndCommit(input, "chapters");
      expect(createEntryMock).toHaveBeenCalledWith({
        scheme: "manuscript",
        type: "folder",
        path: "/alpha/chapters",
      });
    });
  });

  it("creates in the file's parent folder from a file row's kebab menu", async () => {
    await renderPanel(async () => {
      await clickMenuItem(entryMenuRoot("existing.md"), "[data-dropdown-menu-item]", "New file");
      await typeAndCommit(createInput(), "scene-2.md");
      expect(createEntryMock).toHaveBeenCalledWith({
        scheme: "manuscript",
        type: "file",
        path: "/alpha/scene-2.md",
      });
    });
  });

  it("creates at the scheme root from a top-level file row", async () => {
    await renderPanel(async () => {
      await clickMenuItem(entryMenuRoot("top.md"), "[data-context-menu-item]", "New file");
      await typeAndCommit(createInput(), "prologue.md");
      expect(createEntryMock).toHaveBeenCalledWith({
        scheme: "manuscript",
        type: "file",
        path: "/prologue.md",
      });
    });
  });

  it("auto-expands a collapsed folder so the create row is visible, then submits nested", async () => {
    await renderPanel(async () => {
      // notes/ is depth 2 → collapsed by default: its would-be children absent.
      const notesRow = [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
        (row) => row.getAttribute("aria-label") === "Toggle folder notes",
      );
      expect(notesRow?.getAttribute("aria-expanded")).toBe("false");
      await clickMenuItem(entryMenuRoot("notes"), "[data-context-menu-item]", "New folder");
      const expandedNotesRow = [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
        (row) => row.getAttribute("aria-label") === "Toggle folder notes",
      );
      expect(expandedNotesRow?.getAttribute("aria-expanded")).toBe("true");
      await typeAndCommit(createInput(), "drafts");
      expect(createEntryMock).toHaveBeenCalledWith({
        scheme: "manuscript",
        type: "folder",
        path: "/alpha/notes/drafts",
      });
    });
  });

  it("scopes collision validation to the target folder's children", async () => {
    await renderPanel(async () => {
      await clickMenuItem(entryMenuRoot("alpha"), "[data-context-menu-item]", "New file");
      const input = createInput();
      // Colliding with a sibling inside /alpha blocks the commit.
      await typeAndCommit(input, "existing.md");
      expect(createEntryMock).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("already exists");
      // A root-level name is NOT a collision inside /alpha.
      await typeAndCommit(input, "top.md");
      expect(createEntryMock).toHaveBeenCalledWith({
        scheme: "manuscript",
        type: "file",
        path: "/alpha/top.md",
      });
    });
  });

  it("cancels the nested create row with Escape", async () => {
    await renderPanel(async () => {
      await clickMenuItem(entryMenuRoot("alpha"), "[data-context-menu-item]", "New folder");
      const input = createInput();
      await act(async () => {
        input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(document.querySelector('input[aria-label="Folder name"]')).toBeNull();
      expect(createEntryMock).not.toHaveBeenCalled();
    });
  });
});
