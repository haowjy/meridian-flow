import { z } from "zod";

export const waitlistSubmissionSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .transform((value) => value.toLowerCase()),
});

export type WaitlistSubmission = z.infer<typeof waitlistSubmissionSchema>;
export type WaitlistSubmissionSource = "object" | "form-data";
export type WaitlistSubmissionInput = {
  source: WaitlistSubmissionSource;
  submission: WaitlistSubmission;
};

export function parseWaitlistSubmissionInput(input: unknown): WaitlistSubmissionInput {
  if (input instanceof FormData) {
    return {
      source: "form-data",
      submission: waitlistSubmissionSchema.parse({
        email: input.get("email"),
      }),
    };
  }

  return {
    source: "object",
    submission: waitlistSubmissionSchema.parse(input),
  };
}
