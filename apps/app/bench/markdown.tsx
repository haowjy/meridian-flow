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
const storyFragments = [
  "The ward stones answered one after another, turning the mountain path into a chain of pale green stars.",
  "At the pavilion, the quartermaster compared the damaged seal with the copy hidden in the sect ledger.",
  "Rain softened the training yard while the disciples argued about who had moved first and who had merely reacted.",
  "Beyond the eastern wall, a spirit crane circled twice before dropping a narrow letter tied with silver thread.",
  "The formation master erased one line of chalk, then asked everyone to reconsider what the diagram assumed.",
  "No one mentioned the missing sword, but every answer bent around the empty place where it should have rested.",
  "By dusk, the market lanterns reflected in the canal and made even ordinary bargains look like secret rites.",
  "The healer counted three steady breaths, loosened the bandage, and waited for the hidden meridian to reveal itself.",
  "A rumor from the northern pass arrived with exact names, impossible dates, and one detail only an eyewitness knew.",
  "Inside the archive, dust covered the recent shelves while the oldest bamboo slips looked freshly handled.",
  "The junior scribe recorded each contradiction without resolving it, trusting the pattern to emerge on a second reading.",
  "When the bell sounded, the elders ended the debate but left the final seat conspicuously unclaimed.",
] as const;

const wordCount = (value: string) => value.trim().split(/\s+/).filter(Boolean).length;
const distinctTranscript = Array.from({ length: 50 }, (_, index) => {
  const targetWords = 100 + ((index * 337) % 1_371);
  const title = ["Ash Gate", "Jade Ledger", "Silent Peak", "River Oath", "Glass Province"][
    index % 5
  ];
  const protagonist = ["Mei", "Rin", "Tao", "Sera", "Jun"][index % 5];
  const parts = [
    `## ${title}: scene ${index + 1}`,
    `The scene follows ${protagonist} after the ${["trial", "ambush", "council", "duel", "pilgrimage"][index % 5]}.`,
    `> The witness remembers detail ${index + 3}, but not the promise made before it.`,
  ];
  let beat = 0;
  while (wordCount(parts.join("\n\n")) < targetWords - 35) {
    const fragment = storyFragments[(index * 5 + beat * 7) % storyFragments.length];
    const reading = ["a warning", "an invitation", "a feint", "a debt", "a test"][
      (index + beat) % 5
    ];
    parts.push(
      `${fragment} ${protagonist} read moment ${beat + 1} as ${reading}, which changed the next choice in scene ${index + 1}.`,
    );
    beat++;
  }
  parts.push(
    `- Recheck clue ${index + 1}\n- Follow the ${["river", "ridge", "caravan", "messenger"][index % 4]}\n- Keep the cost visible`,
    `\`\`\`ts\nconst scene = { chapter: ${index + 1}, revision: ${beat} };\n\`\`\``,
    `| Thread | Status |\n| --- | --- |\n| ${title} | ${index % 2 ? "open" : "turning"} |`,
  );
  return parts.join("\n\n");
});
const distinctTranscriptWordCounts = distinctTranscript.map(wordCount);
const stats = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
  };
};

function waitForPaint(host: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      observer.disconnect();
      requestAnimationFrame(() => resolve());
    });
    observer.observe(host, { childList: true, characterData: true, subtree: true });
  });
}

export async function runMarkdownBench(interval: number, mountsOnly = false) {
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
  for (const token of mountsOnly ? [] : tokens) {
    const arrived = performance.now();
    source += token;
    updates.push(commit([source], true));
    await waitForPaint(host);
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
  const worstCaseTokenUpdateMs = mountsOnly
    ? null
    : {
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
    distinctTranscriptMessages: distinctTranscript.length,
    distinctTranscriptWords: {
      min: Math.min(...distinctTranscriptWordCounts),
      max: Math.max(...distinctTranscriptWordCounts),
    },
    distinctTranscriptMountMs: mounts(distinctTranscript),
    longReplyMountMs: mounts([long]),
  };
  root.unmount();
  return result;
}
Object.assign(window, { runMarkdownBench });
