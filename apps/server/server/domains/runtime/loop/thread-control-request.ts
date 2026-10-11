/**
 * HTTP-facing control validation: the contract's control vocabulary, made
 * strict and with compaction instructions normalized at admission.
 */

import {
  type ControlBody,
  compactControlBodySchema,
  writeModeControlBodySchema,
} from "@meridian/contracts/threads";
import { z } from "zod";
import { MAX_USER_MESSAGE_TEXT } from "../admission/user-turn-admission.js";

const compactControlSchema = compactControlBodySchema
  .extend({
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

export const threadControlRequestSchema = z
  .object({
    id: z.string().uuid(),
    control: z.discriminatedUnion("kind", [
      compactControlSchema,
      writeModeControlBodySchema.strict(),
    ]),
  })
  .strict();
