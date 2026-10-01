/** Query bounds and exact cursor/selection parsing at the HTTP boundary. */
import { handoffThreadRequestSchema } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { parseAgentCatalogQuery } from "./agent-catalog-query.js";
import { requireAgentSelection } from "./request-id.js";

const ID = "00000000-0000-4000-8000-000000000871";

describe("Agent catalog transport", () => {
  it("accepts bounded pages and complete cursor pairs", () => {
    expect(parseAgentCatalogQuery({})).toEqual({ limit: 50 });
    expect(parseAgentCatalogQuery({ limit: "100", afterId: ID, afterNameSortKey: "" })).toEqual({
      limit: 100,
      after: { id: ID, nameSortKey: "" },
    });
    expect(requireAgentSelection({ catalogEntryId: ID, definitionRevisionId: ID })).toEqual({
      catalogEntryId: ID,
      definitionRevisionId: ID,
    });
  });
  it("uses the same canonical selection grammar for handoff and other routes", () => {
    const selection = {
      catalogEntryId: "ABCDEFAB-0000-0000-0000-000000000871",
      definitionRevisionId: ID,
    };
    const parsed = handoffThreadRequestSchema.parse({
      id: ID,
      originTurnId: ID,
      agentSelection: selection,
    });
    expect(parsed.agentSelection).toEqual(requireAgentSelection(selection));
    expect(parsed.agentSelection.catalogEntryId).toBe(selection.catalogEntryId.toLowerCase());
    expect(() => requireAgentSelection({ ...selection, summary: "unexpected" })).toThrow();
  });
  it.each([
    { limit: "0" },
    { limit: "101" },
    { limit: "1.5" },
    { limit: ["1"] },
    { afterId: ID },
    { afterNameSortKey: "a" },
    { afterId: "slug", afterNameSortKey: "a" },
  ])("rejects invalid pagination %j", (query) => {
    expect(() => parseAgentCatalogQuery(query)).toThrow();
  });
  it.each([
    null,
    { catalogEntryId: ID },
    { catalogEntryId: ID, definitionRevisionId: "general" },
  ])("rejects unbound selections %j", (selection) => {
    expect(() => requireAgentSelection(selection)).toThrow();
  });
});
