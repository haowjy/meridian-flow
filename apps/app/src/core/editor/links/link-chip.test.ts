/** Which chip a link draws: state and family icon per target and answer. */

import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";

import { linkChip, referenceChip } from "./link-chip";
import type { LinkResolutionEntry } from "./link-resolution";
import type { LinkTarget } from "./link-target";

const KB_KAEL: ResolvedDocumentLink = {
  documentId: "doc-kael",
  title: "Kael",
  scheme: "kb",
  path: "characters/Kael.md",
  uri: "kb://characters/Kael.md",
  workId: null,
};

const scratch: LinkTarget = { kind: "scheme", uri: "scratch://@revision-pass/notes.md" };
const relative: LinkTarget = { kind: "relative", path: "../cast/Kael.md" };

const resolved: LinkResolutionEntry = { state: "resolved", document: KB_KAEL };
const unresolved: LinkResolutionEntry = { state: "unresolved", document: null };
const pending: LinkResolutionEntry = { state: "pending", document: null };

describe("linkChip", () => {
  it("shows the family of the document a link resolved to", () => {
    expect(linkChip(scratch, resolved)).toEqual({ state: "filled", icon: "kb" });
    expect(linkChip(relative, resolved)).toEqual({ state: "filled", icon: "kb" });
  });

  it("keeps an address's own family when nothing is there", () => {
    expect(linkChip(scratch, unresolved)).toEqual({ state: "dashed", icon: "scratch" });
    expect(linkChip(relative, unresolved, "manuscript://chapters/one.md")).toEqual({
      state: "dashed",
      icon: "manuscript",
    });
  });

  it("draws a relative link with no holder yet generic, dashed only once nothing is there", () => {
    expect(linkChip(relative, pending)).toEqual({ state: "filled", icon: "file" });
    expect(linkChip(relative, null)).toEqual({ state: "filled", icon: "file" });
    expect(linkChip(relative, unresolved)).toEqual({ state: "dashed", icon: "file" });
  });

  it("knows an address's family before it resolves", () => {
    expect(linkChip(scratch, pending)).toEqual({ state: "filled", icon: "scratch" });
    expect(linkChip(relative, null, "kb://notes/index.md")).toEqual({
      state: "filled",
      icon: "kb",
    });
    expect(linkChip(relative, null)).toEqual({ state: "filled", icon: "file" });
  });

  it("leaves external links to the underline", () => {
    expect(linkChip({ kind: "external", url: "https://example.com/" }, null)).toBeNull();
  });
});

describe("referenceChip", () => {
  it("names an exact reference by its URI, dashed once its document is gone", () => {
    expect(referenceChip("uploads://@/map.png")).toEqual({ state: "filled", icon: "uploads" });
    expect(referenceChip("user://style.md", false)).toEqual({ state: "dashed", icon: "user" });
  });
});
