// @vitest-environment jsdom
/** Streaming contracts: conservative grammar boundaries, visible tails and settlement identity. */
import { markdownCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { StreamingText } from "@/features/chat/StreamingText";
import { Markdown } from "./Markdown";
import { splitMarkdownBlocks } from "./markdown-blocks";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});
function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return {
    host,
    render: async (element: ReactNode) => act(async () => root.render(element)),
  };
}

it("keeps backward-affecting Markdown in the same parse unit", () => {
  const codec = markdownCodec({ schema: buildDocumentSchema() });
  const sources = [
    "first\n\nsecond\n\nthird",
    "\n\nfirst\n\nsecond",
    "```ts\nconst n = 1;\n\nconst m = 2;\n```\n\nafter",
    "~~~~ts\n```\n\ncode\n~~~~\n\nafter",
    "- first\n\n  second paragraph\n\n  - nested\n\n- next\n\nafter",
    "> first\n\n> second\n\nafter",
    "| A | B |\n| --- | --- |\n| one | two |\n\nafter",
    "[first][ref]\n\n[ref]: https://example.com\n\nafter",
    "[ref]\n\n[ref]: https://example.com",
    "<div>\n\ntext\n\n</div>\n\nafter",
    "title\n---\n\nafter\n\n    indented\n\n    code",
  ];
  const json = (source: string) => codec.parse(source).blocks.map((node) => node.toJSON());
  for (const source of sources) {
    for (let end = 1; end <= source.length; end++) {
      const prefix = source.slice(0, end);
      expect(splitMarkdownBlocks(prefix).blocks.flatMap(json), prefix).toEqual(json(prefix));
    }
  }
  expect(splitMarkdownBlocks("first\n\nsecond").blocks).toEqual(["first\n\n", "second"]);
  expect(splitMarkdownBlocks("```ts\ncode\n\nmore").openFence).toBe(true);
  expect(
    splitMarkdownBlocks("settled\n\n```ts\nconst values = [1, 2];\n<div>").blocks,
  ).toHaveLength(2);
});

it("repairs only the live tail without inventing links or tables", async () => {
  const { host, render } = mount();
  await render(<Markdown mode="streaming">{"**finished**\n\n**bol"}</Markdown>);
  expect(host.querySelectorAll("strong")[1]?.textContent).toBe("bol");
  const settled = host.querySelector("strong");
  await render(<Markdown mode="streaming">{"**finished**\n\n[half](https://exam"}</Markdown>);
  expect(host.querySelector("strong")).toBe(settled);
  expect(host.querySelector("a")).toBeNull();
  await render(<Markdown mode="streaming">{"**finished**\n\n| A | B |"}</Markdown>);
  expect(host.querySelector("table")).toBeNull();
  await render(
    <Markdown mode="streaming">
      {"**finished**\n\n| A | B |\n| --- | --- |\n| one | two |"}
    </Markdown>,
  );
  expect(host.querySelectorAll("td")).toHaveLength(2);
  expect(host.querySelector("strong")).toBe(settled);
});

it("shows every code append immediately and preserves blocks when the turn settles", async () => {
  vi.useFakeTimers();
  const { host, render } = mount();
  const first = "# Gate\n\n```ts\nconst n = 1;";
  await render(<StreamingText text={first} />);
  const heading = host.querySelector("h1");
  const pre = host.querySelector("pre");
  expect(pre).not.toBeNull();
  expect(host.querySelector(".hljs-keyword")?.textContent).toBe("const");
  await render(<StreamingText text={`${first}\nconst next = 42;`} />);
  expect(host.querySelector("code")?.textContent).toBe("const n = 1;\nconst next = 42;");
  await act(async () => vi.advanceTimersByTime(50));
  expect(host.querySelectorAll(".hljs-number")[1]?.textContent).toBe("42");
  const complete = `${first}\nconst next = 42;\n\`\`\`\n\n**bold**`;
  await render(<StreamingText text={complete} />);
  const html = host.querySelector(".document-prose")?.innerHTML;
  await render(<StreamingText text={complete} streaming={false} />);
  expect(host.querySelector("h1")).toBe(heading);
  expect(host.querySelector("pre")).toBe(pre);
  expect(host.querySelector(".document-prose")?.innerHTML).toBe(html);
  expect(host.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
  await render(<StreamingText text={"```ts\nconst reset = 7;"} />);
  expect(host.querySelector("code")?.textContent).toBe("const reset = 7;");
});
