/** The real Markdown component under production React; timing includes layout. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Markdown } from "../src/rich-content/Markdown";
import "../src/styles/globals.css";

i18n.load("en", {});
i18n.activate("en");
const paragraph =
  "The cultivator crossed the silent courtyard and considered the price of power. ".repeat(8);
const section = `## The gate\n\n${paragraph}\n\n- First step\n- Second step\n\n\`\`\`ts\nconst gate = { open: true };\nconsole.log(gate);\n\`\`\`\n\n| Rank | Cost |\n| --- | --- |\n| Jade | 42 |\n\n`;
const long = section.repeat(Math.ceil(5000 / section.split(/\s+/).length));
const tokens = long.match(/\S+\s*/g) ?? [];
const transcript = Array.from(
  { length: 50 },
  (_, index) => `${index % 2 ? "Reply" : "Question"} ${index}\n\n${section}`,
);
const stats = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
  };
};

function waitForPaint(host: HTMLElement, sourceLength: number): Promise<void> {
  return new Promise((resolve) => {
    const inspect = () => {
      const rendered = host.querySelector<HTMLElement>("[data-markdown-source-length]");
      if (Number(rendered?.dataset.markdownSourceLength) === sourceLength) {
        requestAnimationFrame(() => resolve());
      } else {
        requestAnimationFrame(inspect);
      }
    };
    requestAnimationFrame(inspect);
  });
}

export async function runMarkdownBench(interval: number) {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing bench root");
  let root = createRoot(host);
  const commit = (sources: string[], streaming = false) => {
    const start = performance.now();
    flushSync(() =>
      root.render(
        <I18nProvider i18n={i18n}>
          {sources.map((source, index) =>
            streaming ? (
              <Markdown key={index} mode="streaming" streamId={`bench:${index}`}>
                {source}
              </Markdown>
            ) : (
              <Markdown key={index}>{source}</Markdown>
            ),
          )}
        </I18nProvider>,
      ),
    );
    host.getBoundingClientRect();
    return performance.now() - start;
  };
  commit([section]);
  flushSync(() => root.render(null));
  const updates: number[] = [];
  const arrivalToPaint: number[] = [];
  let source = "";
  for (const token of tokens) {
    const arrived = performance.now();
    source += token;
    updates.push(commit([source], true));
    await waitForPaint(host, source.length);
    arrivalToPaint.push(performance.now() - arrived);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, interval - (performance.now() - arrived))),
    );
  }
  const streamUpdates = async (chunks: readonly string[], initial = "") => {
    const samples: number[] = [];
    let current = initial;
    for (const chunk of chunks) {
      const start = performance.now();
      current += chunk;
      samples.push(commit([current], true));
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, interval - (performance.now() - start))),
      );
    }
    return stats(samples);
  };
  const worstCaseTokenUpdateMs = {
    paragraph: await streamUpdates(Array.from({ length: 300 }, (_, index) => `word${index} `)),
    list: await streamUpdates(Array.from({ length: 300 }, (_, index) => `- item ${index}\n`)),
    openCode: await streamUpdates(
      Array.from({ length: 300 }, (_, index) => `value${index} `),
      "```ts\n",
    ),
  };
  const mounts = (sources: string[]) => {
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      root.unmount();
      root = createRoot(host);
      samples.push(commit(sources));
    }
    return { first: samples[0], ...stats(samples) };
  };
  const result = {
    tokens: tokens.length,
    words: long.split(/\s+/).length,
    tokenUpdateMs: stats(updates),
    arrivalToPaintMs: stats(arrivalToPaint),
    textBlockCharacters: long.length,
    worstCaseTokenUpdateMs,
    transcriptMountMs: mounts(transcript),
    longReplyMountMs: mounts([long]),
  };
  root.unmount();
  return result;
}
Object.assign(window, { runMarkdownBench });
