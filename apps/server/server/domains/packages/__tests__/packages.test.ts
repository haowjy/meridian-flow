/** Consolidated test contracts; each block retains its original fixture scope.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Agent package vocabulary and overlay replacement
 */

import { describe as __mergedSuite, expect, it } from "vitest";
import { compileAgentDefinition } from "../domain/agent-definition-compiler.js";
import { prepareAgentSourceRevision } from "../domain/agent-source-revision.js";
import {
  canonicalizeJsonObject,
  normalizeAgentMeta,
  parseMarkdownDefinition,
  parseMarsToml,
  serializeMarkdownDefinition,
} from "../domain/mars-source.js";

__mergedSuite("agent-definition-compiler.test.ts", () => {
  // Merged from apps/server/server/domains/packages/__tests__/agent-definition-compiler.test.ts.
  const compile = (meta: Record<string, unknown>, config?: Record<string, unknown>) => {
    const result = compileAgentDefinition({ body: "Review the chapter.\n", meta, config });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    return result;
  };

  __mergedSuite("Agent definition compiler", () => {
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
        compile({ tools: ["read", "write"], "disallowed-tools": ["Write", "apply_patch"] })
          .definition.metadata,
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
});

__mergedSuite("agent-source-revision.test.ts", () => {
  // Merged from apps/server/server/domains/packages/__tests__/agent-source-revision.test.ts.
  const agent = "---\nname: General\nmodel: base\n---\n\nPrompt.\n";

  __mergedSuite("Agent source revision preparation", () => {
    it("includes supporting content in source identity without altering Agent content identity", () => {
      const first = prepareAgentSourceRevision({
        coordinate: "pkg",
        files: { "agents/general.md": agent, "skills/voice/reference.txt": "one" },
      });
      const second = prepareAgentSourceRevision({
        coordinate: "pkg",
        files: { "skills/voice/reference.txt": "two", "agents/general.md": agent },
      });
      expect(first.contentDigest).not.toBe(second.contentDigest);
      expect(first.definitions).toEqual(second.definitions);
      expect(
        prepareAgentSourceRevision({
          coordinate: "pkg",
          files: { "agents/general.md": agent, "skills/voice/reference.txt": "two" },
        }),
      ).toEqual(second);
    });
    it("encodes NUL-containing supporting bytes for JSONB without losing content", () => {
      const result = prepareAgentSourceRevision({
        coordinate: "pkg",
        files: { "reference.txt": "a\0b" },
      });
      expect(result.source.files["reference.txt"]).toEqual({
        encoding: "base64",
        data: "YQBi",
      });
    });
    it("rejects strings that UTF-8 encoding would silently change", () => {
      expect(() =>
        prepareAgentSourceRevision({
          coordinate: "pkg",
          files: { "reference.txt": "\ud800" },
        }),
      ).toThrow("UTF-8");
    });
    it.each([
      "/absolute",
      "../escape",
      "C:/escape",
      "a\\b",
      "a//b",
    ])("rejects nonportable source path %s", (path) => {
      expect(() =>
        prepareAgentSourceRevision({ coordinate: "pkg", files: { [path]: "" } }),
      ).toThrow("path");
    });
    it("rejects invalid definitions, dangling overlays, and malformed binary encodings", () => {
      expect(() =>
        prepareAgentSourceRevision({
          coordinate: "pkg",
          files: { "agents/general.md": "---\neffort: bogus\n---\n" },
        }),
      ).toThrow("effort");
      expect(() =>
        prepareAgentSourceRevision({
          coordinate: "pkg",
          files: { "mars.toml": '[agents.missing]\nmodel = "x"' },
        }),
      ).toThrow("no source definition");
      expect(() =>
        prepareAgentSourceRevision({
          coordinate: "pkg",
          files: { "bad.bin": { encoding: "base64", data: "bogus!" } },
        }),
      ).toThrow("base64");
    });
  });
});

__mergedSuite("mars-source.test.ts", () => {
  // Merged from apps/server/server/domains/packages/__tests__/mars-source.test.ts.
  __mergedSuite("Agent source fidelity", () => {
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
});
