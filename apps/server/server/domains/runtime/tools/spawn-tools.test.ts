/** Spawn/continue tool argument parsing and the advertised JSON schema. */
import { describe, expect, it } from "vitest";
import {
  createSpawnToolRegistrations,
  parseContinueToolArgs,
  parseSpawnToolArgs,
} from "./spawn-tools.js";

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

function continueSchema(): {
  properties: Record<string, Record<string, unknown>>;
  additionalProperties: boolean;
  required?: string[];
} {
  const registration = createSpawnToolRegistrations().find(
    (entry) => entry.definition.name === "continue",
  );
  const definition = registration?.definition;
  if (definition?.type !== "function" || definition.name !== "continue") {
    throw new Error("continue registration missing");
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

describe("parseContinueToolArgs", () => {
  it("keeps conversation_id and prompt and defaults mode to foreground", () => {
    const args = parseContinueToolArgs({ conversation_id: "child-1", prompt: "keep going" });
    expect(args).toEqual({
      conversation_id: "child-1",
      prompt: "keep going",
      mode: "foreground",
    });
    expect(
      parseContinueToolArgs({ conversation_id: "child-1", prompt: "x", mode: "background" }).mode,
    ).toBe("background");
    expect(
      parseContinueToolArgs({ conversation_id: "child-1", prompt: "x", mode: "sideways" }).mode,
    ).toBe("foreground");
  });

  it("drops malformed non-string fields", () => {
    expect(parseContinueToolArgs({ conversation_id: 7, prompt: 42 })).toEqual({
      conversation_id: "",
      prompt: "",
      mode: "foreground",
    });
    expect(parseContinueToolArgs(null)).toEqual({
      conversation_id: "",
      prompt: "",
      mode: "foreground",
    });
  });
});

describe("continue tool input schema", () => {
  it("requires conversation_id and prompt, defaults unstated mode, and rejects escalation fields", () => {
    const schema = continueSchema();
    expect(schema.required).toEqual(["conversation_id", "prompt"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.mode).toEqual({
      type: "string",
      enum: ["foreground", "background"],
      description: expect.any(String),
    });
    expect(schema.properties).not.toHaveProperty("append_system_prompt");
    expect(schema.properties).not.toHaveProperty("overrides");
    expect(schema.properties).not.toHaveProperty("agent");
  });
});
