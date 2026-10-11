/** HTTP-facing control validation kept with the control domain contract. */

import type { ControlBody } from "@meridian/contracts/threads";
import { z } from "zod";
import { MAX_USER_MESSAGE_TEXT } from "../admission/user-turn-admission.js";

const compactControlSchema = z
  .object({
    kind: z.literal("compact"),
    instructions: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().max(MAX_USER_MESSAGE_TEXT))
      .transform((value) => value || undefined)
      .optional(),
  })
  .strict()
  .transform(
    (control): ControlBody =>
      control.instructions
        ? { kind: control.kind, instructions: control.instructions }
        : { kind: control.kind },
  );

const writeModeControlSchema = z
  .object({ kind: z.literal("write_mode"), mode: z.enum(["direct", "draft"]) })
  .strict();

export const threadControlRequestSchema = z
  .object({
    id: z.string().uuid(),
    control: z.discriminatedUnion("kind", [compactControlSchema, writeModeControlSchema]),
  })
  .strict();
