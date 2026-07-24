import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { DraftModeIndicator } = await import("./DraftModeIndicator");

describe("DraftModeIndicator", () => {
  it("states that draft mode waits for writer review without presenting a control", () => {
    const html = renderToStaticMarkup(<DraftModeIndicator />);

    expect(html).toContain('data-thread-write-mode="draft"');
    expect(html).toContain("Draft mode");
    expect(html).toContain("AI changes wait for your review");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });
});
