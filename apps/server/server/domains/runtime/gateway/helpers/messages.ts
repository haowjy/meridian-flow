/**
 * Message-construction helpers: small builders (user/assistant/system/text/
 * toolResult) for canonical gateway Message values. Convenience over the
 * domain message types.
 *
 * These are simple constructors that produce well-formed Message/ContentPart
 * values without boilerplate. Used by context-builder.ts in the loop and by
 * tests.
 */
import type { JsonValue } from "@meridian/contracts/threads";
import type {
  ContentPart,
  ImagePart,
  Message,
  ProviderOptions,
  TextPart,
} from "../domain/index.js";

export function user(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

export function system(text: string): Message {
  return { role: "system", content: [{ type: "text", text }] };
}

export function text(t: string, opts?: { providerOptions?: ProviderOptions }): TextPart {
  return { type: "text", text: t, providerOptions: opts?.providerOptions };
}

export function image(data: string | URL, mediaType: string): ImagePart {
  return { type: "image", data, mediaType };
}

export function assistant(parts: ContentPart[]): Message {
  return { role: "assistant", content: parts };
}

export function toolResult(toolCallId: string, output: JsonValue, isError?: boolean): Message {
  return {
    role: "tool",
    content: [{ type: "tool_result", toolCallId, output, isError }],
  };
}
