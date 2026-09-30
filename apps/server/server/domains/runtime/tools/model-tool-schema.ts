/** JSON Schema projection for inputs advertised to models. */
import { z } from "zod";

export function modelToolSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
}
