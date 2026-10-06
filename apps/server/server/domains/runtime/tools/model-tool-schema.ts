/** JSON Schema projection of a tool's zod input: the one way a model-facing input schema is made. */
import { z } from "zod";

export function modelToolSchema(schema: z.ZodType): Record<string, unknown> {
  const projected = stripModelSchemaNoise(
    z.toJSONSchema(schema, { io: "input", override: publishModelJsonSchema }) as Record<
      string,
      unknown
    >,
  ) as Record<string, unknown>;
  // Every gateway adapter forwards this object as the provider JSON Schema.
  // Anthropic's SDK requires an object root, which z.toJSONSchema doesn't emit
  // for a discriminated union. Mark the root only; sealing the union wrapper
  // with additionalProperties would make every strict branch unsatisfiable.
  projected.type = "object";
  return projected;
}

/**
 * A schema whose zod projection is needlessly large declares its published
 * shape as `modelJsonSchema` metadata; it replaces the generated schema and
 * keeps the description. Parse-only checks such as positivity stay in zod.
 */
function publishModelJsonSchema(context: { jsonSchema: Record<string, unknown> }): void {
  const schema = context.jsonSchema;
  const published = schema.modelJsonSchema;
  if (!published || typeof published !== "object") return;
  const { description } = schema;
  for (const key of Object.keys(schema)) delete schema[key];
  Object.assign(schema, published, description === undefined ? {} : { description });
}

function stripModelSchemaNoise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripModelSchemaNoise);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key, entry]) =>
          key !== "$schema" && !(key === "maximum" && entry === Number.MAX_SAFE_INTEGER),
      )
      .map(([key, entry]) => [key, stripModelSchemaNoise(entry)]),
  );
}
