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
      { tools: ["__proto__"] },
      { tools: ["__PROTO__"] },
    ]) {
      expect(compileAgentDefinition({ body: "", meta }).ok).toBe(false);
    }
  });

  it("canonicalizes Mars tool and effort aliases before hashing", () => {
    expect(compile({ "disallowed-tools": ["agent", "task"] }).digest).toBe(
      compile({ "disallowed-tools": ["agent"] }).digest,
    );
    expect(compile({ tools: ["Task"], effort: "max" }).digest).toBe(
      compile({ tools: ["agent"], effort: "xhigh" }).digest,
    );
    expect(compileAgentDefinition({ body: "", meta: { tools: ["mcp(a/b/c)"] } }).ok).toBe(false);
    expect(compile({ tools: ["mcp(GitHub/CreateIssue)"] }).definition.metadata.tools).toEqual([
      "mcp(GitHub/CreateIssue)",
    ]);
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
  it("compiles permission as read or edit, leaves it unset by default and names the allowed values", () => {
    expect(compile({ permission: "read" }).definition.metadata.permission).toBe("read");
    // Resolution, not the compiler, applies the `edit` default (agent-configuration).
    expect(compile({}).definition.metadata).not.toHaveProperty("permission");
    expect(compileAgentDefinition({ body: "", meta: { permission: "write" } })).toEqual({
      ok: false,
      diagnostics: [
        { field: "meta.permission", message: 'Expected "read" or "edit", got "write"' },
      ],
    });
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
      { model: "a", tools: ["read"], "disallowed-tools": ["spawn"] },
      { model: "b", tools: { allowed: ["search"], disallowed: [] } },
    );
    expect(result.definition.metadata).toEqual({
      model: "b",
      tools: ["search"],
      "disallowed-tools": [],
    });
  });

  it.each([
    { effort: "maximum" },
    { model: "" },
    { skills: { load: [1] } },
    { tools: { edit: "ask" } },
    { subagents: null },
    { approval: "yolo" },
    { autocompact: 0 },
    { autocompact: -1 },
    { autocompact_pct: 101 },
    { "user-invocable": "yes" },
    { model_invocable: true, "model-invocable": false },
  ])("returns explicit diagnostics for invalid configuration %j", (meta) => {
    const result = compileAgentDefinition({ body: "", meta });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("accepts read and write and rejects edit and the tool map, naming the replacement", () => {
    expect(
      compile({ tools: ["read", "write"], "disallowed-tools": ["Write"] }).definition.metadata,
    ).toEqual({ tools: ["read", "write"], "disallowed-tools": ["write"] });
    const diagnostics = (meta: Record<string, unknown>) => {
      const result = compileAgentDefinition({ body: "", meta });
      return result.ok ? [] : result.diagnostics.map(({ message }) => message);
    };
    for (const meta of [
      { tools: ["edit"] },
      { tools: ["Edit(x)"] },
      { tools: ["file_write"] },
      { "disallowed-tools": ["apply_patch"] },
    ]) {
      expect(diagnostics(meta), JSON.stringify(meta)).toEqual([
        '"edit" is not a tool. Use "permission: read" or "permission: edit" for what the agent may change, and the "write" tool for documents.',
      ]);
    }
    expect(diagnostics({ tools: { edit: "deny", ask_user: "allow" } })).toEqual([
      "Expected a list of tool names, e.g. [read, write]; deny tools with disallowed-tools.",
    ]);
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
