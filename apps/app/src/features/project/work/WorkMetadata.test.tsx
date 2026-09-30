// @vitest-environment jsdom
/** Work goal edit safety and clamped display behavior. */
import type { UpdateWorkRequest, Work } from "@meridian/contracts/works";
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { MeridianApiError } from "@/client/api/http-client";
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
  status: null,
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
      <button
        type="button"
        onClick={() =>
          setWork((current) => ({ ...current, archivedAt: "2026-09-02T00:00:00.000Z" }))
        }
      >
        Archive
      </button>
      <output>{controller.held ? "decision" : result}</output>
    </>
  );
}
function refusal(code: string, status: number) {
  return new MeridianApiError(
    { code, message: `raw ${code}`, retryable: false, source: "system" },
    status,
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
        [...document.querySelectorAll("button")].find(
          (button) => button.textContent === "Edit goal",
        ) ?? null,
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

  it("offers Cancel then Save under the field and saves the edited goal with Save", async () => {
    const saveWork = vi.fn(async (data: UpdateWorkRequest) => ({ ...WORK, ...data }));
    await withReactRoot(<Harness saveWork={saveWork} />, async () => {
      await click(
        [...document.querySelectorAll("button")].find(
          (button) => button.textContent === "Edit goal",
        ) ?? null,
      );
      const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
      if (!textarea) throw new Error("Goal editor did not open");
      // Cancel comes first, so it lands where Edit goal was.
      expect(
        [...(textarea.parentElement?.querySelectorAll("button") ?? [])].map((b) => b.textContent),
      ).toEqual(["Cancel", "Save"]);
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
        [...document.querySelectorAll("button")].find(
          (button) => button.textContent === "Edit goal",
        ) ?? null,
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

  it("drops a dirty goal edit and its held leave when the Work is archived", async () => {
    const saveWork = vi.fn(async (data: UpdateWorkRequest) => ({ ...WORK, ...data }));
    await withReactRoot(<LeaveGuardHarness saveWork={saveWork} />, async () => {
      const button = (label: string) =>
        [...document.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;
      await click(button("Edit goal"));
      const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
      if (!textarea) throw new Error("Goal editor did not open");
      await act(async () => setValue(textarea, "Changed goal"));
      await click(button("Leave"));
      expect(document.querySelector("output")?.textContent).toBe("decision");
      await click(button("Archive"));
      // Nothing is left to save, so the held leave is dropped and a new one runs at once.
      expect(document.querySelector("output")?.textContent).toBe("kept");
      expect(document.querySelector("textarea")).toBeNull();
      await click(button("Leave"));
      expect(document.querySelector("output")?.textContent).toBe("left");
      expect(saveWork).not.toHaveBeenCalled();
    });
  });

  it.each([
    [new TypeError("Failed to fetch"), "Couldn’t save the goal. Try again."],
    [refusal("work_archived", 409), "This Work is archived. Unarchive it to edit."],
    [refusal("work_not_found", 404), "This Work no longer exists."],
  ])("shows writer copy, not the raw error, when a goal save fails (%s)", async (cause, copy) => {
    const saveWork = vi.fn(async (): Promise<Work> => {
      throw cause;
    });
    await withReactRoot(<Harness saveWork={saveWork} />, async () => {
      const button = (label: string) =>
        [...document.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;
      await click(button("Edit goal"));
      const field = document.querySelector("textarea");
      if (!field) throw new Error("goal field missing");
      await act(async () => setValue(field, "A changed goal"));
      await click(button("Save"));
      const alert = document.querySelector('[role="alert"]');
      expect(alert?.textContent).toBe(copy);
      expect(document.body.textContent).not.toContain(cause.message);
      // The draft stays so the writer can retry.
      expect(document.querySelector("textarea")?.value).toBe("A changed goal");
    });
  });

  it("puts one Show more toggle before Edit goal when the goal is clamped", async () => {
    await withClampedGoal(async () => {
      await withReactRoot(
        <Harness saveWork={vi.fn(async (data: UpdateWorkRequest) => ({ ...WORK, ...data }))} />,
        async () => {
          const labels = () => [...document.querySelectorAll("button")].map((b) => b.textContent);
          expect(labels()).toEqual(["Show more", "Edit goal"]);
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

  it("drops Show less when an expanded goal is saved short", async () => {
    await withClampedGoal(async () => {
      await withReactRoot(
        <Harness saveWork={vi.fn(async (data: UpdateWorkRequest) => ({ ...WORK, ...data }))} />,
        async () => {
          const button = (label: string) =>
            [...document.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;
          await click(button("Show more"));
          await click(button("Edit goal"));
          const field = document.querySelector("textarea");
          if (!field) throw new Error("goal field missing");
          await act(async () => setValue(field, "Short."));
          await click(button("Save"));
          expect([...document.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
            "Edit goal",
          ]);
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

  it("shows only Edit goal for an unclamped goal and nothing for a read-only one", async () => {
    await withReactRoot(<WorkGoalHarness work={{ ...WORK, goal: "wef" }} />, async () => {
      expect([...document.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
        "Edit goal",
      ]);
    });
    const archived = { ...WORK, goal: "wef", archivedAt: "2026-09-02T00:00:00.000Z" };
    await withReactRoot(<WorkGoalHarness work={archived} />, async () => {
      expect(document.querySelectorAll("button")).toHaveLength(0);
      expect(document.body.textContent).toContain("wef");
    });
  });
});

function WorkGoalHarness({ work }: { work: Work }) {
  const controller = useWorkMetadataController(work, async () => undefined);
  return <WorkGoal work={work} controller={controller} />;
}

async function withClampedGoal(run: () => Promise<void>) {
  const native = window.ResizeObserver;
  window.ResizeObserver = class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      // Only a goal longer than a few words overflows three lines.
      Object.defineProperty(target, "scrollHeight", {
        configurable: true,
        get: () => ((target.textContent?.length ?? 0) > 20 ? 120 : 72),
      });
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
