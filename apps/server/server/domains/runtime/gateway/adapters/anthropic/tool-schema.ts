/** Anthropic-only advertisement of canonical command unions; execution keeps its Zod contract. */
import type { FunctionTool } from "../../domain/index.js";

type Field = Record<string, unknown>;
type CommandBranch = {
  type: "object";
  description?: string;
  properties: Record<string, Field>;
  required?: string[];
  additionalProperties?: boolean;
};

/**
 * Root object command unions are the supported projection boundary. Their
 * relationships become generated guidance, not a replacement validation schema.
 * Other root intersections/constraints must not be silently discarded.
 */
export function anthropicToolSchema(schema: FunctionTool["inputSchema"]): Record<string, unknown> {
  if ("allOf" in schema) throw new Error("Anthropic tool schemas do not support root allOf");
  const { oneOf, anyOf, ...root } = schema;
  const alternatives = oneOf ?? anyOf;
  if (alternatives === undefined) return schema;
  if (
    (oneOf !== undefined && anyOf !== undefined) ||
    !Array.isArray(alternatives) ||
    alternatives.length === 0 ||
    root.properties !== undefined
  ) {
    throw new Error(
      "Anthropic tool projection requires a single root command union without sibling properties",
    );
  }

  const branchKeys = new Set([
    "type",
    "description",
    "properties",
    "required",
    "additionalProperties",
  ]);
  const variants = alternatives as CommandBranch[];
  for (const branch of variants) {
    if (
      branch?.type !== "object" ||
      typeof branch.properties?.command?.const !== "string" ||
      Object.keys(branch).some((key) => !branchKeys.has(key)) ||
      (branch.additionalProperties !== undefined &&
        typeof branch.additionalProperties !== "boolean")
    ) {
      throw new Error(
        "Anthropic tool projection requires object branches with literal commands and no branch-level combinators",
      );
    }
  }

  const fields = new Map<string, { options: Field[]; descriptions: string[] }>();
  const commands: string[] = [];
  for (const branch of variants) {
    const command = branch.properties.command.const;
    commands.push(
      `${command}: ${branch.description ?? ""}\n[${command}] ${branch.properties.command.description ?? "Select this command."}\nRequired fields: ${(branch.required ?? []).join(", ") || "none"}.\nAllowed fields: ${Object.keys(branch.properties).join(", ")}. ${branch.additionalProperties === false ? "Do not send other fields." : "Additional fields are allowed."}`,
    );
    for (const [name, field] of Object.entries(branch.properties)) {
      const entry = fields.get(name) ?? { options: [], descriptions: [] };
      const { description, ...constraints } = field;
      if (!entry.options.some((option) => JSON.stringify(option) === JSON.stringify(constraints))) {
        entry.options.push(constraints);
      }
      entry.descriptions.push(`[${command}] ${description ?? `${name} is allowed.`}`);
      fields.set(name, entry);
    }
  }
  return {
    ...root,
    type: "object",
    properties: Object.fromEntries(
      [...fields].map(([name, { options, descriptions }]) => [
        name,
        {
          ...(options.length === 1 ? options[0] : { anyOf: options }),
          description: name === "command" ? commands.join("\n\n") : descriptions.join("\n"),
        },
      ]),
    ),
    required: [
      ...new Set([
        ...((root.required as string[] | undefined) ?? []),
        ...(variants[0].required ?? []).filter((name) =>
          variants.every((branch) => branch.required?.includes(name)),
        ),
      ]),
    ],
  };
}
