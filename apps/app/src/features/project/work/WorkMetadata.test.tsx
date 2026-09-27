// @vitest-environment jsdom
/** Work metadata edit safety and clamped description behavior. */
import type { UpdateWorkRequest, Work } from "@meridian/contracts/works";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useWorkMetadataController, WorkDescription, WorkName } from "./WorkMetadata";

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
  goal: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
  status: "active",
  archivedAt: null,
  aiWriteMode: "direct",
  entityRevision: "1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  lastActivityAt: "2026-09-01T00:00:00.000Z",
  deletedAt: null,
};
function Harness({ saveWork }: { saveWork: (data: UpdateWorkRequest) => Promise<Work> }) {
  const controller = useWorkMetadataController(WORK, saveWork);
  return (
    <>
      <WorkName controller={controller} />
      <WorkDescription controller={controller} />
    </>
  );
}
function setValue(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")?.set;
  setter?.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
}
async function click(node: Element | null) {
  await act(async () => {
    node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("WorkMetadata", () => {
  it("saves the name on blur and requires a non-empty value", async () => {
    const saveWork = vi.fn(async (data: UpdateWorkRequest) => ({ ...WORK, ...data }));
    await withReactRoot(<Harness saveWork={saveWork} />, async () => {
      await click(document.querySelector("h1 button"));
      const input = document.querySelector<HTMLInputElement>("input");
      expect(input).not.toBeNull();
      if (!input) throw new Error("Name editor did not open");
      await act(async () => {
        setValue(input, "Renamed arc");
        input.blur();
      });
      expect(saveWork).toHaveBeenCalledWith({ name: "Renamed arc" });
    });
  });

  it("does not save the description on blur and cancels on Escape", async () => {
    const saveWork = vi.fn(async (data: UpdateWorkRequest) => ({ ...WORK, ...data }));
    await withReactRoot(<Harness saveWork={saveWork} />, async () => {
      await click(
        [...document.querySelectorAll("button")].find((button) =>
          button.textContent?.startsWith("First paragraph"),
        ) ?? null,
      );
      const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
      expect(textarea).not.toBeNull();
      if (!textarea) throw new Error("Description editor did not open");
      await act(async () => {
        setValue(textarea, "Unfinished draft");
        textarea.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      });
      expect(saveWork).not.toHaveBeenCalled();
      await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(document.querySelector("textarea")).toBeNull();
      expect(document.body.textContent).toContain("First paragraph.");
    });
  });

  it("keeps only one field in edit mode while guarding a dirty description", async () => {
    const saveWork = vi.fn(async (data: UpdateWorkRequest) => ({ ...WORK, ...data }));
    await withReactRoot(<Harness saveWork={saveWork} />, async () => {
      await click(
        [...document.querySelectorAll("button")].find((button) =>
          button.textContent?.startsWith("First paragraph"),
        ) ?? null,
      );
      const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
      expect(textarea).not.toBeNull();
      if (!textarea) throw new Error("Description editor did not open");
      await act(async () => {
        setValue(textarea, "A changed description");
      });
      await click(document.querySelector("h1 button"));
      expect(document.querySelectorAll("textarea")).toHaveLength(1);
      expect(document.querySelectorAll("input")).toHaveLength(0);
      expect(document.querySelector("textarea")).not.toBeNull();
    });
  });

  it("exposes the clamp toggle only for measured overflow", async () => {
    const native = window.ResizeObserver;
    window.ResizeObserver = class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        Object.defineProperty(target, "scrollHeight", { configurable: true, value: 120 });
        Object.defineProperty(target, "clientHeight", { configurable: true, value: 72 });
        this.callback([], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      await withReactRoot(
        <Harness saveWork={vi.fn(async (data: UpdateWorkRequest) => ({ ...WORK, ...data }))} />,
        async () => {
          expect(document.body.textContent).toContain("Show more");
          await click(
            [...document.querySelectorAll("button")].find(
              (button) => button.textContent === "Show more",
            ) ?? null,
          );
          expect(document.body.textContent).toContain("Show less");
        },
      );
    } finally {
      window.ResizeObserver = native;
    }
  });
});
