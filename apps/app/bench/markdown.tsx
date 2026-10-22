/** The real Markdown component under production React; timing includes layout. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { type MarkdownStreamSnapshot, markdownCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Markdown } from "../src/rich-content/Markdown";
import "../src/styles/globals.css";

i18n.load("en", {});
i18n.activate("en");
const paragraph =
  "The cultivator crossed the silent courtyard and considered the price of power. ".repeat(8);
const section = `## The gate\n\n${paragraph}\n\n- First step\n- Second step\n\n\`\`\`ts\nconst gate = { open: true };\nconsole.log(gate);\n\`\`\`\n\n| Rank | Cost |\n| --- | --- |\n| Jade | 42 |\n\n`;
const tokens = (section.repeat(60).match(/\S+\s*/g) ?? []).slice(0, 4000);
const long = section.repeat(Math.ceil(5000 / section.split(/\s+/).length));
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
const diagnosticCodec = markdownCodec({ schema: buildDocumentSchema() });
const fullParseFallbacks = (chunks: readonly string[], initial = "") => {
  let source = initial;
  let snapshot: MarkdownStreamSnapshot | null = null;
  const reasons: Record<string, number> = {};
  for (const chunk of chunks) {
    source += chunk;
    snapshot = diagnosticCodec.stream(snapshot, source);
    if (snapshot.fullParseReason) {
      reasons[snapshot.fullParseReason] = (reasons[snapshot.fullParseReason] ?? 0) + 1;
    }
  }
  return reasons;
};
export async function runMarkdownBench(interval: number) {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing bench root");
  let root = createRoot(host);
  const commit = (sources: string[], streaming = false) => {
    const start = performance.now();
    flushSync(() =>
      root.render(
        <I18nProvider i18n={i18n}>
          {sources.map((source, index) => (
            <Markdown key={index} mode={streaming ? "streaming" : "static"}>
              {source}
            </Markdown>
          ))}
        </I18nProvider>,
      ),
    );
    host.getBoundingClientRect();
    return performance.now() - start;
  };
  commit([section]);
  flushSync(() => root.render(null));
  const updates: number[] = [];
  let source = "";
  for (const token of tokens) {
    const start = performance.now();
    source += token;
    updates.push(commit([source], true));
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, interval - (performance.now() - start))),
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
    worstCaseTokenUpdateMs,
    fullParseFallbacks: {
      ordinary: fullParseFallbacks(tokens),
      paragraph: fullParseFallbacks(Array.from({ length: 300 }, (_, index) => `word${index} `)),
      list: fullParseFallbacks(Array.from({ length: 300 }, (_, index) => `- item ${index}\n`)),
      openCode: fullParseFallbacks(
        Array.from({ length: 300 }, (_, index) => `value${index} `),
        "```ts\n",
      ),
    },
    transcriptMountMs: mounts(transcript),
    longReplyMountMs: mounts([long]),
  };
  root.unmount();
  return result;
}
Object.assign(window, { runMarkdownBench });
