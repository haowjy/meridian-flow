import { describe, expect, it } from "vitest";

import { DEFAULT_AGENT_SLUG, threadCreateAgentField, wireAgentSlug } from "./constants";

describe("wireAgentSlug", () => {
  it("never sends the synthetic general slug to the server", () => {
    expect(wireAgentSlug(DEFAULT_AGENT_SLUG)).toBeUndefined();
    expect(wireAgentSlug("general")).toBeUndefined();
  });

  it("passes real catalog slugs through", () => {
    expect(wireAgentSlug("segmentation")).toBe("segmentation");
    expect(wireAgentSlug("writer")).toBe("writer");
    expect(wireAgentSlug("muse")).toBe("muse");
  });

  it("treats null and undefined as unbound", () => {
    expect(wireAgentSlug(null)).toBeUndefined();
    expect(wireAgentSlug(undefined)).toBeUndefined();
  });
});

describe("threadCreateAgentField", () => {
  it("use-create-chat: omits currentAgent for the default synthetic slug", () => {
    expect(threadCreateAgentField(DEFAULT_AGENT_SLUG)).toEqual({});
    expect(threadCreateAgentField(DEFAULT_AGENT_SLUG)).not.toHaveProperty("currentAgent");
  });

  it("useComposerNewProject / useThreadHandoff: omits currentAgent when composer leaves general selected", () => {
    expect(threadCreateAgentField("general")).toEqual({});
    expect(threadCreateAgentField(undefined)).toEqual({});
    expect(threadCreateAgentField(null)).toEqual({});
  });

  it("passes real launch slugs through unchanged", () => {
    expect(threadCreateAgentField("writer")).toEqual({ currentAgent: "writer" });
    expect(threadCreateAgentField("muse")).toEqual({ currentAgent: "muse" });
    expect(threadCreateAgentField("setup")).toEqual({ currentAgent: "setup" });
  });
});
