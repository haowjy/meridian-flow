import { describe, expect, it } from "vitest";

import { DEFAULT_AGENT_SLUG, wireAgentSlug } from "./constants";

describe("wireAgentSlug", () => {
  it("never sends the synthetic general slug to the server", () => {
    expect(wireAgentSlug(DEFAULT_AGENT_SLUG)).toBeUndefined();
    expect(wireAgentSlug("general")).toBeUndefined();
  });

  it("passes real catalog slugs through", () => {
    expect(wireAgentSlug("segmentation")).toBe("segmentation");
  });

  it("treats null and undefined as unbound", () => {
    expect(wireAgentSlug(null)).toBeUndefined();
    expect(wireAgentSlug(undefined)).toBeUndefined();
  });
});
