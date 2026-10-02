/** Where Create puts the document a missing link addresses. */
import { describe, expect, it } from "vitest";

import { linkCreationTarget, scratchWork } from "./use-create-linked-document";

describe("linkCreationTarget", () => {
  it.each([
    [
      "manuscript://volume-2/Lin Mei.md",
      { scheme: "manuscript", folderPath: "volume-2", name: "Lin Mei.md" },
    ],
    [
      "manuscript://volume-2/chapter-3",
      { scheme: "manuscript", folderPath: "volume-2", name: "chapter-3.md" },
    ],
    ["kb://characters/Lin Feng", { scheme: "kb", folderPath: "characters", name: "Lin Feng.md" }],
    ["user://style.md", { scheme: "user", folderPath: "", name: "style.md" }],
    [
      "scratch://@revision/notes/plan.md",
      { scheme: "scratch", folderPath: "notes", name: "plan.md" },
    ],
    ["scratch://@/plan", { scheme: "scratch", folderPath: "", name: "plan.md" }],
    ["scratch://plan.md", { scheme: "scratch", folderPath: "", name: "plan.md" }],
  ])("creates %s at exactly that address", (address, expected) => {
    expect(linkCreationTarget(address)).toMatchObject(expected);
  });

  it.each([
    "uploads://@/map.png",
    "unfiled://loose.md",
    "manuscript://",
    "manuscript://bad:name.md",
  ])("refuses %s", (address) => {
    expect(linkCreationTarget(address)).toBeNull();
  });

  it("refuses a link with no address", () => {
    expect(linkCreationTarget(null)).toBeNull();
  });
});

describe("scratchWork", () => {
  const works = [{ id: "work-revision", slug: "revision" }];
  const target = (address: string) => {
    const created = linkCreationTarget(address);
    if (!created) throw new Error(`not creatable: ${address}`);
    return created;
  };

  it("puts a qualified Scratch address in the Work its slug names", () => {
    expect(scratchWork(target("scratch://@revision/plan.md"), null, works, "no-work")).toEqual({
      workId: "work-revision",
      workSlug: "revision",
    });
  });

  it("puts `@/` in No Work", () => {
    expect(scratchWork(target("scratch://@/plan.md"), "work-revision", works, "no-work")).toEqual({
      workId: null,
    });
  });

  it("puts a contextual Scratch address in the surface's Work", () => {
    expect(scratchWork(target("scratch://plan.md"), "work-revision", works, "no-work")).toEqual({
      workId: "work-revision",
      workSlug: "revision",
    });
    expect(scratchWork(target("scratch://plan.md"), "no-work", works, "no-work")).toEqual({
      workId: null,
    });
    expect(scratchWork(target("scratch://plan.md"), null, works, "no-work")).toEqual({
      workId: null,
    });
  });

  it("refuses a Work the project does not have", () => {
    expect(scratchWork(target("scratch://@gone/plan.md"), null, works, "no-work")).toBe("unknown");
  });

  it("leaves project and user schemes without a Work", () => {
    expect(scratchWork(target("kb://plan.md"), "work-revision", works, "no-work")).toEqual({
      workId: null,
    });
  });
});
