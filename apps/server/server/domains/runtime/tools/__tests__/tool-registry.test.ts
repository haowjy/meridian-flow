/**
 * Core tool-registry tests: pin the builtin tool catalogue and schema
 * constraints exposed to the model. These catch accidental tool additions,
 * removals, or metadata drift at the registry boundary.
 */
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { CORE_TOOL_NAMES, createCoreToolRegistrations, createToolRegistry } from "../index.js";

function coreRegistrations() {
  const handler = async () => ({ ok: true });
  return createCoreToolRegistrations({
    write: handler,
    ls: handler,
    grep: handler,
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
      expect(registration?.definition.inputSchema).toMatchObject({ type: "object" });
      expect(registration?.execution.type).toBe("server");
    }

    const writeSchema = registry.getRegistration("write")?.definition.inputSchema as {
      oneOf?: Array<{
        required?: string[];
        additionalProperties?: boolean;
        properties?: Record<string, unknown>;
      }>;
    };
    expect(writeSchema).toMatchObject({ type: "object" });
    expect(writeSchema).not.toMatchObject({ additionalProperties: false });
    expect(writeSchema.oneOf?.map((variant) => variant.properties?.command)).toEqual([
      { type: "string", const: "create" },
      { type: "string", const: "read" },
      { type: "string", const: "diff" },
      { type: "string", const: "insert" },
      { type: "string", const: "replace" },
      { type: "string", const: "undo" },
      { type: "string", const: "redo" },
    ]);
    for (const variant of writeSchema.oneOf ?? []) {
      expect(variant.required).toContain("command");
      expect(variant.additionalProperties).toBe(false);
      if ((variant.properties?.command as { const?: string } | undefined)?.const === "diff") {
        expect(variant.required).not.toContain("path");
        expect(variant.properties).toHaveProperty("document_id");
      } else {
        expect(variant.required).toContain("path");
        expect(variant.properties).toHaveProperty("path");
      }
      expect(variant.properties).not.toHaveProperty("file");
      expect(variant.properties).not.toHaveProperty("documentId");
      expect(variant.properties).not.toHaveProperty("tool_use_id");
    }
    expect(registry.getRegistration("write")?.definition.description).toContain(
      "create with overwrite=true",
    );
    expect(writeSchema.oneOf?.[0]?.properties).toMatchObject({
      overwrite: { description: expect.stringContaining("entire existing document") },
    });
    expect(writeSchema.oneOf?.[1]?.properties).toMatchObject({
      in: {
        anyOf: expect.arrayContaining([
          { type: "string" },
          { type: "number" },
          {
            type: "array",
            prefixItems: [{ anyOf: expect.any(Array) }, { anyOf: expect.any(Array) }],
          },
        ]),
      },
      around: { type: "string" },
      format: { enum: ["auto", "full", "outline"] },
    });
    expect(writeSchema.oneOf?.[3]?.required).toContain("content");
    expect(writeSchema.oneOf?.[3]?.properties).toMatchObject({
      before: { description: expect.stringContaining("Block hash") },
      after: { description: expect.stringContaining("Block hash") },
      in: { description: expect.stringContaining("inclusive [start, end] range") },
    });
    expect(writeSchema.oneOf?.[4]?.required).toContain("content");
    expect(writeSchema.oneOf?.[4]?.properties).toMatchObject({
      find: { description: expect.stringContaining("following text and blocks are not included") },
      in: { description: expect.stringContaining("inclusive [start, end] range") },
    });
    expect(writeSchema.oneOf?.[5]?.properties).toMatchObject({
      to: { type: "string" },
      from: { type: "string" },
      last: { type: "integer", minimum: 1 },
      all: { type: "boolean" },
    });
    expect(registry.getRegistration("ls")?.definition.inputSchema).toMatchObject({
      required: [],
    });
    expect(registry.getRegistration("grep")?.definition.inputSchema).toMatchObject({
      required: ["pattern"],
      properties: {
        scope: { type: "string" },
      },
    });
    expect(registry.getRegistration("ask_user")).toMatchObject({
      capability: "interrupt",
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

  it("publishes a satisfiable write schema for model tool calls", () => {
    const registry = createToolRegistry({ registrations: coreRegistrations() });
    const writeSchema = registry.getRegistration("write")?.definition.inputSchema;
    if (!writeSchema) throw new Error("missing write schema");

    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(writeSchema);

    for (const command of [
      { command: "read", path: "chapter.md" },
      {
        command: "insert",
        path: "chapter.md",
        content: "New paragraph.",
        in: [1, "c3d4"],
        before: "a1b2",
      },
    ]) {
      expect(validate(command), JSON.stringify(validate.errors)).toBe(true);
    }

    expect(validate({ command: "read", file: "chapter.md" })).toBe(false);
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
