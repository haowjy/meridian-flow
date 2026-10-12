/** Definition compilation contracts independent of provider/runtime support. */
import { describe, expect, it } from "vitest";
import { compileAgentDefinition } from "../domain/agent-definition-compiler.js";

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

  it("accepts read and write, rejects edit in tools and the tool map, and ignores a denied edit", () => {
    expect(
      compile({ tools: ["read", "write"], "disallowed-tools": ["Write", "apply_patch"] }).definition
        .metadata,
    ).toEqual({ tools: ["read", "write"], "disallowed-tools": ["write", "edit"] });
    const diagnostics = (meta: Record<string, unknown>) => {
      const result = compileAgentDefinition({ body: "", meta });
      return result.ok ? [] : result.diagnostics.map(({ message }) => message);
    };
    for (const meta of [{ tools: ["edit"] }, { tools: ["Edit(x)"] }, { tools: ["file_write"] }]) {
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
