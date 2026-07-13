import { beforeEach, describe, expect, it } from "vitest";
import { isEmptyTempDocument, nextUntitledName, useTempDocsStore } from "./temp-docs-store";

beforeEach(() => {
  useTempDocsStore.setState({ byProject: {} });
});

describe("temporary documents", () => {
  it("fills the first available untitled suffix", () => {
    expect(nextUntitledName([])).toBe("Untitled");
    expect(
      nextUntitledName([
        { id: "a", name: "Untitled", content: {}, revision: 0 },
        { id: "b", name: "Untitled 2", content: {}, revision: 0 },
        { id: "c", name: "Untitled 4", content: {}, revision: 0 },
      ]),
    ).toBe("Untitled 3");
  });

  it("creates, updates, and removes project-local documents", () => {
    const created = useTempDocsStore.getState().createTemp("project-a");
    useTempDocsStore.getState().updateTemp("project-a", created.id, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Draft" }] }],
    });
    expect(useTempDocsStore.getState().byProject["project-a"]?.[0]?.content).toMatchObject({
      type: "doc",
    });
    expect(useTempDocsStore.getState().byProject["project-a"]?.[0]?.revision).toBe(1);
    useTempDocsStore.getState().updateSaveName("project-a", created.id, "opening-line", true);
    expect(useTempDocsStore.getState().byProject["project-a"]?.[0]).toMatchObject({
      saveName: "opening-line",
      saveNameOwned: true,
    });
    useTempDocsStore.getState().removeTemp("project-a", created.id);
    expect(useTempDocsStore.getState().byProject["project-a"]).toEqual([]);
  });

  it("recognizes only the canonical blank editor document as empty", () => {
    expect(
      isEmptyTempDocument({ content: { type: "doc", content: [{ type: "paragraph" }] } }),
    ).toBe(true);
    expect(
      isEmptyTempDocument({
        content: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Words" }] }],
        },
      }),
    ).toBe(false);
  });
});
