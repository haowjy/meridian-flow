/** One tool call as history writes it (D48): exact lines from fixed typed inputs. */
import { describe, expect, it } from "vitest";
import { CALL_LINE_CAP, callLine, shortenCallArgs } from "./history-call-line.js";

const words = (count: number, word = "word") => Array.from({ length: count }, () => word).join(" ");

describe("shortenCallArgs", () => {
  it("keeps short arguments exactly as sent, in their key order", () => {
    const args = { path: "manuscript://chapter-11.md", format: "outline", in: [3, 5] };
    expect(shortenCallArgs("read", args)).toEqual(args);
    expect(Object.keys(shortenCallArgs("read", { format: "outline", path: "a.md" }))).toEqual([
      "format",
      "path",
    ]);
  });

  it("cuts a long string inside the JSON to a prefix at a word break and a size note", () => {
    const content = `The moon was low over the ridge when ${words(205)}`;
    expect(shortenCallArgs("write", { command: "replace", path: "ch3.md", content })).toEqual({
      command: "replace",
      path: "ch3.md",
      content: "The moon was low over the ridge when…(213 words)",
    });
  });

  it("leaves a string up to 60 characters whole", () => {
    const sixty = "x".repeat(60);
    expect(shortenCallArgs("read", { path: sixty })).toEqual({ path: sixty });
    expect(shortenCallArgs("read", { path: `${sixty}y` })).toEqual({
      path: `${"x".repeat(40)}…(61 chars)`,
    });
  });

  it("shortens nested strings in objects and arrays", () => {
    expect(
      shortenCallArgs("spawn", {
        agent: "critic",
        files: [{ path: "a.md", note: words(30, "note") }],
        options: { prompt: words(50, "go") },
      }),
    ).toEqual({
      agent: "critic",
      files: [{ path: "a.md", note: "note note note note note note note note…(30 words)" }],
      options: { prompt: "go go go go go go go go go go go go go…(50 words)" },
    });
  });

  it("shortens further rather than dropping keys when a call is over the line cap", () => {
    const args = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`field${i}`, words(40, "long")]),
    );
    const shortened = shortenCallArgs("work", args);
    expect(Object.keys(shortened)).toEqual(Object.keys(args));
    expect(`work(${JSON.stringify(shortened)})`.length).toBeLessThanOrEqual(CALL_LINE_CAP);
    expect(shortened.field0).toBe("…(40 words)");
  });

  it("keeps a 16-character prefix when that is enough to fit the cap", () => {
    const args = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`f${i}`, words(40, "long")]),
    );
    expect(shortenCallArgs("work", args).f0).toBe("long long long…(40 words)");
  });
});

describe("callLine", () => {
  it("writes the call, then the summary after an arrow", () => {
    expect(
      callLine({
        tool: "read",
        args: { path: "manuscript://chapter-11.md", format: "outline" },
        state: "done",
        summary: "5 of 62 blocks",
      }),
    ).toBe('read({"path":"manuscript://chapter-11.md","format":"outline"}) → 5 of 62 blocks');
  });

  it("omits the arrow when there is nothing to say", () => {
    expect(callLine({ tool: "ls", args: {}, state: "done" })).toBe("ls({})");
  });

  it("writes failures with their status or code, and running and cancelled calls", () => {
    const args = { path: "skill://story-review/resources/developmental-edit.md" };
    expect(callLine({ tool: "read", args, state: "error", summary: "document_not_found" })).toBe(
      'read({"path":"skill://story-review/resources/developmental-edit.md"}) → failed: document_not_found',
    );
    expect(callLine({ tool: "read", args, state: "error" })).toBe(
      'read({"path":"skill://story-review/resources/developmental-edit.md"}) → failed',
    );
    expect(callLine({ tool: "spawn", args: { agent: "critic" }, state: "running" })).toBe(
      'spawn({"agent":"critic"}) → running',
    );
    expect(callLine({ tool: "spawn", args: { agent: "critic" }, state: "cancelled" })).toBe(
      'spawn({"agent":"critic"}) → cancelled',
    );
  });

  it("writes withheld arguments as an ellipsis", () => {
    expect(callLine({ tool: "return_result", args: null, state: "done" })).toBe("return_result(…)");
  });
});
