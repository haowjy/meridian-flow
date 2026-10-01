import { describe, expect, it } from "vitest";
import { system, user } from "../../helpers/messages.js";
import { toOpenAIResponsesParams } from "./request-map.js";

describe("toOpenAIResponsesParams prompt-cache routing key", () => {
  it("forwards promptCacheKey as prompt_cache_key", () => {
    const params = toOpenAIResponsesParams(
      { messages: [system("You are Writer."), user("Hello.")], promptCacheKey: "thread-123" },
      "gpt-4.1",
    );
    expect(params.prompt_cache_key).toBe("thread-123");
  });

  it("omits prompt_cache_key when the request has none", () => {
    const params = toOpenAIResponsesParams(
      { messages: [system("You are Writer."), user("Hello.")] },
      "gpt-4.1",
    );
    expect(params).not.toHaveProperty("prompt_cache_key");
  });

  it("never sets prompt_cache_retention or prompt_cache_options — no owner-chosen 1h equivalent exists", () => {
    // The installed SDK's Responses params only expose
    // prompt_cache_retention: "in_memory" | "24h", neither of which is the
    // 1h default this codebase uses elsewhere; there is no
    // prompt_cache_options/ttl field at all. Leaving both unset defers to
    // the account's own default instead of guessing toward a bigger,
    // unrequested retention commitment.
    const params = toOpenAIResponsesParams(
      { messages: [system("You are Writer."), user("Hello.")], promptCacheKey: "thread-123" },
      "gpt-4.1",
    );
    expect(params).not.toHaveProperty("prompt_cache_retention");
    expect(params).not.toHaveProperty("prompt_cache_options");
  });
});
