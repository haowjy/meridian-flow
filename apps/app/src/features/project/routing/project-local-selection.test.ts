/** History pointers admit only the exact account/project/Work-owned local draft. */
import { describe, expect, it } from "vitest";
import type { ContextTab } from "@/client/stores";
import { resolveLocalDocumentSelection } from "./project-local-selection";

const tab: ContextTab = { kind: "new", documentId: "draft-a", name: "Untitled", workId: "work" };
const input = {
  accountId: "account",
  projectId: "project",
  workId: "work",
  hydrated: true,
  tabs: [tab],
  pointer: { version: 1, accountId: "account", projectId: "project", documentId: "draft-a" },
};
describe("local document history", () => {
  it("waits for hydration and then selects exactly the recorded draft", () => {
    expect(resolveLocalDocumentSelection({ ...input, hydrated: false }).kind).toBe("loading");
    expect(resolveLocalDocumentSelection(input)).toMatchObject({
      kind: "resolved",
      documentId: "draft-a",
    });
  });
  it("keeps absent distinct from stale, foreign, malformed, or wrong-Work pointers", () => {
    expect(resolveLocalDocumentSelection({ ...input, pointer: undefined }).kind).toBe("absent");
    for (const change of [
      { tabs: [] },
      { accountId: "other" },
      { projectId: "other" },
      { workId: "other" },
      { pointer: null },
      { pointer: { ...input.pointer, version: 2 } },
    ])
      expect(resolveLocalDocumentSelection({ ...input, ...change }).kind).toBe("unavailable");
  });
});
