// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/rich-content/Markdown", () => ({
  Markdown: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { ChildReportBlock } from "./ChildReportBlock";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

describe("ChildReportBlock", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  it("renders returned artifacts alongside the summary on the Return card", async () => {
    await act(async () =>
      root.render(
        <ChildReportBlock
          content={{
            kind: "child-report",
            props: {
              summary: "Forest mapped.",
              artifacts: [{ type: "object", uri: "scratch://forest.md", label: "Forest" }],
            },
          }}
          respond={vi.fn()}
          isAwaitingResponse={false}
          responseState={null}
          retry={vi.fn()}
        />,
      ),
    );

    expect(document.body.textContent).toContain("Return");
    expect(document.body.textContent).toContain("Forest mapped.");
    const link = document.querySelector("a[href='scratch://forest.md']");
    expect(link).not.toBeNull();
    expect(document.body.textContent).toContain("Forest");
  });

  it("renders a summary-only Return card with no artifact grid", async () => {
    await act(async () =>
      root.render(
        <ChildReportBlock
          content={{ kind: "child-report", props: { summary: "Done." } }}
          respond={vi.fn()}
          isAwaitingResponse={false}
          responseState={null}
          retry={vi.fn()}
        />,
      ),
    );

    expect(document.body.textContent).toContain("Done.");
    expect(document.querySelector("ul")).toBeNull();
  });
});
