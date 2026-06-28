import { describe, expect, it } from "vitest";

import { parseToolCallArguments } from "./parse-tool-arguments.js";

describe("parseToolCallArguments", () => {
  it("returns a valid JSON object unchanged", () => {
    expect(parseToolCallArguments('{"path":"manuscript://chapter-1.md","command":"read"}')).toEqual(
      {
        ok: true,
        arguments: {
          path: "manuscript://chapter-1.md",
          command: "read",
        },
      },
    );
  });

  it("repairs the bare unquoted hash emitted as a tool argument", () => {
    const parsed = parseToolCallArguments(
      '{"path":"manuscript://chapter-1.md","in": 6c4a,"command":"read"}',
    );

    expect(parsed).toEqual({
      ok: true,
      arguments: {
        path: "manuscript://chapter-1.md",
        in: "6c4a",
        command: "read",
      },
    });
    expect(parsed.ok && parsed.arguments.in).toBe("6c4a");
  });

  it("repairs trailing commas and single-quoted object strings", () => {
    expect(
      parseToolCallArguments("{'path':'manuscript://chapter-1.md','command':'read',}"),
    ).toEqual({
      ok: true,
      arguments: {
        path: "manuscript://chapter-1.md",
        command: "read",
      },
    });
  });

  it("returns a typed parse error for genuinely unparseable garbage", () => {
    const parsed = parseToolCallArguments('{"a": function(){}}');

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.raw).toBe('{"a": function(){}}');
      expect(parsed.message).toBeTruthy();
    }
  });

  it.each([undefined, ""])("returns an empty object for empty input %s", (raw) => {
    expect(parseToolCallArguments(raw)).toEqual({ ok: true, arguments: {} });
  });
});
