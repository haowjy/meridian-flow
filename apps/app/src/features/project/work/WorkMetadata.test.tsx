// @vitest-environment jsdom
/** Work goal edit safety and clamped display behavior. */
import type { UpdateWorkRequest, Work } from "@meridian/contracts/works";
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { MeridianApiError } from "@/client/api/http-client";
import { typeInto, withReactRoot } from "@/test-support/react-dom-harness";
import { useWorkMetadataController, WorkGoal } from "./WorkMetadata";

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
        typeInto(textarea, "Unfinished draft");
        textarea.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      });
      expect(saveWork).not.toHaveBeenCalled();
      await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(document.querySelector("textarea")).toBeNull();
      expect(document.body.textContent).toContain("First paragraph.");

      await click(
        [...document.querySelectorAll("button")].find(
          (button) => button.textContent === "Edit goal",
        ) ?? null,
      );
      const reopened = document.querySelector<HTMLTextAreaElement>("textarea");
      if (!reopened) throw new Error("Goal editor did not reopen");
      await act(async () => typeInto(reopened, "  A changed goal  "));
      await click(
        [...document.querySelectorAll("button")].find((button) => button.textContent === "Save") ??
          null,
      );
      expect(saveWork).toHaveBeenCalledWith({ goal: "A changed goal" });
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
      await act(async () => typeInto(textarea, "Changed goal"));
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
      await act(async () => typeInto(textarea, "Changed goal"));
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

  it("keeps the draft and hides the raw error when an archived Work rejects a goal save", async () => {
    const cause = refusal("work_archived", 409);
    const saveWork = vi.fn(async (): Promise<Work> => {
      throw cause;
    });
    await withReactRoot(<Harness saveWork={saveWork} />, async () => {
      const button = (label: string) =>
        [...document.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;
      await click(button("Edit goal"));
      const field = document.querySelector("textarea");
      if (!field) throw new Error("goal field missing");
      await act(async () => typeInto(field, "A changed goal"));
      await click(button("Save"));
      const alert = document.querySelector('[role="alert"]');
      expect(alert?.textContent).not.toContain(cause.message);
      expect(document.body.textContent).not.toContain(cause.message);
      // The draft stays so the writer can retry.
      expect(document.querySelector("textarea")?.value).toBe("A changed goal");
    });
  });
});
