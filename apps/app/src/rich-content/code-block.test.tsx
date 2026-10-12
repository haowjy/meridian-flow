// @vitest-environment jsdom
/**
 * A fenced code block has at most one slim header row. With a language the
 * actions ride that row beside the label; with none there is no row, and the
 * actions the block already offers (download, copy) stay in the document for
 * pointer, touch and keyboard.
 *
 * jsdom has no layout, so the geometry (clear space above the first line, the
 * row's height at each width) is checked in the browser. What is pinned here is
 * the part that breaks silently: `code-block.css` keys off Streamdown's rendered
 * attributes, which a Streamdown upgrade can change.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

// Not `?raw`: Vitest strips CSS files down to an empty string.
const CODE_BLOCK_CSS = readFileSync(join(import.meta.dirname, "code-block.css"), "utf8");

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function renderFence(fence: string) {
  const style = document.createElement("style");
  style.textContent = CODE_BLOCK_CSS;
  document.head.append(style);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    host.remove();
    style.remove();
  });
  await act(async () =>
    root.render(createElement(Markdown, { mode: "streaming", children: fence })),
  );
  const block = host.querySelector<HTMLElement>('[data-streamdown="code-block"]');
  if (!block) throw new Error("no code block rendered");
  return {
    header: block.querySelector<HTMLElement>('[data-streamdown="code-block-header"]'),
    actions: block.querySelector<HTMLElement>('[data-streamdown="code-block-actions"]'),
    actionsWrapper: block.querySelector<HTMLElement>(
      ':scope > :has(> [data-streamdown="code-block-actions"])',
    ),
  };
}

describe("code block with no language", () => {
  it("hides the empty label row and keeps download and copy in the document", async () => {
    const { header, actions, actionsWrapper } = await renderFence("```\nplain text\n```");

    expect(header && getComputedStyle(header).display).toBe("none");
    expect(actions?.querySelector('[data-streamdown="code-block-copy-button"]')).not.toBeNull();
    expect(actions?.querySelector('[data-streamdown="code-block-download-button"]')).not.toBeNull();
    // Out of the flow, so the actions take no row of their own.
    expect(actionsWrapper && getComputedStyle(actionsWrapper).position).toBe("absolute");
  });
});

describe("code block with a language", () => {
  it("keeps the label and puts the actions on its row, not a second one", async () => {
    const { header, actions, actionsWrapper } = await renderFence("```python\nprint(1)\n```");

    expect(header && getComputedStyle(header).display).not.toBe("none");
    expect(header?.textContent).toBe("python");
    expect(actions?.querySelector('[data-streamdown="code-block-copy-button"]')).not.toBeNull();
    expect(actionsWrapper && getComputedStyle(actionsWrapper).position).toBe("absolute");
  });
});
