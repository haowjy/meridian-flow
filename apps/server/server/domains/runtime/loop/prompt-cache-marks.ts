/**
 * Anthropic prompt-cache breakpoints for the assembled request. A thread's
 * cached prefix (tools + frozen system prompt + history) is stable turn over
 * turn, so marking it lets the provider serve it from cache instead of
 * reprocessing the whole prefix on every call.
 *
 * Key decisions:
 * - Two ephemeral `cache_control` breakpoints, well under Anthropic's 4-mark
 *   limit: the system message's last content part (caches tools + system,
 *   since tools precede system in Anthropic's wire order and a breakpoint
 *   covers everything before it) and the final message's last content part
 *   (extends that cache incrementally over history).
 * - Marking only ever touches the system message and the current final
 *   message. An older message that was "final" on a prior turn loses its
 *   mark once superseded — Anthropic hashes content, not the `cache_control`
 *   metadata field itself, so this never invalidates the cache — and it keeps
 *   every non-final message byte-identical across turns, which the prefix
 *   guarantee (thread AGENTS.md / runtime CONTEXT.md) depends on.
 * - Applied in the context-building layer (here), not inside a provider
 *   adapter: the decision of *which* parts to mark is provider-neutral
 *   (canonical `Message[]`), while whether to mark at all is driven by the
 *   model registry's config-driven `"caching"` capability. This keeps the
 *   Anthropic adapter untouched for the direct path and lets any adapter that
 *   forwards `providerOptions.anthropic.cacheControl` (Anthropic direct,
 *   OpenRouter for Anthropic-backed models) pick it up without duplicating
 *   the marking policy per adapter.
 */
import type { ContentPart, Message } from "../gateway/index.js";

const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" } as const;

function withCacheControl(part: ContentPart): ContentPart {
  return {
    ...part,
    providerOptions: {
      ...part.providerOptions,
      anthropic: {
        ...part.providerOptions?.anthropic,
        cacheControl: EPHEMERAL_CACHE_CONTROL,
      },
    },
  };
}

function markLastPart(message: Message): Message {
  const lastIndex = message.content.length - 1;
  if (lastIndex < 0) return message;
  const content = [...message.content];
  content[lastIndex] = withCacheControl(content[lastIndex]);
  return { ...message, content };
}

/**
 * Mark the system message and the final message for incremental Anthropic
 * prompt caching. No-op on an empty request. Idempotent when the system
 * message is also the final message (a fresh thread's first turn).
 */
export function applyPromptCacheMarks(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;
  const marked = [...messages];
  marked[0] = markLastPart(marked[0]);
  const lastIndex = marked.length - 1;
  marked[lastIndex] = markLastPart(marked[lastIndex]);
  return marked;
}
