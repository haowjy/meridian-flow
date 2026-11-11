/** History pointers admit only the exact account/project local document the replica holds. */
import { describe, expect, it } from "vitest";
import type { ContextTab } from "@/client/stores";
import { resolveLocalDocumentSelection } from "./project-local-selection";

const tab: ContextTab = {
  kind: "new",
  documentId: "draft-a",
  name: "Untitled",
  resourceHandle: "resource-draft-a",
};
const holding =
  (...documents: Extract<ContextTab, { kind: "new" }>[]) =>
  (resourceHandle: string) =>
    documents.find((document) => document.resourceHandle === resourceHandle) ?? null;
const input = {
  accountId: "account",
  projectId: "project",
  documentOf: holding(tab),
  pointer: {
    version: 2,
    accountId: "account",
    projectId: "project",
    resourceHandle: "resource-draft-a",
  },
};
describe("local document history", () => {
  it("keeps absent distinct from stale, foreign, malformed, pointers", () => {
    expect(resolveLocalDocumentSelection({ ...input, pointer: undefined }).kind).toBe("absent");
    expect(resolveLocalDocumentSelection({ ...input, documentOf: null }).kind).toBe("loading");
    for (const change of [
      { documentOf: holding() },
      { accountId: "other" },
      { projectId: "other" },
      { pointer: null },
      { pointer: { ...input.pointer, version: 1 } },
    ])
      expect(resolveLocalDocumentSelection({ ...input, ...change }).kind).toBe("unavailable");
  });
  it("follows a reminted document through its stable resource handle", () => {
    const reminted = { ...tab, documentId: "draft-b" };
    expect(
      resolveLocalDocumentSelection({ ...input, documentOf: holding(reminted) }),
    ).toMatchObject({ kind: "resolved", documentId: "draft-b", document: reminted });
  });
});
