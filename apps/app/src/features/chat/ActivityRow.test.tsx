import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((copy, part, index) => copy + part + (values[index] ?? ""), ""),
}));

const { navigation } = vi.hoisted(() => ({
  navigation: {
    open: vi.fn<(uri: string) => void>(),
    canOpen: (_uri: string) => true,
  },
}));

vi.mock("./ChatContextNavigation", () => ({
  useChatContextNavigation: () => navigation.open,
  useChatContextRoutability: () => navigation.canOpen,
}));

const { ActivityRow } = await import("./ActivityRow");
const { DocumentName } = await import("./DocumentName");
const { FilePlus2 } = await import("lucide-react");

function row(node: HTMLElement | null) {
  if (!node) throw new Error("missing root");
  const buttons = Array.from(node.querySelectorAll("button"));
  return {
    buttons,
    toggle: buttons.find((button) => button.hasAttribute("aria-expanded")) ?? null,
    door: buttons.find((button) => button.getAttribute("aria-label")?.startsWith("Open")) ?? null,
  };
}

async function withRow(run: (root: HTMLElement) => Promise<void> | void) {
  await withReactRoot(
    <ActivityRow
      Icon={FilePlus2}
      title={<DocumentName path="manuscript://chapter-3.md" />}
      expand={() => <p>preview</p>}
    />,
    async () => {
      const root = document.getElementById("root");
      if (!root) throw new Error("missing root");
      await run(root);
    },
  );
}

describe("a closed row does no work", () => {
  it("builds its expand only once the writer opens it", async () => {
    const build = vi.fn(() => <p>preview</p>);

    await withReactRoot(
      <ActivityRow Icon={FilePlus2} title="Read chapter-3" expand={build} />,
      async () => {
        const root = document.getElementById("root");
        if (!root) throw new Error("missing root");
        // A settled turn with twelve reads must not parse twelve payloads to
        // render twelve closed rows.
        expect(build).not.toHaveBeenCalled();

        await act(async () => {
          row(root).toggle?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        });
        expect(build).toHaveBeenCalled();
      },
    );
  });
});

describe("two actions, one row", () => {
  it("keeps the door a sibling of the row toggle, never a child", async () => {
    await withRow((root) => {
      const { buttons, toggle, door } = row(root);

      expect(buttons).toHaveLength(2);
      expect(toggle).not.toBeNull();
      expect(door).not.toBeNull();
      // A <button> authored inside a <button> is invalid HTML and breaks
      // screen readers; JSX will not rescue it the way the parser rescues
      // static markup.
      expect(buttons.some((button) => button.querySelector("button") !== null)).toBe(false);
    });
  });

  it("labels the toggle with the row title it has no text of its own", async () => {
    await withRow((root) => {
      const { toggle } = row(root);
      const labelledBy = toggle?.getAttribute("aria-labelledby");

      expect(toggle?.textContent).toBe("");
      expect(labelledBy).toBeTruthy();
      expect(document.getElementById(labelledBy ?? "")?.textContent).toContain("chapter-3");
    });
  });

  it("stretches the toggle across the title row only, so an open expand stays open", async () => {
    await withRow((root) => {
      const { toggle } = row(root);
      const titleRow = toggle?.parentElement;

      expect(toggle?.className).toContain("absolute inset-0");
      expect(titleRow?.className).toContain("relative");
      expect(titleRow?.querySelector("p")).toBeNull();
    });
  });

  it("expands on the row and navigates on the name, never both at once", async () => {
    await withRow(async (root) => {
      const { toggle, door } = row(root);

      await act(async () => {
        door?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      expect(navigation.open).toHaveBeenCalledWith("manuscript://chapter-3.md");
      expect(row(root).toggle?.getAttribute("aria-expanded")).toBe("false");

      await act(async () => {
        toggle?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      expect(row(root).toggle?.getAttribute("aria-expanded")).toBe("true");
      expect(navigation.open).toHaveBeenCalledTimes(1);
    });
  });
});
