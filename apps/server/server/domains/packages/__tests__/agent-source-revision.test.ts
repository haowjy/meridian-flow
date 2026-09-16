/** Full-source identity and compiler integration at the immutable import boundary. */
import { describe, expect, it } from "vitest";
import { prepareAgentSourceRevision } from "../domain/agent-source-revision.js";

const agent = "---\nname: General\nmodel: base\n---\n\nPrompt.\n";
describe("Agent source revision preparation", () => {
  it("encodes NUL-containing supporting bytes for JSONB without losing content", () => {
    const result = prepareAgentSourceRevision({
      coordinate: "pkg",
      files: { "reference.txt": "a\0b" },
    });
    expect(result.source.files["reference.txt"]).toEqual({ encoding: "base64", data: "YQBi" });
  });
  it("rejects strings that UTF-8 encoding would silently change", () => {
    expect(() =>
      prepareAgentSourceRevision({ coordinate: "pkg", files: { "reference.txt": "\ud800" } }),
    ).toThrow("UTF-8");
  });

  it("derives definitions from retained source and TOML overlays", () => {
    const source = prepareAgentSourceRevision({
      coordinate: "pkg",
      files: {
        "agents/general.md": agent,
        "mars.toml": '[package]\nname = "pkg"\n[agents.general]\nmodel = "specialist"',
        "skills/voice/SKILL.md": "Voice guidance.",
      },
    });
    expect(source.definitions[0]).toMatchObject({
      slug: "general",
      definition: {
        systemPrompt: "Prompt.\n",
        metadata: { model: "specialist" },
      },
    });
    expect(source.source.files["agents/general.md"]).toBe(agent);
    const recompiled = prepareAgentSourceRevision({
      coordinate: source.coordinate,
      ...source.source,
    });
    expect(recompiled).toEqual(source);
  });
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
  it.each([
    "/absolute",
    "../escape",
    "a/../escape",
    "C:/escape",
    "a\\b",
    "a//b",
  ])("rejects nonportable source path %s", (path) => {
    expect(() => prepareAgentSourceRevision({ coordinate: "pkg", files: { [path]: "" } })).toThrow(
      "path",
    );
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
