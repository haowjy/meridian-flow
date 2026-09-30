/** Model-facing schema requiredness, including Zod input defaults. */
import { describe, expect, it } from "vitest";
import { type CoreToolHandlers, createCoreToolRegistrations } from "./core-tools.js";
import { createInspectionToolRegistrations } from "./inspection-tools.js";

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
        ["write", "work", "thread_ls", "thread_history"].includes(definition.name),
      )
      .map(({ definition }) => ({
        name: definition.name,
        required: requiredFields(definition.inputSchema),
      }));

    expect(definitions).toMatchInlineSnapshot(`
      [
        {
          "name": "write",
          "required": [
            "$.oneOf[0]: path, command",
            "$.oneOf[1]: path, command",
            "$.oneOf[2]: command",
            "$.oneOf[3]: path, command, content",
            "$.oneOf[4]: path, command, content",
            "$.oneOf[5]: path, command, in",
            "$.oneOf[6]: path, command",
            "$.oneOf[7]: path, command",
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
            "$.oneOf[5]: command",
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
});
