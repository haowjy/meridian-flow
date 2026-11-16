/** A writer's token is sealed under MCP_TOKEN_KEY and opens only with the same key, connection and account. */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTokenCipher, parseTokenKey } from "./token-cipher.js";

describe("token cipher", () => {
  const owner = { connectionId: "c1", accountId: "a1" };
  const cipher = createTokenCipher(randomBytes(32));

  it("round-trips a token and never stores it in the clear", () => {
    const sealed = cipher.seal("ghp_secret", owner);
    expect(sealed).not.toContain("ghp_secret");
    expect(cipher.open(sealed, owner)).toBe("ghp_secret");
    expect(cipher.seal("ghp_secret", owner)).not.toBe(sealed);
  });

  it("refuses the wrong key, another owner and a changed value", () => {
    const sealed = cipher.seal("ghp_secret", owner);
    expect(() => createTokenCipher(randomBytes(32)).open(sealed, owner)).toThrow();
    expect(() => cipher.open(sealed, { ...owner, accountId: "a2" })).toThrow();
    expect(() => cipher.open(`${sealed.slice(0, -2)}AA`, owner)).toThrow();
  });

  it("accepts only a 32 byte base64 key", () => {
    expect(() => parseTokenKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
    expect(parseTokenKey(randomBytes(32).toString("base64"))).toHaveLength(32);
  });
});
