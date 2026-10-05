/** Anthropic error mapping: maps Anthropic SDK errors to canonical gateway codes. Keeps provider error shapes out of the gateway core. */
import { type MappedProviderError, mapProviderHttpError } from "../provider-http-error.js";

const CONTEXT_OVERFLOW =
  /context[_ ](?:length|window)|exceeds? context limit|prompt is too long|maximum context length|too many (?:input )?tokens|input.*exceeds.*token/;

export function mapAnthropicError(err: unknown): MappedProviderError {
  return mapProviderHttpError(err, {
    contextOverflow: CONTEXT_OVERFLOW,
    contentFiltered: /content[\s\S]*(?:filter|block)|(?:filter|block)[\s\S]*content/,
  });
}
