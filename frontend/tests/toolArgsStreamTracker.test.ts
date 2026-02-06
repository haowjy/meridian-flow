import { describe, it, expect } from "vitest";
import { ToolArgsStreamTracker } from "@/features/threads/utils/toolArgsStreamTracker";

describe("ToolArgsStreamTracker", () => {
  it("infers active top-level string arg and updates previews incrementally", () => {
    const t = new ToolArgsStreamTracker({ previewChars: 8 });

    t.append('{"path":"/x","content":"');
    let s = t.snapshot();
    expect(s.activeArgKey).toBe("content");
    expect(s.activeArgChars).toBe(0);

    t.append("deep");
    s = t.snapshot();
    expect(s.activeArgKey).toBe("content");
    expect(s.activeArgChars).toBe(4);
    expect(s.previewHead).toBe("deep");
    expect(s.previewTail).toBe("deep");

    t.append(" sea");
    s = t.snapshot();
    expect(s.activeArgKey).toBe("content");
    expect(s.activeArgChars).toBe(8);
    expect(s.previewHead).toBe("deep sea");
    expect(s.previewTail).toBe("deep sea");

    // Close the string value
    t.append('"}');
    s = t.snapshot();
    expect(s.activeArgKey).toBe(null);
    expect(s.activeArgChars).toBe(8);
  });

  it("handles escaped quotes inside the active string", () => {
    const t = new ToolArgsStreamTracker({ previewChars: 32 });

    // JSON fragment contains an escaped quote (\") inside the string value.
    t.append('{"content":"hello ' + '\\"');
    let s = t.snapshot();
    expect(s.activeArgKey).toBe("content");

    t.append('world"}');
    s = t.snapshot();
    expect(s.activeArgKey).toBe(null);
    expect(s.previewHead.includes("hello")).toBe(true);
  });
});
