/** Risk: two schema instances make equal text unequal, and a rebase invents blocks between them. */
import { describe, expect, it } from "vitest";
import { buildDocumentSchema } from "./index.js";

describe("document schema", () => {
  it("is one instance, so nodes built by different modules compare equal", () => {
    const a = buildDocumentSchema();
    const b = buildDocumentSchema();
    expect(a).toBe(b);
    expect(
      a.node("paragraph", null, [a.text("same")]).eq(b.node("paragraph", null, [b.text("same")])),
    ).toBe(true);
  });
});
