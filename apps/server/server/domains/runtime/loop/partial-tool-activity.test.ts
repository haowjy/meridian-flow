import { describe, expect, it } from "vitest";
import {
  hasPartialToolActivityTarget,
  parsePartialToolActivityInput,
  showsPartialToolActivityBeforeTarget,
} from "./partial-tool-activity.js";

describe("partial tool activity input", () => {
  it("keeps complete top-level label fields from a truncated write call", () => {
    const input = parsePartialToolActivityInput(
      "write",
      '{"command":"insert","path":"manuscript://story-b.md","content":"A long unfinished story',
    );

    expect(input).toEqual({ command: "insert", path: "manuscript://story-b.md" });
    expect(hasPartialToolActivityTarget("write", input)).toBe(true);
  });

  it("ignores nested, non-string, and unfinished string fields", () => {
    expect(
      parsePartialToolActivityInput(
        "spawn",
        '{"metadata":{"agent":"hidden"},"agent":42,"prompt":"text","agent":"still streaming',
      ),
    ).toBeNull();
    expect(
      parsePartialToolActivityInput("read", '{"path":"complete.md","metadata":{"path":"nested'),
    ).toEqual({ path: "complete.md" });
  });

  it("extracts search and spawn targets without traversing unrelated arguments", () => {
    const query = parsePartialToolActivityInput(
      "search",
      '{"query":"lantern","options":{"query":"nested"}',
    );
    const agent = parsePartialToolActivityInput("spawn", '{"agent":"Editor","prompt":"');

    expect(query).toEqual({ query: "lantern" });
    expect(hasPartialToolActivityTarget("search", query)).toBe(true);
    expect(agent).toEqual({ agent: "Editor" });
    expect(hasPartialToolActivityTarget("spawn", agent)).toBe(true);
  });

  it("returns only the known label fields and no target for null input", () => {
    expect(parsePartialToolActivityInput("write", '{"path":{},"content":"body"}')).toBeNull();
    expect(parsePartialToolActivityInput("write", '{"command":"undo","other":"ignored"}')).toEqual({
      command: "undo",
    });
    expect(hasPartialToolActivityTarget("write", null)).toBe(false);
    expect(parsePartialToolActivityInput("unknown", '{"path":"chapter.md"}')).toBeNull();
  });

  it("waits for a write's command before naming its target", () => {
    const pathOnly = parsePartialToolActivityInput("write", '{"path":"scratch://notes.md","comm');
    const read = parsePartialToolActivityInput(
      "write",
      '{"path":"scratch://notes.md","command":"read"',
    );

    expect(hasPartialToolActivityTarget("write", pathOnly)).toBe(false);
    expect(hasPartialToolActivityTarget("write", read)).toBe(true);
    expect(showsPartialToolActivityBeforeTarget("write")).toBe(false);
    expect(showsPartialToolActivityBeforeTarget("search")).toBe(true);
  });
});
