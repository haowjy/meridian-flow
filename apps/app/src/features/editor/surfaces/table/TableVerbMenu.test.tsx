// @vitest-environment jsdom
/**
 * What a greyed table verb shows, and when it says why.
 *
 * The row carries its label alone; the reason is standing information the
 * writer did not ask for, so it waits for hover or focus (ruling 2026-07-29).
 * These assert the item-state → rendering mapping the whole menu layer shares:
 * a refused row is label-only and answers on focus, an enabled row keeps the
 * hint it already had.
 */
import { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";

vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));

// Radix measures the tooltip's arrow on mount, and jsdom has no layout to
// observe. An observer that never fires is the honest stand-in; the global
// setup leaves it out because a suite that feature-detects it should still see
// the absence.
class NoLayoutResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoLayoutResizeObserver;

const { EditorMenu } = await import("../../chrome/EditorMenu");
const { TABLE_VERB_IDS } = await import("./table-commands");
const { TableColumnMenuItems } = await import("./TableVerbMenu");

type TableVerbId = import("./table-commands").TableVerbId;
type TableBlockedReason = import("./table-commands").TableBlockedReason;
type TableVerbStates = import("./table-commands").TableVerbStates;

function states(blocks: Partial<Record<TableVerbId, TableBlockedReason>>): TableVerbStates {
  return Object.fromEntries(
    TABLE_VERB_IDS.map((id) => [id, { active: false, blockedBy: blocks[id] ?? null }]),
  ) as TableVerbStates;
}

function row(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((item) =>
    item.textContent?.startsWith(label),
  );
  if (!found) throw new Error(`no menu row for ${label}`);
  return found;
}

let editor: Editor | null = null;
let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  const element = document.createElement("div");
  document.body.append(element);
  editor = new Editor({
    element,
    extensions: createStandaloneEditorExtensions(),
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  editor?.destroy();
  editor = null;
  root = null;
  container = null;
});

function open(blocks: Partial<Record<TableVerbId, TableBlockedReason>>) {
  if (!editor) throw new Error("no editor");
  const current = editor;
  act(() => {
    root?.render(
      <EditorMenu
        editor={current}
        id="table-column-menu"
        open
        onOpenChange={() => {}}
        at={{ x: 0, y: 0 }}
      >
        <TableColumnMenuItems
          run={() => {}}
          states={states(blocks)}
          alignment={null}
          placement="left"
          mergeJoinsText={false}
        />
      </EditorMenu>,
    );
  });
}

describe("a refused table verb", () => {
  it("shows its label and nothing else", () => {
    open({ moveColumnLeft: "at-table-edge" });

    // Its label and its shortcut, which is what the row said when it ran.
    expect(row("Move column left").textContent).toBe("Move column leftAlt+←");
    expect(document.body.textContent).not.toContain("already at the edge");
  });

  it("says why once the writer is on it", async () => {
    open({ mergeCells: "header-and-body" });

    await act(async () => {
      row("Merge cells").focus();
    });

    const tooltip = document.querySelector("[role='tooltip']");
    expect(tooltip?.textContent).toContain("The header row does not merge into the body.");
  });

  it("stays reachable and refuses rather than disappearing", () => {
    open({ splitCell: "not-merged" });

    const item = row("Split cell");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.hasAttribute("data-disabled")).toBe(false);
  });
});

describe("a verb that runs", () => {
  it("keeps the hint that says what it will make", () => {
    open({});

    expect(row("Merge cells").textContent).toContain("One cell across the selection");
  });
});
