// @vitest-environment jsdom
/**
 * A writer's line break surviving the markdown pipeline.
 *
 * The composer serializes Shift+Enter as `\n`, and commonmark reads a lone
 * `\n` as a soft break — a space. `breaks` is the transcript's way of keeping
 * the keystroke visible (G1 probe: sent-turn hard breaks collapsed); default
 * markdown keeps commonmark's reading, because assistant prose wrapped by the
 * model is not a stack of deliberate breaks.
 */
import { describe, expect, it } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";

import { Markdown } from "./Markdown";

const paragraphs = () => [...document.querySelectorAll("p")];

describe("newlines in a sent message", () => {
  it("renders the composer's hard break as a visible line break", async () => {
    await withReactRoot(<Markdown breaks>{"first line\nsecond line"}</Markdown>, async () => {
      const [paragraph] = paragraphs();
      expect(paragraph?.querySelector("br")).not.toBeNull();
      expect(paragraph?.textContent).toContain("first line");
      expect(paragraph?.textContent).toContain("second line");
    });
  });

  it("still splits a blank line into paragraphs, not a run of breaks", async () => {
    await withReactRoot(<Markdown breaks>{"first\n\nsecond"}</Markdown>, async () => {
      expect(paragraphs()).toHaveLength(2);
      expect(document.querySelector("br")).toBeNull();
    });
  });

  it("leaves assistant markdown alone: a soft break stays a space by default", async () => {
    await withReactRoot(<Markdown>{"wrapped\nby the model"}</Markdown>, async () => {
      expect(document.querySelector("br")).toBeNull();
    });
  });
});
