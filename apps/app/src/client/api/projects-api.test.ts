/** HTTP-shape regression coverage for project context API adapters. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { renameContextEntry } from "./projects-api";

describe("renameContextEntry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps Nitro's real 409 body shape to the conflict result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: 409, statusText: "Conflict", message: "exists" }), {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(
      renameContextEntry("project-1", "scratch", { path: "/Untitled", newName: "Chapter" }),
    ).resolves.toEqual({ status: "conflict" });
  });

  it("maps the canonical success body to the renamed result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "renamed" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(
      renameContextEntry("project-1", "scratch", { path: "/Untitled", newName: "Chapter" }),
    ).resolves.toEqual({ status: "renamed" });
  });
});
