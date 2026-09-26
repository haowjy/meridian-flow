// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/rich-content/Markdown", () => ({
  Markdown: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { toolView } from "./report-test-fixtures";
import { ToolRow } from "./ToolRow";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe("thread_report tool row", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("keeps the report collapsed in its titled activity row until expanded", async () => {
    await act(async () =>
      root.render(
        <ToolRow
          tool={toolView({
            toolCallId: "call-report",
            toolName: "thread_report",
            input: { ref: "p3", execution: "execution-1" },
            output: {
              ref: "p3",
              execution: "execution-1",
              outcome: "succeeded",
              source: "explicit",
              summary: "First line.\nFull report.",
              partial: false,
              reason: null,
            },
          })}
        />,
      ),
    );

    expect(host.textContent).toContain("First line.");
    expect(host.textContent).not.toContain("Full report.");
    const toggle = host.querySelector("button");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle?.click());
    expect(host.textContent).toContain("Full report.");
  });
});
