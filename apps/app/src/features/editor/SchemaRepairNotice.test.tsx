// @vitest-environment jsdom
/** Writer report contract for session-scoped schema repairs. */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { SchemaRepairNotice } = await import("./SchemaRepairNotice");

describe("SchemaRepairNotice", () => {
  it("coalesces repairs, exposes full removed prose for copying, and dismisses", async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <SchemaRepairNotice
          repairs={[
            {
              phase: "open",
              detectedAt: "2026-07-28T12:00:00.000Z",
              deletedNodeTypes: ["sidebar"],
              deletedClockCount: 12,
              removedText: "first lost passage",
            },
            {
              phase: "live",
              detectedAt: "2026-07-28T12:01:00.000Z",
              deletedNodeTypes: ["aside"],
              deletedClockCount: 9,
              removedText: "second lost passage",
            },
          ]}
        />,
      );
    });

    expect(container.querySelector("[data-schema-repair-notice]")?.textContent).toContain(
      "Meridian removed a small part of this chapter that this version can't display. The removed text is saved below so you can keep the words.",
    );
    expect(
      [...container.querySelectorAll("[data-schema-repair-removed-text]")].map(
        (element) => element.textContent,
      ),
    ).toEqual(["first lost passage", "second lost passage"]);
    expect(container.querySelectorAll("[data-schema-repair]").length).toBe(2);

    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>("[data-copy-schema-repair]")[1]?.click();
    });
    expect(writeText).toHaveBeenCalledWith("second lost passage");

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-dismiss-schema-repairs]")?.click();
    });
    expect(container.querySelector("[data-schema-repair-notice]")).toBeNull();

    await act(async () => root.unmount());
  });

  it("says so when the browser refuses the copy, and keeps the words in reach", async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new DOMException("blocked", "NotAllowedError")),
      },
    });
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <SchemaRepairNotice
          repairs={[
            {
              phase: "open",
              detectedAt: "2026-07-28T12:00:00.000Z",
              deletedNodeTypes: ["sidebar"],
              deletedClockCount: 12,
              removedText: "the passage the schema could not hold",
            },
          ]}
        />,
      );
    });

    expect(container.querySelector("[data-schema-repair-copy-blocked]")).toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-copy-schema-repair]")?.click();
    });

    // A button that says nothing after a blocked write has told the writer
    // their rescued passage is safe when it is still only on this screen.
    expect(container.querySelector("[data-schema-repair-copy-blocked]")?.textContent).toContain(
      "would not let the page write to the clipboard",
    );
    // And the words themselves are still there to select by hand.
    expect(container.querySelector("[data-schema-repair-removed-text]")?.textContent).toBe(
      "the passage the schema could not hold",
    );

    await act(async () => root.unmount());
  });
});
