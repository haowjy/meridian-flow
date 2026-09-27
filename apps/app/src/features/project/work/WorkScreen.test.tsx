import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkCreationDestination } from "./WorkScreen";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, ""),
  msg: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${values[index] ?? ""}${part}`, ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("pending Work destination", () => {
  it("renders the pending header and retry surface after creation failure", () => {
    const html = renderToStaticMarkup(
      <WorkCreationDestination
        name="Revise arc 3"
        goal="Tighten the midpoint."
        failed
        onRetry={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(html).toContain("Revise arc 3");
    expect(html).toContain("Creating");
    expect(html).toContain("Chats");
    expect(html).toContain("Files");
    expect(html).toContain("Retry");
  });
});
