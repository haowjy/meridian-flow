/** Source fidelity contracts for Agent inheritance and immutable revision checksums. */
import { describe, expect, it } from "vitest";
import {
  agentDefinitionContentChecksum,
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

  it.each(["false", "123", "agent", "- writer"])("rejects non-mapping frontmatter %s", (yaml) => {
    expect(() => parseMarkdownDefinition(`---\n${yaml}\n---\nPrompt`)).toThrow("mapping");
  });

  it("retains omission separately from explicit empty configuration", () => {
    expect(normalizeAgentMeta({ name: "generic" })).toEqual({ name: "generic" });
    const empty = { tools: [], subagents: [], skills: {}, mode: "subagent" };
    expect(normalizeAgentMeta(empty)).toEqual(empty);
  });

  it("round-trips structured skill channels without merging them", () => {
    const meta = {
      name: "critic",
      skills: { load: ["voice"], available: ["continuity"] },
      tools: { allowed: [], denied: ["edit"] },
      subagents: [],
    };
    const body = "Review the chapter.\n";
    const parsed = parseMarkdownDefinition(serializeMarkdownDefinition(meta, body));
    expect(normalizeAgentMeta(parsed.meta)).toEqual(meta);
    expect(parsed.body).toBe(body);
  });

  it("retains flat skill lists and explicit empty channels", () => {
    for (const skills of [[], ["voice"], { load: [] }, { available: [] }]) {
      expect(normalizeAgentMeta({ skills })).toEqual({ skills });
    }
  });

  it("hashes key order canonically while distinguishing omission and clearing", () => {
    const checksum = (meta: Record<string, unknown>) =>
      agentDefinitionContentChecksum({ body: "Review.", meta: normalizeAgentMeta(meta) });
    expect(checksum({ skills: { load: [], available: ["voice"] }, name: "critic" })).toBe(
      checksum({ name: "critic", skills: { available: ["voice"], load: [] } }),
    );
    expect(checksum({})).not.toBe(checksum({ skills: [] }));
    expect(checksum({})).not.toBe(checksum({ subagents: [] }));
  });
});
