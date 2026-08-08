/**
 * The digest is the collapsed fold's only label, and its counts must match what
 * expanding the fold shows. Cross-spelling dedup is where an off-by-one makes
 * the label lie ("Read 5 documents" over 4 real ones) without looking wrong.
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
    metadata: null,
    keyBlock: {} as ToolView["keyBlock"],
  };
}

describe("thinkingDigest", () => {
  it.each([
    ["read", "Read 1 document"],
    ["replace", "Edited 1 document"],
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

  it("only reports counted read and edit outcomes", () => {
    const error = { ...tool("write", { command: "read" }), isError: true };

    expect(
      thinkingDigest(
        [
          tool("write", { command: "read", path: "manuscript://chapter-1" }),
          tool("write", { command: "replace", path: "manuscript://chapter-2" }),
          tool("search", { pattern: "dragon" }),
          tool("search", { query: "dragon" }),
          error,
        ],
        "draft",
      ),
    ).toBe("Read 1 document, drafted 1");
    expect(thinkingDigest([tool("search", { query: "dragon" }), error], "direct")).toBeNull();
  });
});
