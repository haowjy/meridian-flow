// @vitest-environment jsdom
/** A diagram fence renders only when it closes, even before reply settlement. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";

const renderDiagram = vi.hoisted(() =>
  vi.fn(async () => '<svg xmlns="http://www.w3.org/2000/svg"><text>Gate</text></svg>'),
);
vi.mock("@/core/editor/diagrams/mermaid-render", () => ({ renderMermaid: renderDiagram }));

it("shows the open source, draws on fence closure, and retains the diagram on settlement", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    const open = "```mermaid\ngraph TD\nA --> B";
    await act(async () =>
      root.render(
        <Markdown mode="streaming" streamId="test-stream">
          {open}
        </Markdown>,
      ),
    );
    expect(host.querySelector("pre")?.textContent).toContain("A --> B");
    expect(renderDiagram).not.toHaveBeenCalled();
    await act(async () =>
      root.render(<Markdown mode="streaming" streamId="test-stream">{`${open}\n\`\`\``}</Markdown>),
    );
    expect(host.querySelector("[data-diagram-preview] svg")).not.toBeNull();
    const svg = host.querySelector("svg");
    await act(async () => root.render(<Markdown>{`${open}\n\`\`\``}</Markdown>));
    expect(host.querySelector("[data-diagram-preview] svg")).toBe(svg);
    await act(async () => root.render(<Markdown>{open}</Markdown>));
    expect(host.querySelector("pre")?.textContent).toContain("A --> B");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("offers an honest read-only source action for a failed transcript diagram", async () => {
  renderDiagram.mockRejectedValueOnce(new Error("Invalid diagram syntax"));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Markdown>{"```mermaid\ninvalid source\n```"}</Markdown>));
    const action = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Show source",
    );
    expect(action).toBeDefined();
    await act(async () => action?.click());
    expect(host.querySelector("pre")?.textContent).toBe("invalid source");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
