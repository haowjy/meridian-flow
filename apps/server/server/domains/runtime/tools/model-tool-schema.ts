import { z } from "zod";

export function modelToolSchema(schema: z.ZodType): Record<string, unknown> {
  const projected = stripModelSchemaNoise(
    z.toJSONSchema(schema, { io: "input", override: publishModelJsonSchema }) as Record<
      string,
      unknown
    >,
  ) as Record<string, unknown>;
  // Anthropic's SDK needs an object root; mark only the Zod discriminated-union root
  projected.type = "object";
  return projected;
}

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
