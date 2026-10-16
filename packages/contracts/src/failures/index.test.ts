import { describe, expect, it } from "vitest";
import {
  classifyCommandFailure,
  classifyReplyFailure,
  type FailureSource,
  type ReplyFailureInput,
} from "./index.js";

describe("classifyReplyFailure", () => {
  it.each<[string, ReplyFailureInput, FailureSource]>([
    ["network_error", { reason: "network_error" }, "transport"],
    ["server_error", { reason: "server_error" }, "provider"],
    ["rate_limited", { reason: "rate_limited" }, "provider"],
    ["content_filtered", { reason: "content_filtered" }, "provider"],
    ["context_overflow", { reason: "context_overflow" }, "provider"],
    ["max_tokens", { reason: "max_tokens" }, "provider"],
    ["a summary rejection", { reason: "empty_text" }, "provider"],
    ["compaction_failed", { reason: "compaction_failed" }, "provider"],
    ["handoff_brief_failed", { reason: "handoff_brief_failed" }, "provider"],
    ["auth_error", { reason: "auth_error" }, "bug"],
    ["orphaned", { reason: "orphaned" }, "bug"],
    ["shutdown", { reason: "shutdown" }, "bug"],
    ["interrupted", { reason: "interrupted" }, "bug"],
    ["credits_exhausted", { reason: "credits_exhausted" }, "usage"],
    ["the error code when no reason", { code: "rate_limited" }, "provider"],
    ["an untyped provider code", { reason: "some_new_provider_code", status: 529 }, "bug"],
    ["no reason and no code", {}, "bug"],
    ["an inherited key name", { reason: "toString" }, "bug"],
  ])("%s", (_name, input, source) => {
    expect(classifyReplyFailure(input)).toMatchObject({ category: "reply", source });
  });
});

describe("classifyCommandFailure", () => {
  it("names the source from how the attempt ended and keeps the status as the cause", () => {
    expect(classifyCommandFailure({ kind: "lost" })).toMatchObject({
      category: "command",
      source: "transport",
      cause: { code: "lost" },
    });
    expect(classifyCommandFailure({ kind: "refused", status: 409, code: "x" })).toMatchObject({
      source: "refusal",
      cause: { code: "x", status: 409 },
    });
    expect(classifyCommandFailure({ kind: "unsaved" })).toMatchObject({ source: "bug" });
  });
});
