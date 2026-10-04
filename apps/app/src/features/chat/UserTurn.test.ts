/** User-turn projection keeps skill `/slug` ranges in the transcript source. */
import type { Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
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
