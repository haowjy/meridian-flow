/** Shared strict Project-chat keyset cursor contract. */
import { describe, expect, it } from "vitest";
import { decodeProjectChatCursor, encodeProjectChatCursor } from "./project-chat-cursor.js";

const key = {
  sortAt: "2026-08-13T20:01:02.123456Z",
  threadId: "00000000-0000-4000-8000-000000000103" as const,
};

describe("Project chat cursor", () => {
  it("round-trips the neutral key", () => {
    expect(decodeProjectChatCursor(encodeProjectChatCursor(key))).toEqual(key);
  });

  it.each([
    "not-json",
    "e30",
    `${encodeProjectChatCursor(key)}=`,
    `${encodeProjectChatCursor(key)}!`,
    ` ${encodeProjectChatCursor(key)}`,
    Buffer.from(
      JSON.stringify({ v: 1, a: "2026-02-30T20:01:02.123456Z", i: key.threadId }),
    ).toString("base64url"),
    Buffer.from(
      JSON.stringify({ v: 1, a: "2026-08-13T20:01:02.12345Z", i: key.threadId }),
    ).toString("base64url"),
    encodeProjectChatCursor({ ...key, sortAt: "0000-01-01T00:00:00.000000Z" }),
    Buffer.from(JSON.stringify({ v: 1, a: key.sortAt, i: "bad" })).toString("base64url"),
  ])("rejects malformed or PostgreSQL-incompatible value %s", (cursor) => {
    expect(() => decodeProjectChatCursor(cursor)).toThrow("Invalid Project chat cursor");
  });
});
