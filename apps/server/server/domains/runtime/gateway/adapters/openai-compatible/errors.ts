/** OpenAI-shaped error mapping (Chat Completions, Responses, OpenRouter): provider SDK errors to canonical gateway codes. */
import { type MappedProviderError, mapProviderHttpError } from "../provider-http-error.js";

const CONTEXT_OVERFLOW =
  /context[_ ](?:length|window)|prompt is too long|maximum context length|too many (?:input )?tokens|input.*exceeds.*token/;

export function mapOpenAIError(err: unknown): MappedProviderError {
  return mapProviderHttpError(err, {
    contextOverflow: CONTEXT_OVERFLOW,
    contentFiltered: /content[\s\S]*filter|filter[\s\S]*content/,
  });
}
