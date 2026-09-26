/**
 * Provider-neutral prompt-cache breakpoint markers for the assembled request.
 * A thread's cached prefix (tools + frozen system prompt + history) is stable
 * turn over turn, so marking where a cache boundary belongs lets a caching
 * provider serve the marked prefix from cache instead of reprocessing it on
 * every call. This module only decides *where* to mark (provider-neutral,
 * canonical `ContentPart.cacheBreakpoint`); it never decides TTL or wire
 * shape — each adapter owns that translation for its own API.
 *
 * Key decisions:
 * - Three marks, well under Anthropic's 4-breakpoint limit: the system
 *   message's last content part (covers tools + system, since tools precede
 *   system in Anthropic's wire order and a breakpoint covers everything
 *   before it), the previous request's tail (the read point — see below),
 *   and this request's tail (extends the cache incrementally over history).
 * - The read point follows Anthropic's own "moving breakpoint" guidance: mark
 *   the last block of the two most recent user turns, so the older mark
 *   lands where the previous request's own tail mark was written and the
 *   provider can serve that whole prefix from cache, while the newer mark
 *   (this request's tail) writes a fresh cache entry extending it. Anthropic
 *   folds tool_result content into "user" turns on the wire, so the read
 *   point here is the most recent non-`assistant` message strictly before
 *   the tail (covering canonical `user` *and* `tool` roles), not literally
 *   `role === "user"` — otherwise a long assistant/tool loop between two
 *   writer messages would keep pointing at a stale, out-of-lookback-range
 *   message instead of the position the previous request actually wrote.
 *   Anthropic's ~20-block lookback tolerates the position drifting by a
 *   message or two (e.g. when a steer folds in alongside a tool result), so
 *   exact precision here is a nice-to-have, not a correctness requirement.
 * - Marking only ever touches the system message and the two most recent
 *   non-assistant messages. As the tail advances, a message that was marked
 *   on a prior request (as the read point or the tail) can lose that mark
 *   once superseded, even if it is no longer the request's last message —
 *   e.g. the read point moves from message N to message N+2 once the tail
 *   advances by two. Content never changes once settled (the prefix
 *   guarantee thread AGENTS.md / runtime CONTEXT.md depends on); only this
 *   marker does, and providers hash content, not the marker, so a marker
 *   flip on settled history never invalidates the cache. Tests that assert
 *   prefix stability strip `cacheBreakpoint` before comparing, the same way
 *   they already tolerate the tail's own mark changing.
 * - Applied in the context-building layer (here), not inside a provider
 *   adapter: the decision of *which* parts to mark is provider-neutral
 *   (canonical `Message[]`), while whether to mark at all is driven by the
 *   model registry's config-driven `"caching"` capability (see
 *   `turn-context-assembly.ts`). This keeps the marking policy in one place
 *   instead of duplicating it per adapter.
 */
import type { ContentPart, Message } from "../gateway/index.js";

function withCacheBreakpoint(part: ContentPart): ContentPart {
  return { ...part, cacheBreakpoint: true };
}

function markLastPart(message: Message): Message {
  const lastIndex = message.content.length - 1;
  if (lastIndex < 0) return message;
  const content = [...message.content];
  content[lastIndex] = withCacheBreakpoint(content[lastIndex]);
  return { ...message, content };
}

/**
 * Index of the previous request's tail: the most recent non-`assistant`
 * message strictly before `tailIndex` (and after index 0, which is always
 * the system message and already its own mark). Returns -1 when there is no
 * such message — a fresh thread's first request, or a request too short to
 * have one.
 */
function findReadPointIndex(messages: readonly Message[], tailIndex: number): number {
  for (let index = tailIndex - 1; index >= 1; index--) {
    if (messages[index].role !== "assistant") return index;
  }
  return -1;
}

/**
 * Mark the system message, the previous request's tail (the read point), and
 * this request's tail for incremental prompt caching. No-op on an empty
 * request. At most three distinct positions are ever marked, deduplicated by
 * index so a short thread (where system, read point, and tail can coincide)
 * never marks the same part twice.
 */
export function applyPromptCacheMarks(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;
  const marked = [...messages];
  const tailIndex = marked.length - 1;
  const readPointIndex = findReadPointIndex(marked, tailIndex);

  const positions = new Set<number>([0, tailIndex]);
  if (readPointIndex >= 0) positions.add(readPointIndex);

  for (const index of positions) {
    marked[index] = markLastPart(marked[index]);
  }
  return marked;
}
