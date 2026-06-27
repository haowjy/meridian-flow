/**
 * Core tool-registry tests: pin the builtin tool catalogue and schema
 * constraints exposed to the model. These catch accidental tool additions,
 * removals, or metadata drift at the registry boundary.
 */
import { describe, expect, it } from "vitest";

import { CORE_TOOL_NAMES, createCoreToolRegistrations, createToolRegistry } from "../index.js";

function coreRegistrations() {
  const handler = async () => ({ ok: true });
  return createCoreToolRegistrations({
    write: handler,
    list: handler,
    search: handler,
    ask_user: handler,
  });
}

describe("createToolRegistry core tools", () => {
  it("registers provided core tool registrations", () => {
    const registry = createToolRegistry({ registrations: coreRegistrations() });

    expect(registry.getDefinitions().map((tool) => tool.name)).toEqual([...CORE_TOOL_NAMES]);
  });

  it("registers stable schemas and execution constraints for core tools", () => {
    const registry = createToolRegistry({ registrations: coreRegistrations() });

    for (const name of CORE_TOOL_NAMES) {
      const registration = registry.getRegistration(name);
      expect(registration?.definition.type).toBe("function");
      expect(registration?.definition.description).toBeTruthy();
      expect(registration?.definition.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(registration?.execution.type).toBe("server");
    }

    expect(registry.getRegistration("write")?.definition.inputSchema).toMatchObject({
      required: ["command", "path"],
      properties: {
        command: { enum: ["create", "read", "insert", "replace", "undo", "redo"] },
        path: { type: "string" },
        content: { type: "string" },
        find: { type: "string" },
        in: { type: "string" },
        around: { type: "string" },
        after: { type: "string" },
        before: { type: "string" },
        all: { type: "boolean" },
        to: { type: "string" },
        from: { type: "string" },
        last: { type: "integer", minimum: 1 },
        format: { enum: ["auto", "full", "outline"] },
      },
    });
    expect(registry.getRegistration("list")?.definition.inputSchema).toMatchObject({
      required: ["path"],
    });
    expect(registry.getRegistration("search")?.definition.inputSchema).toMatchObject({
      required: ["query"],
      properties: {
        uri: { type: "string" },
      },
    });
    expect(registry.getRegistration("ask_user")).toMatchObject({
      capability: "checkpoint",
      definition: {
        inputSchema: {
          required: ["question", "kind"],
          properties: {
            kind: { enum: ["choice", "free-text"] },
            options: { items: { required: ["value", "label"] } },
            timeoutMs: { minimum: 1 },
          },
        },
      },
    });
    expect(CORE_TOOL_NAMES).not.toContain("bash");
    expect(CORE_TOOL_NAMES).not.toContain("read");
    expect(CORE_TOOL_NAMES).not.toContain("edit");
    expect(registry.getRegistration("bash")).toBeUndefined();
    expect(registry.getRegistration("read")).toBeUndefined();
    expect(registry.getRegistration("edit")).toBeUndefined();
  });

  it("does not expose core tools by default", () => {
    expect(createToolRegistry().getDefinitions()).toEqual([]);
  });

  it("throws when registering a duplicate tool name", () => {
    const registry = createToolRegistry();
    const [write] = coreRegistrations();
    if (!write) throw new Error("missing write registration");

    registry.register(write);

    expect(() => registry.register(write)).toThrow(
      "Tool registration already exists for name: write",
    );
  });

  it("can keep server-executable registrations out of default advertisement", () => {
    const registry = createToolRegistry();
    registry.register({
      source: "core",
      definition: {
        type: "function",
        name: "agent_skill",
        description: "Agent-scoped skill",
        inputSchema: { type: "object" },
      },
      execution: { type: "server", handler: async () => ({ ok: true }) },
      advertise: false,
    });

    expect(registry.getDefinitions()).toEqual([]);
    expect(registry.getRegistration("agent_skill")?.execution.type).toBe("server");
  });

  it("does not advertise registrations without server execution", () => {
    const registry = createToolRegistry();
    registry.register({
      source: "core",
      definition: {
        type: "function",
        name: "client_only",
        description: "Client-only tool",
        inputSchema: { type: "object" },
      },
      execution: { type: "client" },
    });

    expect(registry.getDefinitions()).toEqual([]);
    expect(registry.getRegistration("client_only")?.execution.type).toBe("client");
  });
});
