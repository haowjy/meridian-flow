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

import { ReportContent, type ReportContentValue } from "./ReportContent";
import { savedArtifact } from "./report-test-fixtures";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe("shared report content", () => {
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

  it("renders report text, serialized payload, artifacts, empty outcomes, and partial status", async () => {
    const report: ReportContentValue = {
      summary: "First line.\nFull report.",
      payload: { answer: 42 },
      artifacts: [savedArtifact],
      reason: "budget_exhausted",
      partial: true,
    };
    await act(async () => root.render(<ReportContent report={report} empty="No report text" />));
    expect(host.textContent).toContain("First line.\nFull report.");
    expect(host.textContent).toContain('{\n  "answer": 42\n}');
    expect(host.textContent).toContain("Saved artifact");
    expect(host.textContent).toContain("Reason: budget_exhausted");
    expect(host.textContent).toContain("Partial result");
    expect(host.textContent).not.toContain("No report text");

    await act(async () =>
      root.render(
        <ReportContent
          report={{ summary: "", artifacts: [], reason: "runtime_error", partial: true }}
          empty="No partial report text was returned."
        />,
      ),
    );
    expect(host.textContent).toContain("No partial report text was returned.");
    expect(host.textContent).toContain("Reason: runtime_error");
    expect(host.textContent).not.toContain("Partial result");
  });
});
