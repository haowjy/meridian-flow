/** Characterize the original clipboard pipeline before its renderer migration. */
import type { Block } from "@meridian/contracts/protocol";
import type { AssistantView } from "@meridian/thread-client";
import { describe, expect, it } from "vitest";
import { assistantTurnCopyHtml, assistantTurnCopyMarkdown } from "./assistant-turn-copy";

const samples = {
  paragraphs: "First paragraph.\n\nSecond **paragraph**.",
  lists: "- first\n- second\n\n1. one\n2. two",
  code: "```ts\nconst answer = 42;\n```",
  table: "| A | B |\n| --- | --- |\n| one | two |",
  link: "[website](https://example.com)",
  reference: "[Chapter one](manuscript://chapter-one.md)",
  skill: "Use /outline now.",
  mermaid: "```mermaid\ngraph TD\nA --> B\n```",
};

describe("assistant clipboard contract", () => {
  for (const [name, markdown] of Object.entries(samples)) {
    it(name, () => {
      const block = { textContent: markdown } as Block;
      const view: AssistantView = {
        blocks: [block],
        items: [{ kind: "text", block, text: markdown }],
        finalFrom: 0,
        hiddenToolCallIds: [],
        workReceipts: [],
      };
      expect(assistantTurnCopyMarkdown(view)).toBe(markdown);
      expect(assistantTurnCopyHtml(markdown)).toMatchSnapshot();
    });
  }
});
