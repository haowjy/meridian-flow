/** Definition compilation contracts independent of provider/runtime support. */
import { describe, expect, it } from "vitest";
import { compileAgentDefinition } from "../domain/agent-definition-compiler.js";
import { normalizeAgentMeta } from "../domain/mars-source.js";

const compile = (meta: Record<string, unknown>, config?: Record<string, unknown>) => {
  const result = compileAgentDefinition({ body: "Review the chapter.\n", meta, config });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

describe("Agent definition compiler", () => {
  it("diagnoses reserved metadata keys rather than losing source content", () => {
    for (const meta of [
      JSON.parse('{"extension":{"__proto__":{"role":"admin"}}}'),
      JSON.parse('{"tools":{"__proto__":"deny"}}'),
      { tools: { __PROTO__: "deny" } },
    ]) {
      expect(compileAgentDefinition({ body: "", meta }).ok).toBe(false);
    }
  });

  it("retains a replacement grant when the same overlay clears baseline denials", () => {
    expect(
      compile(
        { tools: { write: "deny" } },
        {
          tools: { allowed: ["write"], disallowed: [] },
        },
      ).definition.metadata,
    ).toEqual({ tools: ["write"], "disallowed-tools": [] });
  });

  it("canonicalizes Mars tool and effort aliases before hashing", () => {
    expect(compile({ tools: { agent: "deny", task: "deny" } }).digest).toBe(
      compile({ tools: { agent: "deny" } }).digest,
    );
    expect(compile({ tools: ["Read", "Task"], effort: "max" }).digest).toBe(
      compile({ tools: ["read", "agent"], effort: "xhigh" }).digest,
    );
    expect(compileAgentDefinition({ body: "", meta: { tools: ["mcp(a/b/c)"] } }).ok).toBe(false);
    expect(compile({ tools: ["mcp(GitHub/CreateIssue)"] }).definition.metadata.tools).toEqual([
      "mcp(GitHub/CreateIssue)",
    ]);
  });

  it("rejects map-key collisions instead of changing policy with key order", () => {
    for (const tools of [
      { write: "allow", " write ": "deny" },
      { " write ": "deny", write: "allow" },
    ]) {
      expect(compileAgentDefinition({ body: "", meta: { tools } }).ok).toBe(false);
    }
  });

  it("rejects content that JSON hashing would erase or conflate", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [NaN, Infinity, undefined, new Date(), cyclic]) {
      expect(compileAgentDefinition({ body: "", meta: { extension: value } }).ok).toBe(false);
    }
  });

  it("diagnoses invalid routing values after source normalization", () => {
    const meta = normalizeAgentMeta({ model: 123, effort: "bogus" });
    expect(meta).toEqual({ model: 123, effort: "bogus" });
    expect(compileAgentDefinition({ body: "", meta }).ok).toBe(false);
    expect(compile(normalizeAgentMeta({ effort: "xhigh" })).definition.metadata.effort).toBe(
      "xhigh",
    );
  });
  it("normalizes skill lists and aliases without introducing defaults", () => {
    expect(compile({}).definition.metadata).toEqual({});
    expect(compile({ skills: [], model_invocable: false }).definition.metadata).toEqual({
      skills: { load: [] },
      "model-invocable": false,
    });
    expect(compile({ skills: { available: [] } }).definition.metadata).toEqual({
      skills: { available: [] },
    });
  });

  it("retains the body and unknown source metadata", () => {
    const meta = { description: "", attribution: { author: "A" } };
    const result = compile(meta);
    expect(result.definition.systemPrompt).toBe("Review the chapter.\n");
    expect(result.definition.metadata).toEqual(meta);
  });

  it("hashes canonical content, including presence and ordered lists", () => {
    expect(compile({ name: "critic", model: " model " }).digest).toBe(
      compile({ model: "model", name: "critic" }).digest,
    );
    expect(compile({ skills: ["a"] }).digest).toBe(compile({ skills: { load: ["a"] } }).digest);
    expect(compile({}).digest).not.toBe(compile({ subagents: [] }).digest);
    expect(compile({ subagents: ["a", "b"] }).digest).not.toBe(
      compile({ subagents: ["b", "a"] }).digest,
    );
  });

  it("applies Mars overlay replacement to the effective allowed and denied channels", () => {
    const result = compile(
      { model: "a", tools: { read: "allow", write: "deny" }, "disallowed-tools": ["spawn"] },
      { model: "b", tools: { allowed: ["search"], disallowed: [] } },
    );
    expect(result.definition.metadata).toEqual({
      model: "b",
      tools: ["grep"],
      "disallowed-tools": [],
    });
    expect(
      compile({ tools: ["read"] }, { tools: { allowed: [] } }).definition.metadata.tools,
    ).toEqual([]);
  });

  it.each([
    { effort: "maximum" },
    { model: "" },
    { skills: { load: [1] } },
    { tools: { write: "ask" } },
    { subagents: null },
    { approval: "yolo" },
    { autocompact: -1 },
    { autocompact_pct: 101 },
    { "user-invocable": "yes" },
    { model_invocable: true, "model-invocable": false },
  ])("returns explicit diagnostics for invalid configuration %j", (meta) => {
    const result = compileAgentDefinition({ body: "", meta });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("validates both layers instead of falling back on invalid overrides", () => {
    for (const [meta, config] of [
      [{ effort: "bogus" }, { effort: "high" }],
      [{ effort: "high" }, { effort: "bogus" }],
    ]) {
      expect(compileAgentDefinition({ body: "", meta, config }).ok).toBe(false);
    }
  });
});
