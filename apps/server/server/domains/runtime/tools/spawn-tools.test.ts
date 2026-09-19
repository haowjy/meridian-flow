/** Spawn tool argument parsing and the advertised JSON schema. */
import { describe, expect, it } from "vitest";
import { createSpawnToolRegistrations, parseSpawnToolArgs } from "./spawn-tools.js";

function spawnSchema(): {
  properties: Record<string, { type?: string; enum?: string[] }>;
  additionalProperties: boolean;
  required?: string[];
} {
  const registration = createSpawnToolRegistrations().find((entry) => entry.source === "spawn");
  const definition = registration?.definition;
  if (definition?.type !== "function" || definition.name !== "spawn") {
    throw new Error("spawn registration missing");
  }
  return definition.inputSchema as {
    properties: Record<string, { type?: string; enum?: string[] }>;
    additionalProperties: boolean;
    required?: string[];
  };
}

describe("parseSpawnToolArgs", () => {
  it("parses the baseline fields and defaults mode to foreground", () => {
    expect(parseSpawnToolArgs({ prompt: "go" })).toEqual({
      prompt: "go",
      mode: "foreground",
    });
    expect(parseSpawnToolArgs({ prompt: "go", mode: "background" })).toEqual({
      prompt: "go",
      mode: "background",
    });
  });

  it("preserves system_prompt and overrides when present", () => {
    const args = parseSpawnToolArgs({
      agent: "critic",
      prompt: "review",
      description: "crit",
      mode: "foreground",
      system_prompt: "You are a harsh critic.",
      overrides: { tools: { edit: "allow" }, effort: "high" },
    });
    expect(args.system_prompt).toBe("You are a harsh critic.");
    expect(args.overrides).toEqual({ tools: { edit: "allow" }, effort: "high" });
  });

  it("drops non-string system_prompt and non-object overrides", () => {
    expect(parseSpawnToolArgs({ prompt: "go", system_prompt: 42 })).not.toHaveProperty(
      "system_prompt",
    );
    expect(parseSpawnToolArgs({ prompt: "go", overrides: "nope" })).not.toHaveProperty("overrides");
    expect(parseSpawnToolArgs({ prompt: "go", overrides: null })).not.toHaveProperty("overrides");
  });
});

describe("spawn tool input schema", () => {
  it("advertises system_prompt and overrides while rejecting extra properties", () => {
    const schema = spawnSchema();
    expect(schema.properties.system_prompt).toEqual({
      type: "string",
      description: expect.any(String),
    });
    expect(schema.properties.overrides).toEqual({
      type: "object",
      description: expect.any(String),
    });
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["prompt"]);
  });
});
