/** User-turn projection keeps skill `/slug` ranges in the transcript source. */
import type { Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { transcriptReferenceResolutions } from "./reference-availability";
import { projectUserTurn } from "./UserTurn";

describe("projectUserTurn", () => {
  it("places a skill range on the concatenated user text", () => {
    const projected = projectUserTurn({
      blocks: [
        {
          id: "b0",
          turnId: "t1",
          responseId: null,
          blockType: "text",
          sequence: 0,
          textContent: "use ",
          content: "use ",
          createdAt: "2020-01-01T00:00:00.000Z",
        },
        {
          id: "b1",
          turnId: "t1",
          responseId: null,
          blockType: "text",
          sequence: 1,
          textContent: "/writing-principles",
          content: {
            type: "skill",
            text: "/writing-principles",
            slug: "writing-principles",
            name: "Writing principles",
            description: "Reader reward.",
          },
          createdAt: "2020-01-01T00:00:00.000Z",
        },
      ],
    } as Turn);
    expect(projected.text).toBe("use /writing-principles");
    expect(projected.skills).toEqual([
      {
        from: 4,
        to: 23,
        slug: "writing-principles",
        name: "Writing principles",
        description: "Reader reward.",
      },
    ]);
    expect(projected.references).toEqual([]);
  });
});

describe("transcriptReferenceResolutions", () => {
  const generation = "g1" as never;
  const authority = { kind: "project", projectId: "p1" } as never;

  it("marks a document gone for this writer unavailable, so its chip draws dashed", () => {
    const projected = transcriptReferenceResolutions([
      { kind: "deleted", documentId: "d1" as never, generation, lastAuthority: authority },
      {
        kind: "authority-unavailable",
        documentId: "d2" as never,
        generation,
        authority,
        reason: "work_deleted",
      },
      { kind: "not-visible", documentId: "d3" as never, checkedGeneration: generation },
    ]);

    expect([...projected.values()]).toEqual([
      { documentId: "d1", available: false },
      { documentId: "d2", available: false },
      { documentId: "d3", available: false },
    ]);
  });

  it("leaves an indeterminate answer unsettled and keeps an available one where it lives", () => {
    const projected = transcriptReferenceResolutions([
      {
        kind: "indeterminate",
        documentId: "d4" as never,
        checkedGeneration: generation,
        reason: "identity_inconsistent",
      },
      {
        kind: "available",
        documentId: "d5" as never,
        generation,
        authority,
        entry: { uri: "kb://cast/Kael.md", name: "Kael" } as never,
      },
    ]);

    expect(projected.has("d4")).toBe(false);
    expect(projected.get("d5")).toEqual({
      documentId: "d5",
      uri: "kb://cast/Kael.md",
      label: "Kael",
      available: true,
    });
  });
});
