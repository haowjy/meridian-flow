/** JSON Schema projection of a tool's zod input: the one way a model-facing input schema is made. */
import { z } from "zod";

export function modelToolSchema(schema: z.ZodType): Record<string, unknown> {
  const projected = stripModelSchemaNoise(
    z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>,
  ) as Record<string, unknown>;
  // Every gateway adapter forwards this object as the provider JSON Schema.
  // Anthropic's SDK requires an object root, which z.toJSONSchema doesn't emit
  // for a discriminated union. Mark the root only; sealing the union wrapper
  // with additionalProperties would make every strict branch unsatisfiable.
  projected.type = "object";
  return projected;
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
