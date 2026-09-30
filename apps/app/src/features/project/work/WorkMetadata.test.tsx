// @vitest-environment jsdom
/** Work goal edit safety and clamped display behavior. */
import type { UpdateWorkRequest, Work } from "@meridian/contracts/works";
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useWorkMetadataController, WorkGoal } from "./WorkMetadata";

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
  const [work, setWork] = useState(WORK);
  const controller = useWorkMetadataController(work, async (data) => {
    const updated = await saveWork(data);
    setWork(updated);
    return updated;
  });
  return <WorkGoal work={work} controller={controller} />;
}
function LeaveGuardHarness({ saveWork }: { saveWork: (data: UpdateWorkRequest) => Promise<Work> }) {
  const [work, setWork] = useState(WORK);
  const [result, setResult] = useState("");
  const controller = useWorkMetadataController(work, async (data) => {
    const updated = await saveWork(data);
    setWork(updated);
    return updated;
  });
  return (
    <>
      <WorkGoal work={work} controller={controller} />
      <button
        type="button"
        onClick={() =>
          controller.request({ run: () => setResult("left"), cancel: () => setResult("kept") })
        }
      >
        Leave
      </button>
      <button type="button" onClick={controller.discardAndResume}>
        Discard and leave
      </button>
      <output>{controller.held ? "decision" : result}</output>
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
  it("does not save the goal on blur and cancels on Escape", async () => {
    const saveWork = vi.fn(async (data: UpdateWorkRequest) => ({ ...WORK, ...data }));
    await withReactRoot(<Harness saveWork={saveWork} />, async () => {
      await click(
        [...document.querySelectorAll("button")].find((button) => button.textContent === "Edit") ??
          null,
      );
      const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
      expect(textarea).not.toBeNull();
      if (!textarea) throw new Error("Goal editor did not open");
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

  it("saves the edited goal with Save", async () => {
    const saveWork = vi.fn(async (data: UpdateWorkRequest) => ({ ...WORK, ...data }));
    await withReactRoot(<Harness saveWork={saveWork} />, async () => {
      await click(
        [...document.querySelectorAll("button")].find((button) => button.textContent === "Edit") ??
          null,
      );
      const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
      if (!textarea) throw new Error("Goal editor did not open");
      await act(async () => {
        setValue(textarea, "  A changed goal  ");
      });
      await click(
        [...document.querySelectorAll("button")].find((button) => button.textContent === "Save") ??
          null,
      );
      expect(saveWork).toHaveBeenCalledWith({ goal: "A changed goal" });
      expect(document.querySelector("textarea")).toBeNull();
    });
  });

  it("holds a leave intent until a dirty goal is explicitly discarded", async () => {
    const saveWork = vi.fn(async (data: UpdateWorkRequest) => ({ ...WORK, ...data }));
    await withReactRoot(<LeaveGuardHarness saveWork={saveWork} />, async () => {
      await click(
        [...document.querySelectorAll("button")].find((button) => button.textContent === "Edit") ??
          null,
      );
      const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
      if (!textarea) throw new Error("Goal editor did not open");
      await act(async () => setValue(textarea, "Changed goal"));
      await click(
        [...document.querySelectorAll("button")].find((button) => button.textContent === "Leave") ??
          null,
      );
      expect(document.querySelector("output")?.textContent).toBe("decision");
      expect(saveWork).not.toHaveBeenCalled();
      await click(
        [...document.querySelectorAll("button")].find(
          (button) => button.textContent === "Discard and leave",
        ) ?? null,
      );
      expect(document.querySelector("output")?.textContent).toBe("left");
      expect(document.querySelector("textarea")).toBeNull();
    });
  });

  it("puts one Show more toggle before Edit when the goal is clamped", async () => {
    await withClampedGoal(async () => {
      await withReactRoot(
        <Harness saveWork={vi.fn(async (data: UpdateWorkRequest) => ({ ...WORK, ...data }))} />,
        async () => {
          const labels = () => [...document.querySelectorAll("button")].map((b) => b.textContent);
          expect(labels()).toEqual(["Show more", "Edit"]);
          const toggle = document.querySelector("button");
          expect(toggle?.getAttribute("aria-expanded")).toBe("false");
          await click(toggle);
          // The same button flips, so keyboard focus stays put.
          expect(toggle?.textContent).toBe("Show less");
          expect(toggle?.getAttribute("aria-expanded")).toBe("true");
        },
      );
    });
  });

  it("renders blank-line runs as paragraphs, not blank lines", async () => {
    await withReactRoot(
      <WorkGoalHarness work={{ ...WORK, goal: "One.\n\n\n\nTwo\nlines." }} />,
      async () => {
        expect([...document.querySelectorAll("p:not(.sr-only)")].map((p) => p.textContent)).toEqual(
          ["One.", "Two\nlines."],
        );
      },
    );
  });

  it("shows only Edit for an unclamped goal and nothing for a read-only one", async () => {
    await withReactRoot(<WorkGoalHarness work={{ ...WORK, goal: "wef" }} />, async () => {
      expect([...document.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Edit"]);
    });
    await withReactRoot(<WorkGoalHarness work={{ ...WORK, goal: "wef" }} readOnly />, async () => {
      expect(document.querySelectorAll("button")).toHaveLength(0);
      expect(document.body.textContent).toContain("wef");
    });
  });
});

function WorkGoalHarness({ work, readOnly }: { work: Work; readOnly?: boolean }) {
  const controller = useWorkMetadataController(work, async () => undefined);
  return <WorkGoal work={work} controller={controller} readOnly={readOnly} />;
}

async function withClampedGoal(run: () => Promise<void>) {
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
    await run();
  } finally {
    window.ResizeObserver = native;
  }
}
