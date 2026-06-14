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
    read: handler,
    edit: handler,
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

    expect(registry.getRegistration("read")?.definition.inputSchema).toMatchObject({
      required: ["path"],
    });
    expect(registry.getRegistration("edit")?.definition.inputSchema).toMatchObject({
      required: ["path", "edits"],
      properties: {
        edits: {
          type: "array",
          items: { required: ["oldText", "newText"] },
        },
      },
    });
    expect(registry.getRegistration("write")?.definition.inputSchema).toMatchObject({
      required: ["path", "content"],
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
    expect(registry.getRegistration("bash")).toBeUndefined();
  });

  it("does not expose core tools by default", () => {
    expect(createToolRegistry().getDefinitions()).toEqual([]);
  });

  it("throws when registering a duplicate tool name", () => {
    const registry = createToolRegistry();
    const [read] = coreRegistrations();
    if (!read) throw new Error("missing read registration");

    registry.register(read);

    expect(() => registry.register(read)).toThrow(
      "Tool registration already exists for name: read",
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
