/**
 * The digest is the collapsed fold's only label, and its counts must match what
 * expanding the fold shows. Cross-spelling dedup is where an off-by-one makes
 * the label lie ("Explored 5 documents" over 4 real ones) without looking wrong.
 */

import { describe, expect, it, vi } from "vitest";
import type { ToolView } from "./group-delivery-segments";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((copy, part, index) => copy + part + (values[index] ?? ""), ""),
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));

vi.mock("@/features/project/context/context-schemes", () => ({
  schemeLabel: (scheme: string) =>
    ({ kb: "Knowledge Base", scratch: "Scratch", uploads: "Uploads", user: "User" })[scheme] ??
    "Manuscript",
}));

import { thinkingDigest } from "./thinking-digest";

function tool(toolName: string, input: ToolView["input"]): ToolView {
  return {
    toolCallId: `call-${toolName}`,
    toolName,
    input,
    output: null,
    status: "complete",
    isError: false,
    message: null,
    streamedOutput: null,
    keyBlock: {} as ToolView["keyBlock"],
  };
}

describe("thinkingDigest", () => {
  it.each([
    ["read", "Explored 1 document"],
    ["replace", "Edited Chapter 1"],
  ])("counts canonical %s targets once across path spellings", (command, expected) => {
    expect(
      thinkingDigest(
        [
          tool("write", { command, path: "/chapters/Chapter 1.md" }),
          tool("write", { command, path: "chapters//Chapter 1.md" }),
          tool("write", { command, path: "manuscript://chapters/./Chapter 1.md" }),
        ],
        "direct",
      ),
    ).toBe(expected);
  });
});
