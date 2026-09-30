/** What a registration change does to questions already out. */

import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";

import { createLinkResolution } from "./link-resolution";

const KAEL: ResolvedDocumentLink = {
  documentId: "doc-kael",
  title: "Kael",
  scheme: "manuscript",
  path: "Kael.md",
  uri: "manuscript://Kael.md",
  workId: null,
};

const never = () => new Promise<ResolvedDocumentLink | null>(() => {});

describe("createLinkResolution across generations", () => {
  it("drops a question only the decorations asked, leaving the next scan to ask it", async () => {
    const resolution = createLinkResolution();
    resolution.registerResolver(never);
    resolution.request(["[[Kael]]"]);

    const asked: string[] = [];
    resolution.registerResolver(async (target) => {
      asked.push(target.kind);
      return KAEL;
    });
    await Promise.resolve();

    expect(asked).toEqual([]);
    expect(resolution.read("[[Kael]]")).toBeNull();
  });

  it("carries a waited-on question into the new generation", async () => {
    const resolution = createLinkResolution();
    resolution.registerResolver(never);
    const answer = resolution.resolve("[[Kael]]");

    resolution.registerResolver(async () => KAEL);

    await expect(answer).resolves.toEqual({ state: "resolved", document: KAEL });
    expect(resolution.read("[[Kael]]")).toEqual({ state: "resolved", document: KAEL });
  });

  it("answers a waited-on question null when the port goes away", async () => {
    const resolution = createLinkResolution();
    const unregister = resolution.registerResolver(never);
    const answer = resolution.resolve("[[Kael]]");

    unregister();

    await expect(answer).resolves.toBeNull();
  });
});
