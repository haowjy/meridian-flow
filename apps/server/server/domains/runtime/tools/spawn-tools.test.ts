/** Spawn tool argument parsing and the advertised JSON schema. */
import { describe, expect, it } from "vitest";
import { createSpawnToolRegistrations, parseSpawnToolArgs } from "./spawn-tools.js";

function spawnSchema(): {
  properties: Record<string, Record<string, unknown>>;
  additionalProperties: boolean;
  required?: string[];
} {
  const registration = createSpawnToolRegistrations().find((entry) => entry.source === "spawn");
  const definition = registration?.definition;
  if (definition?.type !== "function" || definition.name !== "spawn") {
    throw new Error("spawn registration missing");
  }
  return definition.inputSchema as {
    properties: Record<string, Record<string, unknown>>;
    additionalProperties: boolean;
    required?: string[];
  };
}

describe("parseSpawnToolArgs", () => {
  it("keeps append_system_prompt and overrides when present and drops malformed values", () => {
    const args = parseSpawnToolArgs({
      agent: "critic",
      prompt: "review",
      description: "crit",
      mode: "foreground",
      append_system_prompt: "You are a harsh critic.",
      overrides: { tools: { edit: "allow" }, effort: "high" },
    });
    expect(args.append_system_prompt).toBe("You are a harsh critic.");
    expect(args.overrides).toEqual({ tools: { edit: "allow" }, effort: "high" });
    expect(parseSpawnToolArgs({ prompt: "go", append_system_prompt: 42 })).not.toHaveProperty(
      "append_system_prompt",
    );
    expect(parseSpawnToolArgs({ prompt: "go", overrides: "nope" })).not.toHaveProperty("overrides");
    expect(parseSpawnToolArgs({ prompt: "go", overrides: null })).not.toHaveProperty("overrides");
  });
});

describe("spawn tool input schema", () => {
  it("advertises append_system_prompt and overrides while rejecting extra properties", () => {
    const schema = spawnSchema();
    expect(schema.properties.append_system_prompt).toEqual({
      type: "string",
      description: expect.stringContaining("Appends"),
    });
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["prompt"]);
    expect(schema.properties.overrides).toEqual({
      type: "object",
      description: expect.stringContaining("model"),
    });
    expect(schema.properties.overrides).not.toHaveProperty("properties");
    expect(schema.properties.overrides).not.toHaveProperty("additionalProperties");
  });
});
