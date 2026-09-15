/** Source fidelity contracts for Agent inheritance and immutable revision checksums. */
import { describe, expect, it } from "vitest";
import {
  agentDefinitionContentChecksum,
  normalizeAgentMeta,
  parseMarkdownDefinition,
  serializeMarkdownDefinition,
} from "../domain/mars-source.js";

describe("Agent source fidelity", () => {
  it("retains omission separately from explicit empty configuration", () => {
    expect(normalizeAgentMeta({ name: "generic" })).toEqual({ name: "generic" });
    const empty = { tools: [], subagents: [], skills: {}, mode: "subagent" };
    expect(normalizeAgentMeta(empty)).toEqual(empty);
  });

  it("round-trips structured skill channels without merging them", () => {
    const meta = {
      name: "critic",
      skills: { load: ["voice"], available: ["continuity"] },
      tools: { allowed: [], denied: ["write"] },
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
