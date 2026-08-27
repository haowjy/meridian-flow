/** Browser untitled recovery reads the complete catalog before choosing a Work. */
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it, vi } from "vitest";
import { resolveUntitledCatalogHome } from "./untitled-reconciler-browser";

const archived = { id: "archived-work", status: "archived" } as Work;

describe("resolveUntitledCatalogHome", () => {
  it("recovers into the first available archived Work and requests all statuses", async () => {
    const listWorks = vi.fn(async () => ({ works: [archived] }));

    await expect(resolveUntitledCatalogHome("project", listWorks)).resolves.toEqual({
      scheme: "scratch",
      workId: archived.id,
    });
    expect(listWorks).toHaveBeenCalledWith("project", { status: "all" });
  });

  it("returns no recovery home for an authoritative empty catalog", async () => {
    const listWorks = vi.fn(async () => ({ works: [] }));

    await expect(resolveUntitledCatalogHome("project", listWorks)).resolves.toBeNull();
  });
});
