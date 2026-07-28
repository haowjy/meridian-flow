/** The search card: separation, honest counts, and a door per passage. */
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((copy, part, index) => copy + part + (values[index] ?? ""), ""),
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));

const { navigation } = vi.hoisted(() => ({
  navigation: {
    open: vi.fn<(uri: string, passage?: { blockHash: string; term: string }) => void>(),
    canOpen: (_uri: string) => true,
  },
}));

vi.mock("./ChatContextNavigation", () => ({
  useChatContextNavigation: () => navigation.open,
  useChatContextRoutability: () => navigation.canOpen,
}));

const { rendererFor } = await import("./tool-renderers");
const { toolCommand } = await import("./tool-command");

type Match = { excerpt: string; blockHash?: string };

function searchTool(output: Array<{ uri: string; matches: Match[]; matchCount?: number }>) {
  return {
    id: "tool-1",
    toolName: "search",
    status: "complete" as const,
    input: { pattern: "elara" },
    output,
    isError: false,
  };
}

/** The expand as the row builds it: a thunk, evaluated only when opened. */
function cardFor(output: Parameters<typeof searchTool>[0]) {
  const tool = searchTool(output);
  expect(toolCommand(tool as never)).toBe("search");
  const build = rendererFor("search").expand?.(tool as never);
  if (!build) throw new Error("no expand");
  return build();
}

const CHAPTER_2 = {
  uri: "manuscript://chapter-2.md",
  matchCount: 5,
  matches: [
    { excerpt: "aa11|No one spoke Elara's name near the gate.", blockHash: "aa11" },
    { excerpt: "bb22|At dusk, Elara watched the doors close.", blockHash: "bb22" },
  ],
};
const CHAPTER_3 = {
  uri: "manuscript://chapter-3.md",
  matchCount: 1,
  matches: [{ excerpt: "cc33|Elara's silver eyes caught the light.", blockHash: "cc33" }],
};

function inside(root: HTMLElement) {
  return {
    sections: Array.from(root.querySelectorAll("li")),
    buttons: Array.from(root.querySelectorAll("button")),
    text: root.innerText || root.textContent || "",
  };
}

async function withCard(
  output: Parameters<typeof searchTool>[0],
  run: (root: HTMLElement) => Promise<void> | void,
) {
  navigation.open.mockClear();
  await withReactRoot(cardFor(output), async () => {
    const root = document.getElementById("root");
    if (!root) throw new Error("missing root");
    await run(root);
  });
}

describe("search card", () => {
  it("heads the set with totals and nothing else", async () => {
    await withCard([CHAPTER_2, CHAPTER_3], (root) => {
      const header = root.querySelector("p");

      // Six occurrences across two documents, three passages fetched.
      expect(header?.textContent).toBe("6 results in 2 documents");
      // The row title directly above already says what was searched for, and
      // saying it twice makes the card look like a different question.
      expect(header?.textContent).not.toMatch(/elara/i);
    });
  });

  it("separates documents with a rule, which is the whole point of the card", async () => {
    await withCard([CHAPTER_2, CHAPTER_3], (root) => {
      const { sections } = inside(root);

      expect(sections).toHaveLength(2);
      expect(sections[0].className).not.toContain("border-t");
      expect(sections[1].className).toContain("border-t");
      expect(sections[1].className).toContain("border-border-subtle");
    });
  });

  it("counts the whole document in the badge, not the passages it fetched", async () => {
    await withCard([CHAPTER_2], (root) => {
      const badge = root.querySelector(".sr-only");

      // Two passages came back; five occurrences are in the document.
      expect(root.textContent).toContain("5");
      expect(badge?.textContent).toBe("5 matches");
    });
  });

  it("keeps every fetched passage folded until asked, then grows in place", async () => {
    await withCard([CHAPTER_2], async (root) => {
      expect(root.textContent).toContain("No one spoke Elara");
      expect(root.textContent).not.toContain("At dusk");

      const more = inside(root).buttons.find((b) => b.hasAttribute("aria-expanded"));
      expect(more?.textContent).toContain("1 more");
      expect(more?.getAttribute("aria-expanded")).toBe("false");

      await act(async () => more?.click());

      expect(root.textContent).toContain("At dusk");
      expect(
        inside(root)
          .buttons.find((b) => b.hasAttribute("aria-expanded"))
          ?.getAttribute("aria-expanded"),
      ).toBe("true");
      // Grown, not scrolled: the transcript stays the single scroll owner.
      expect(root.querySelector("[class*=overflow-auto], [class*=overflow-y]")).toBeNull();
    });
  });

  it("lands each passage on its own block, not the document's first", async () => {
    await withCard([CHAPTER_2], async (root) => {
      const passageDoors = () =>
        inside(root).buttons.filter((b) =>
          b.getAttribute("aria-label")?.includes("at this passage"),
        );

      passageDoors()[0].click();
      expect(navigation.open).toHaveBeenLastCalledWith("manuscript://chapter-2.md", {
        blockHash: "aa11",
        term: "elara",
      });

      await act(async () =>
        inside(root)
          .buttons.find((b) => b.hasAttribute("aria-expanded"))
          ?.click(),
      );
      passageDoors()[1].click();

      expect(navigation.open).toHaveBeenLastCalledWith("manuscript://chapter-2.md", {
        blockHash: "bb22",
        term: "elara",
      });
    });
  });

  it("keeps the document's own name a plain document door", async () => {
    await withCard([CHAPTER_3], (root) => {
      const name = inside(root).buttons.find(
        (b) => b.getAttribute("aria-label") === "Open chapter-3",
      );

      name?.click();

      expect(navigation.open).toHaveBeenLastCalledWith("manuscript://chapter-3.md", undefined);
    });
  });

  it("reads in the order it is read: document, its passage, then the rest", async () => {
    await withCard([CHAPTER_2], (root) => {
      const labels = inside(root).buttons.map(
        (b) => b.getAttribute("aria-label") ?? b.textContent?.trim(),
      );

      expect(labels[0]).toBe("Open chapter-2");
      expect(labels[1]).toContain("at this passage");
      expect(labels[2]).toContain("1 more");
    });
  });

  it("will not promise a passage it cannot resolve", async () => {
    await withCard(
      [{ uri: "kb://elara.md", matchCount: 2, matches: [{ excerpt: "A scout from the Vale." }] }],
      (root) => {
        const doors = inside(root).buttons.filter((b) =>
          b.getAttribute("aria-label")?.includes("at this passage"),
        );

        expect(doors).toHaveLength(0);
        expect(root.textContent).toContain("A scout from the Vale.");
      },
    );
  });
});
