import { importNodeId } from "@meridian/contracts";
import { expect, it } from "vitest";

/** The browser predicts rows with the id the server's plan derives; this is that vector. */
it("derives the server's id in the app runtime", async () => {
  expect(
    await importNodeId({
      projectId: "11111111-1111-4111-8111-111111111111",
      importId: "22222222-2222-4222-8222-222222222222",
      rootId: 1,
      kind: "entry",
      path: "Café/Lore.md",
    }),
  ).toBe("ffed76e1-f1c3-89d8-ba5f-19f0a4ed5651");
});
