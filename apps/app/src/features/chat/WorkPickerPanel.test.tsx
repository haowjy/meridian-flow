// @vitest-environment jsdom
/** Small semantic journey suite for the shared Work catalog panel. */
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  deriveWorkPickerViewModel,
  type WorkCatalogView,
  WorkPickerPanel,
} from "./WorkPickerPanel";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
const operation = { currentWorkId: "a", targetId: null, pending: false, failure: null } as const;
const archived = { id: "b", name: "Second arc", goal: "Climb", status: "archived" } as Work;
const view = (catalog: WorkCatalogView, query = "", pending = false) =>
  deriveWorkPickerViewModel(catalog, query, pending);

describe("WorkPickerPanel", () => {
  it.each([
    ["loading", "Loading Work…"],
    ["empty", "No Work yet."],
  ] as const)("renders truthful %s state", async (status, copy) => {
    await withReactRoot(
      <WorkPickerPanel
        view={view({ status })}
        operation={operation}
        onQueryChange={() => {}}
        onChoose={() => {}}
      />,
      () => {
        expect(document.body.textContent).toContain(copy);
        expect(document.body.textContent).not.toContain("No Work matches your search.");
        expect(document.querySelector('input[type="search"]')).not.toBeNull();
        expect(document.querySelector('input[type="search"]')?.hasAttribute("disabled")).toBe(true);
        expect(document.querySelector(".app-scroll")?.textContent).toContain(copy);
      },
    );
  });

  it("offers retry for a catalog error", async () => {
    const retry = vi.fn();
    await withReactRoot(
      <WorkPickerPanel
        view={view({ status: "error", retry })}
        operation={operation}
        onQueryChange={() => {}}
        onChoose={() => {}}
      />,
      () => {
        Array.from(document.querySelectorAll("button"))
          .find((node) => node.textContent === "Retry")
          ?.click();
        expect(retry).toHaveBeenCalledOnce();
      },
    );
  });

  it("chooses an archived Work without confirmation", async () => {
    const choose = vi.fn();
    await withReactRoot(
      <WorkPickerPanel
        view={view({ status: "ready", works: [archived], refreshing: false }, "Second")}
        operation={operation}
        onQueryChange={() => {}}
        onChoose={choose}
      />,
      () => {
        expect(document.querySelector('input[type="search"]')?.getAttribute("placeholder")).toBe(
          "Search Work",
        );
        expect(document.querySelector("section")?.getAttribute("aria-label")).toBe("Archived Work");
        Array.from(document.querySelectorAll("button"))
          .find((node) => node.textContent?.includes("Second arc"))
          ?.click();
        expect(choose).toHaveBeenCalledWith(archived);
      },
    );
  });

  it("keeps the current name and goal accessible without a routine third line", async () => {
    const current = { id: "a", name: "Opening arc", goal: "Ascend", status: "active" } as Work;
    await withReactRoot(
      <WorkPickerPanel
        view={view({ status: "ready", works: [current], refreshing: false })}
        operation={operation}
        onQueryChange={() => {}}
        onChoose={() => {}}
      />,
      () => {
        expect(document.querySelector("label[for]")?.textContent).toBe("Search Work");
        expect(document.querySelector("section")?.getAttribute("aria-label")).toBe("Active Work");
        const row = document.querySelector<HTMLButtonElement>("[data-work-choice]");
        const search = document.querySelector<HTMLInputElement>('input[type="search"]');
        expect(row?.className).toContain("px-2");
        expect(row?.className).toContain("dropdown-focus-ring");
        expect(search?.parentElement?.className).toContain("mx-2");
        expect(row?.getAttribute("aria-current")).toBe("true");
        expect(row?.hasAttribute("aria-label")).toBe(false);
        const description = document.getElementById(row?.getAttribute("aria-describedby") ?? "");
        expect(row?.textContent).toContain("Ascend");
        expect(description?.textContent).toContain("Current Work for this chat");
        expect(row?.textContent).not.toContain("Current for this chat");
      },
    );
  });

  it("preserves archived and changing state in accessible descriptions", async () => {
    await withReactRoot(
      <WorkPickerPanel
        view={view({ status: "ready", works: [archived], refreshing: false }, "", true)}
        operation={{ currentWorkId: "a", targetId: "b", pending: true, failure: null }}
        onQueryChange={() => {}}
        onChoose={() => {}}
      />,
      () => {
        const row = document.querySelector<HTMLButtonElement>("[data-work-choice]");
        const description = document.getElementById(row?.getAttribute("aria-describedby") ?? "");
        expect(description?.textContent).toContain("Goal: Climb");
        expect(row?.textContent).toContain("Archived");
        expect(row?.textContent).toContain("Changing work");
      },
    );
  });
});
