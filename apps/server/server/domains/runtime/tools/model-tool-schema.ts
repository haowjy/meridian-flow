/** JSON Schema projection for inputs advertised to models. */
import { z } from "zod";

export function modelToolSchema(schema: z.ZodType): Record<string, unknown> {
  return stripModelSchemaNoise(
    z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>,
  ) as Record<string, unknown>;
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
