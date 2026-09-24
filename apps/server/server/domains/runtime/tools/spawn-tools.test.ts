/** Spawn/thread_message tool argument parsing and the advertised JSON schema. */
import { describe, expect, it } from "vitest";
import {
  createSpawnToolRegistrations,
  parseSpawnToolArgs,
  parseThreadMessageArgs,
  parseThreadReportArgs,
} from "./spawn-tools.js";

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

describe("parseThreadMessageArgs", () => {
  it("keeps ref and message and defaults mode to background", () => {
    const args = parseThreadMessageArgs({ ref: "p1", message: "keep going" });
    expect(args).toEqual({
      ref: "p1",
      message: "keep going",
      mode: "background",
    });
    expect(parseThreadMessageArgs({ ref: "p1", message: "x", mode: "foreground" }).mode).toBe(
      "foreground",
    );
    expect(parseThreadMessageArgs({ ref: "p1", message: "x", mode: "sideways" }).mode).toBe(
      "background",
    );
  });

  it("drops malformed non-string fields", () => {
    expect(parseThreadMessageArgs({ ref: 7, message: 42 })).toEqual({
      ref: "",
      message: "",
      mode: "background",
    });
    expect(parseThreadMessageArgs(null)).toEqual({
      ref: "",
      message: "",
      mode: "background",
    });
  });
});

describe("thread_report tool contract", () => {
  it("requires an exact ref and assistant execution selector", () => {
    expect(parseThreadReportArgs({ ref: "p3", execution: "turn-uuid", latest: true })).toEqual({
      ref: "p3",
      execution: "turn-uuid",
    });
    const registration = createSpawnToolRegistrations().find(
      (entry) => entry.definition.name === "thread_report",
    );
    expect(registration?.capability).toBe("thread_report");
    expect(registration?.advertise).toBe(true);
    expect(registration?.definition).toMatchObject({
      inputSchema: { required: ["ref", "execution"], additionalProperties: false },
    });
    expect(registration?.definition).toMatchObject({
      inputSchema: { properties: { ref: { type: "string" }, execution: { type: "string" } } },
    });
  });
});
