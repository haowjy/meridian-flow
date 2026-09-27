// @vitest-environment jsdom
/** Work metadata editing behavior for the retained name and goal fields. */
import type { UpdateWorkRequest, Work } from "@meridian/contracts/works";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useWorkMetadataController, WorkMetadata } from "./WorkMetadata";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const WORK: Work = {
  id: "work-1" as Work["id"],
  projectId: "project-1" as Work["projectId"],
  createdByUserId: "user-1" as Work["createdByUserId"],
  name: "Arc",
  slug: "arc" as Work["slug"],
  isNoWork: false,
  goal: "Reach the mirror",
  status: "active",
  archivedAt: null,
  aiWriteMode: "direct",
  entityRevision: "1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  lastActivityAt: "2026-09-01T00:00:00.000Z",
  deletedAt: null,
};

function WorkMetadataHarness({
  saveWork,
}: {
  saveWork: (data: UpdateWorkRequest) => Promise<Work>;
}) {
  const controller = useWorkMetadataController(WORK, saveWork);
  return <WorkMetadata controller={controller} />;
}

describe("WorkMetadata", () => {
  it("saves edited goal text without flattening its paragraphs", async () => {
    const saveWork = vi.fn(async (data: UpdateWorkRequest) => ({
      ...WORK,
      ...data,
      updatedAt: "2026-09-02T00:00:00.000Z",
    }));

    await withReactRoot(<WorkMetadataHarness saveWork={saveWork} />, async () => {
      const goalButton = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === WORK.goal,
      );
      await act(async () => goalButton?.click());

      const editor = document.querySelector<HTMLTextAreaElement>("textarea");
      expect(editor).not.toBeNull();
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      await act(async () => {
        valueSetter?.call(editor, "First paragraph.\n\nSecond paragraph.");
        editor?.dispatchEvent(new Event("input", { bubbles: true }));
      });

      const saveButton = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Save goal",
      );
      await act(async () => saveButton?.click());

      expect(saveWork).toHaveBeenCalledWith({ goal: "First paragraph.\n\nSecond paragraph." });
      expect(document.body.textContent).toContain("First paragraph.\n\nSecond paragraph.");
    });
  });
});
