// @vitest-environment jsdom
/** Small semantic journey suite for the shared Work catalog panel. */
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { WorkPickerPanel } from "./WorkPickerPanel";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
const operation = { currentWorkId: "a", targetId: null, pending: false, failure: null } as const;
const archived = { id: "b", name: "Second arc", goal: "Climb", status: "archived" } as Work;

describe("WorkPickerPanel", () => {
  it.each([
    ["loading", "Loading Works…"],
    ["empty", "No Works yet."],
  ] as const)("renders truthful %s state", async (status, copy) => {
    await withReactRoot(
      <WorkPickerPanel
        catalog={{ status }}
        operation={operation}
        query=""
        onQueryChange={() => {}}
        onChoose={() => {}}
      />,
      () => {
        expect(document.body.textContent).toContain(copy);
        expect(document.body.textContent).not.toContain("No works match your search.");
      },
    );
  });

  it("offers retry for a catalog error", async () => {
    const retry = vi.fn();
    await withReactRoot(
      <WorkPickerPanel
        catalog={{ status: "error", retry }}
        operation={operation}
        query=""
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
        catalog={{ status: "ready", works: [archived], refreshing: false }}
        operation={operation}
        query="Second"
        onQueryChange={() => {}}
        onChoose={choose}
      />,
      () => {
        Array.from(document.querySelectorAll("button"))
          .find((node) => node.textContent?.includes("Second arc"))
          ?.click();
        expect(choose).toHaveBeenCalledWith(archived);
      },
    );
  });
});
