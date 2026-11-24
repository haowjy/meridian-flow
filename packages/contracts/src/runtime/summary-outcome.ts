import { z } from "zod";

export const SummaryRejectionReasonCodec = z.enum([
  "max_tokens",
  "provider_error",
  "request_too_large",
  "tool_use",
  "empty_text",
]);
export type SummaryRejectionReason = z.infer<typeof SummaryRejectionReasonCodec>;
