/** Dock header omits a view switch that has nothing to switch. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { DockHeader } = await import("./DockHeader");

describe("DockHeader", () => {
  it("hides the switch when only the primary view is available", () => {
    const html = renderToStaticMarkup(
      <DockHeader
        view="chat"
        views={["chat"]}
        onSelectView={vi.fn()}
        threadSelect={<span>Conversation</span>}
      />,
    );

    expect(html).not.toContain('role="tablist"');
    expect(html).toContain("Conversation");
  });

  it("shows the switch when Changes is available", () => {
    const html = renderToStaticMarkup(
      <DockHeader view="chat" views={["chat", "changes"]} onSelectView={vi.fn()} />,
    );

    expect(html).toContain('role="tablist"');
    expect(html).toContain("Changes");
  });
});
