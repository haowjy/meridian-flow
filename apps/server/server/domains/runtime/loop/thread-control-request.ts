/** HTTP-facing control validation kept with the control domain contract. */

import { z } from "zod";
import { MAX_USER_MESSAGE_TEXT } from "../admission/user-turn-admission.js";

export const threadControlRequestSchema = z
  .object({
    id: z.string().uuid(),
    control: z
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
      .transform((control) =>
        control.instructions
          ? { kind: control.kind, instructions: control.instructions }
          : { kind: control.kind },
      ),
  })
  .strict();
