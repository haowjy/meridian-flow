// @vitest-environment jsdom
/** Streaming contracts: visible tails, code boundaries and settlement identity. */
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { StreamingText } from "@/features/chat/StreamingText";
import { Markdown } from "./Markdown";

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

it("repairs only the live tail without inventing links or tables", async () => {
  const { host, render } = mount();
  await render(
    <Markdown mode="streaming" streamId="test-stream">
      {"**finished**\n\n**bol"}
    </Markdown>,
  );
  expect(host.querySelectorAll("strong")[1]?.textContent).toBe("bol");
  const settled = host.querySelector("strong");
  await render(
    <Markdown mode="streaming" streamId="test-stream">
      {"**finished**\n\n[half](https://exam"}
    </Markdown>,
  );
  expect(host.querySelector("strong")).toBe(settled);
  expect(host.querySelector("a")).toBeNull();
  await render(
    <Markdown mode="streaming" streamId="test-stream">
      {"**finished**\n\n| A | B |"}
    </Markdown>,
  );
  expect(host.querySelector("table")).toBeNull();
  await render(
    <Markdown mode="streaming" streamId="test-stream">
      {"**finished**\n\n| A | B |\n| --- | --- |\n| one | two |"}
    </Markdown>,
  );
  expect(host.querySelectorAll("td")).toHaveLength(2);
  expect(host.querySelector("strong")).toBe(settled);
});

it("never repairs Markdown inside an open fence of either marker", async () => {
  const { host, render } = mount();
  for (const source of [
    "~~~txt\n*literal",
    "```txt\n*literal",
    "- item\n\n  ~~~\n  *literal",
    "> ~~~\n> *literal",
  ]) {
    await render(
      <Markdown mode="streaming" streamId="test-stream">
        {source}
      </Markdown>,
    );
    expect(host.querySelector("code")?.textContent).toBe("*literal");
  }
});

it("shows every code append immediately and preserves blocks when the turn settles", async () => {
  vi.useFakeTimers();
  const { host, render } = mount();
  const first = "# Gate\n\n```ts\nconst n = 1;";
  await render(<StreamingText streamId="test-stream" text={first} />);
  const heading = host.querySelector("h1");
  const pre = host.querySelector("pre");
  expect(pre).not.toBeNull();
  expect(host.querySelector(".hljs-keyword")?.textContent).toBe("const");
  await render(<StreamingText streamId="test-stream" text={`${first}\nconst next = 42;`} />);
  expect(host.querySelector("code")?.textContent).toBe("const n = 1;\nconst next = 42;");
  await act(async () => vi.advanceTimersByTime(50));
  expect(host.querySelectorAll(".hljs-number")[1]?.textContent).toBe("42");
  const complete = `${first}\nconst next = 42;\n\`\`\`\n\n**bold**`;
  await render(<StreamingText streamId="test-stream" text={complete} />);
  const html = host.querySelector(".document-prose")?.innerHTML;
  await render(<StreamingText streamId="test-stream" text={complete} streaming={false} />);
  expect(host.querySelector("h1")).toBe(heading);
  expect(host.querySelector("pre")).toBe(pre);
  expect(host.querySelector(".document-prose")?.innerHTML).toBe(html);
  expect(host.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
  await render(<StreamingText streamId="test-stream" text={"```ts\nconst reset = 7;"} />);
  expect(host.querySelector("code")?.textContent).toBe("const reset = 7;");
});
