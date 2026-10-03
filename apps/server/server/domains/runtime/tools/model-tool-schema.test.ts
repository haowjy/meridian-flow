/**
 * Model-facing schemas: requiredness, the published projection of every
 * registration's zod input, and the pinned size of the primary catalog.
 */
import { describe, expect, it } from "vitest";
import { advertiseTools } from "../loop/permissions/apply-tool-policy.js";
import { projectToolPolicy } from "../loop/permissions/project-tool-policy.js";
import { type CoreToolHandlers, createCoreToolRegistrations } from "./core-tools.js";
import { createInspectionToolRegistrations } from "./inspection-tools.js";
import { modelToolSchema } from "./model-tool-schema.js";
import { createSkillToolRegistrations } from "./skill-tool.js";
import { createSpawnToolRegistrations } from "./spawn-tools.js";
import { createToolRegistry } from "./tool-registry.js";
import type { ToolRegistration } from "./types.js";

function allRegistrations(): ToolRegistration[] {
  const handler = async () => "";
  return [
    ...createCoreToolRegistrations({
      read: handler,
      write: handler,
      work: handler,
      ls: handler,
      search: handler,
      ask_user: handler,
    } as CoreToolHandlers),
    ...createInspectionToolRegistrations({
      repos: {} as never,
      statusReader: {} as never,
      registry: {} as never,
      tokenizer: async () => "anthropic",
    }),
    ...createSpawnToolRegistrations(),
    ...createSkillToolRegistrations({ loadBody: async () => ({ slug: "", body: "" }) }),
  ];
}

function requiredFields(schema: unknown, path = "$"): string[] {
  if (!schema || typeof schema !== "object") return [];
  if (Array.isArray(schema))
    return schema.flatMap((value, index) => requiredFields(value, `${path}[${index}]`));
  const record = schema as Record<string, unknown>;
  const own = Array.isArray(record.required)
    ? [`${path}: ${record.required.join(", ") || "(none)"}`]
    : [];
  return [
    ...own,
    ...Object.entries(record).flatMap(([key, value]) => requiredFields(value, `${path}.${key}`)),
  ];
}

describe("model tool schemas", () => {
  it("snapshots required fields from the input side of every Zod-backed tool schema", () => {
    const handler = async () => "";
    const core = createCoreToolRegistrations({
      read: handler,
      write: handler,
      work: handler,
      ls: handler,
      search: handler,
      ask_user: handler,
    } as CoreToolHandlers);
    const inspection = createInspectionToolRegistrations({
      repos: {} as never,
      statusReader: {} as never,
      registry: {} as never,
      tokenizer: async () => "anthropic",
    });
    const definitions = [...core, ...inspection]
      .filter(({ definition }) =>
        ["read", "write", "work", "thread_ls", "thread_history"].includes(definition.name),
      )
      .map(({ definition }) => ({
        name: definition.name,
        required: requiredFields(definition.inputSchema),
      }));

    expect(definitions).toMatchInlineSnapshot(`
      [
        {
          "name": "read",
          "required": [
            "$: path",
          ],
        },
        {
          "name": "write",
          "required": [
            "$.oneOf[0]: command, path",
            "$.oneOf[1]: command, path, from",
            "$.oneOf[1].properties.from: path",
            "$.oneOf[2]: command, path",
            "$.oneOf[2].properties.from: path",
            "$.oneOf[3]: command, path",
            "$.oneOf[3].properties.from: path",
            "$.oneOf[4]: command, path",
            "$.oneOf[5]: command, path",
            "$.oneOf[6]: command, path",
          ],
        },
        {
          "name": "work",
          "required": [
            "$.oneOf[0]: command",
            "$.oneOf[1]: work, command",
            "$.oneOf[2]: command, name",
            "$.oneOf[3]: work, command",
            "$.oneOf[4]: work, command",
            "$.oneOf[5]: work, command",
            "$.oneOf[6]: work, command",
            "$.oneOf[7]: command",
          ],
        },
        {
          "name": "thread_ls",
          "required": [],
        },
        {
          "name": "thread_history",
          "required": [],
        },
      ]
    `);
  });

  it("removes Zod metadata that adds no model constraint", () => {
    const handler = async () => "";
    const schemas = createCoreToolRegistrations({
      read: handler,
      write: handler,
      work: handler,
      ls: handler,
      search: handler,
      ask_user: handler,
    } as CoreToolHandlers).map(({ definition }) => JSON.stringify(definition.inputSchema));

    expect(schemas.every((schema) => !schema.includes('"$schema"'))).toBe(true);
    expect(schemas.every((schema) => !schema.includes(String(Number.MAX_SAFE_INTEGER)))).toBe(true);
  });

  it("publishes exactly the generator's projection of every registration's input", () => {
    for (const registration of allRegistrations()) {
      expect(registration.definition.inputSchema, registration.definition.name).toEqual(
        modelToolSchema(registration.input),
      );
    }
  });

  it('documents "current" on every read-only conversation ref', () => {
    const properties = (name: string) =>
      allRegistrations().find((r) => r.definition.name === name)?.definition.inputSchema
        .properties as Record<string, { description?: string }>;
    for (const [tool, field] of [
      ["thread_history", "ref"],
      ["thread_ls", "ref"],
      ["thread_report", "ref"],
      ["spawn", "from"],
    ] as const) {
      expect(properties(tool)[field]?.description, `${tool}.${field}`).toContain('"current"');
    }
  });

  // Later phases change this number on purpose, so catalog growth shows in review.
  it("pins the published primary catalog size", () => {
    // The primary catalog as the audit exporter defines it: the default policy's advertisement.
    const definitions = advertiseTools(
      createToolRegistry({ registrations: allRegistrations() }).getDefinitions(),
      projectToolPolicy({}),
    ).flatMap((tool) => (tool.type === "function" ? [tool] : []));
    const characters = definitions.reduce(
      (total, { name, description, inputSchema }) =>
        total + JSON.stringify({ name, description, inputSchema }).length,
      0,
    );
    expect(definitions.map(({ name }) => name)).toMatchInlineSnapshot(`
      [
        "read",
        "write",
        "work",
        "ls",
        "search",
        "thread_ls",
        "thread_history",
        "thread_report",
        "spawn",
        "thread_message",
        "skill",
      ]
    `);
    expect(characters).toMatchInlineSnapshot(`17002`);
  });
});
