/** Source fidelity contracts for Agent inheritance and immutable revision checksums. */
import { describe, expect, it } from "vitest";
import {
  canonicalizeJsonObject,
  normalizeAgentMeta,
  parseMarkdownDefinition,
  parseMarsToml,
  serializeMarkdownDefinition,
} from "../domain/mars-source.js";

describe("Agent source fidelity", () => {
  it("canonicalizes prototype-shaped source keys as own data", () => {
    const meta = JSON.parse('{"extension":{"__proto__":{"role":"admin"}}}');
    const canonical = canonicalizeJsonObject(meta);
    expect(JSON.stringify(canonical)).toBe(JSON.stringify(meta));
    expect(Object.getPrototypeOf(canonical.extension)).toBe(Object.prototype);
  });

  it("preserves authored leading newlines through serialization", () => {
    const body = "\nReview.\n";
    expect(parseMarkdownDefinition(serializeMarkdownDefinition({}, body)).body).toBe(body);
  });
  it.each([
    "agents = 5",
    "[agents]\nx = false",
  ])("rejects malformed Agent overlay tables %s", (toml) => {
    expect(() => parseMarsToml(toml, { packageNameFallback: "pkg" })).toThrow("table");
  });

  it("round-trips structured skill channels without merging them", () => {
    const meta = {
      name: "critic",
      skills: { load: ["voice"], available: ["continuity"] },
      tools: ["read", "write"],
      "disallowed-tools": ["spawn"],
      subagents: [],
    };
    const body = "Review the chapter.\n";
    const parsed = parseMarkdownDefinition(serializeMarkdownDefinition(meta, body));
    expect(normalizeAgentMeta(parsed.meta)).toEqual(meta);
    expect(parsed.body).toBe(body);
  });
});
