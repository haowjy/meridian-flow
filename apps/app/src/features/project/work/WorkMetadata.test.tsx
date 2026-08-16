// @vitest-environment jsdom
import type { UpdateWorkRequest, Work } from "@meridian/contracts/works";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useWorkMetadataController, WorkMetadata } from "./WorkMetadata";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));

describe("WorkMetadata", () => {
  it("normalizes unchanged Name without a request and restores display focus", async () => {
    const save = vi.fn();
    await withReactRoot(<Harness save={save} />, async () => {
      click("Edit Work name");
      change(input(), "  Work A  ");
      await press(input(), "Enter");
      expect(save).not.toHaveBeenCalled();
      expect(document.activeElement?.textContent).toContain("Work A");
    });
  });

  it("sends one field, adopts the returned Work, and announces success", async () => {
    const save = vi.fn(async (data) => ({ ...fixture(), ...data, goal: "Returned goal" }));
    await withReactRoot(<Harness save={save} />, async () => {
      click("Add a goal");
      change(textarea(), "New goal");
      await press(textarea(), "Enter", { ctrlKey: true });
      expect(save).toHaveBeenCalledWith({ goal: "New goal" });
      expect(document.body.textContent).toContain("Returned goal");
      expect(document.body.textContent).toContain("Goal saved");
    });
  });

  it("retains a failed draft for retry and preserves the held field-switch intent", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce({ ...fixture(), goal: "New goal" });
    await withReactRoot(<Harness save={save} />, async () => {
      click("Add a goal");
      change(textarea(), "New goal");
      click("Add a description");
      expect(document.body.textContent).toContain("Save metadata changes?");
      click("Save changes");
      await tick();
      expect(document.body.textContent).toContain("Offline");
      expect(textarea().value).toBe("New goal");
      click("Save changes");
      await tick();
      expect(document.activeElement).toBe(textarea());
    });
  });
});

function Harness({ save }: { save: (data: UpdateWorkRequest) => Promise<Work> }) {
  const controller = useWorkMetadataController(fixture(), save);
  return (
    <>
      <WorkMetadata controller={controller} />
      {controller.held ? (
        <div>
          <span>Save metadata changes?</span>
          <button type="button" onClick={() => void controller.saveAndResume()}>
            Save changes
          </button>
          <button type="button" onClick={controller.discardAndResume}>
            Discard changes
          </button>
          <button type="button" onClick={controller.keepEditing}>
            Keep editing
          </button>
        </div>
      ) : null}
    </>
  );
}
function fixture(): Work {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "project-1",
    createdByUserId: "user-1",
    name: "Work A",
    slug: "work-a",
    goal: null,
    description: null,
    status: "active",
    archivedAt: null,
    deletedAt: null,
    aiWriteMode: "draft",
    unpushedChangeCount: 0,
    lastActivityAt: "2026-08-15T00:00:00.000Z",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  };
}
function click(label: string) {
  const node = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.includes(label) || item.getAttribute("aria-label") === label,
  );
  if (!node) throw new Error(`missing ${label}`);
  act(() => (node as HTMLButtonElement).click());
}
function input() {
  const node = document.querySelector("input");
  if (!node) throw new Error("missing input");
  return node;
}
function textarea() {
  const node = document.querySelector("textarea");
  if (!node) throw new Error("missing textarea");
  return node;
}
function change(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    node.tagName === "INPUT"
      ? window.HTMLInputElement.prototype
      : window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function press(node: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
}
async function tick() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
