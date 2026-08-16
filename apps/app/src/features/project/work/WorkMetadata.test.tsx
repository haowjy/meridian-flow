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
  it.each([
    ["name", "Edit Work name", "  Renamed Work  ", { name: "Renamed Work" }],
    ["goal", "Add a goal", "  Finish act two  ", { goal: "Finish act two" }],
    [
      "description",
      "Add a description",
      "  A quiet description  ",
      { description: "A quiet description" },
    ],
  ] as const)("commits a normalized %s with an exact one-field body", async (field, label, value, body) => {
    const save = vi.fn(async (data) => ({ ...fixture(), ...data }));
    await withReactRoot(<Harness save={save} />, async () => {
      click(label);
      const editor = field === "name" ? input() : textarea();
      change(editor, value);
      if (field === "name") await press(editor, "Enter");
      else click(`Save ${field}`);
      await tick();
      expect(save).toHaveBeenCalledOnce();
      expect(save).toHaveBeenCalledWith(body);
      const announcement =
        field === "name" ? "Work name saved" : `${field[0]?.toUpperCase()}${field.slice(1)} saved`;
      expect(document.body.textContent).toContain(announcement);
      expect(document.activeElement?.textContent).toContain(
        field === "name" ? "Renamed Work" : Object.values(body)[0],
      );
    });
  });

  it.each([
    ["goal", "Goal text", "Goal text", { goal: null }],
    ["description", "Description text", "Description text", { description: null }],
  ] as const)("clears optional %s to null", async (field, initial, label, body) => {
    const save = vi.fn(async (data) => ({ ...fixture({ [field]: initial }), ...data }));
    await withReactRoot(<Harness save={save} work={fixture({ [field]: initial })} />, async () => {
      click(label);
      change(textarea(), "   ");
      click(`Save ${field}`);
      await tick();
      expect(save).toHaveBeenCalledWith(body);
    });
  });

  it("keeps required Name open when its normalized value is empty", async () => {
    const save = vi.fn();
    await withReactRoot(<Harness save={save} />, async () => {
      click("Edit Work name");
      change(input(), "   ");
      await press(input(), "Enter");
      expect(save).not.toHaveBeenCalled();
      expect(input().getAttribute("aria-describedby")).toBe("work-name-error");
      expect(document.querySelector("[role=alert]")?.textContent).toContain("required");
    });
  });

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

  it.each([
    ["Goal text", "Goal text", "  Goal text  "],
    ["Description text", "Description text", "  Description text  "],
  ])("normalizes unchanged optional metadata without a request", async (label, initial, draft) => {
    const field = label.startsWith("Goal") ? "goal" : "description";
    const save = vi.fn();
    await withReactRoot(<Harness save={save} work={fixture({ [field]: initial })} />, async () => {
      click(label);
      change(textarea(), draft);
      click(`Save ${field}`);
      await tick();
      expect(save).not.toHaveBeenCalled();
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

  it("inserts ordinary textarea Enter, saves on Mod+Enter, and ignores IME shortcuts", async () => {
    const save = vi.fn(async (data) => ({ ...fixture(), ...data }));
    await withReactRoot(<Harness save={save} />, async () => {
      click("Add a goal");
      change(textarea(), "Draft");
      await press(textarea(), "Enter");
      expect(save).not.toHaveBeenCalled();
      await press(textarea(), "Enter", { ctrlKey: true, isComposing: true });
      expect(save).not.toHaveBeenCalled();
      await press(textarea(), "Enter", { metaKey: true });
      expect(save).toHaveBeenCalledOnce();
    });
  });

  it("ignores Name Enter and Escape while IME composition is active", async () => {
    const save = vi.fn(async (data) => ({ ...fixture(), ...data }));
    await withReactRoot(<Harness save={save} />, async () => {
      click("Edit Work name");
      change(input(), "Composing");
      await press(input(), "Enter", { isComposing: true });
      await press(input(), "Escape", { isComposing: true });
      expect(save).not.toHaveBeenCalled();
      expect(input().value).toBe("Composing");
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
      expect(save).toHaveBeenCalledTimes(2);
    });
  });

  it.each(["Discard changes", "Keep editing"])("resolves a held intent with %s", async (choice) => {
    const save = vi.fn();
    const canceled = vi.fn();
    const resumed = vi.fn();
    await withReactRoot(
      <IntentHarness save={save} canceled={canceled} resumed={resumed} />,
      async () => {
        click("Add a goal");
        change(textarea(), "Local draft");
        click("Leave detail");
        click(choice);
        await tick();
        if (choice === "Discard changes") {
          expect(resumed).toHaveBeenCalledOnce();
          expect(document.body.textContent).toContain("Add a goal");
        } else {
          expect(canceled).toHaveBeenCalledOnce();
          expect(textarea().value).toBe("Local draft");
          expect(document.activeElement).toBe(textarea());
        }
        expect(save).not.toHaveBeenCalled();
      },
    );
  });

  it("holds navigation during a save and runs the exact held intent once after success", async () => {
    const pending = deferred<Work>();
    const resumed = vi.fn();
    const save = vi.fn(() => pending.promise);
    await withReactRoot(<IntentHarness save={save} resumed={resumed} />, async () => {
      click("Add a goal");
      change(textarea(), "New goal");
      click("Save goal");
      click("Leave detail");
      expect(save).toHaveBeenCalledOnce();
      expect(resumed).not.toHaveBeenCalled();
      expect(button("Save changes").disabled).toBe(true);
      await act(async () => pending.resolve(fixture({ goal: "New goal" })));
      await tick();
      expect(save).toHaveBeenCalledOnce();
      expect(resumed).toHaveBeenCalledOnce();
    });
  });
});

function Harness({
  save,
  work = fixture(),
}: {
  save: (data: UpdateWorkRequest) => Promise<Work>;
  work?: Work;
}) {
  const controller = useWorkMetadataController(work, save);
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
function IntentHarness({
  save,
  canceled = vi.fn(),
  resumed,
}: {
  save: (data: UpdateWorkRequest) => Promise<Work>;
  canceled?: () => void;
  resumed: () => void;
}) {
  const controller = useWorkMetadataController(fixture(), save);
  return (
    <>
      <WorkMetadata controller={controller} />
      <button
        type="button"
        onClick={() =>
          controller.request({ label: "Leave detail", run: resumed, cancel: canceled })
        }
      >
        Leave detail
      </button>
      {controller.held ? (
        <div>
          <span>Save metadata changes?</span>
          <button
            type="button"
            disabled={controller.saving}
            onClick={() => void controller.saveAndResume()}
          >
            Save changes
          </button>
          <button type="button" disabled={controller.saving} onClick={controller.discardAndResume}>
            Discard changes
          </button>
          <button type="button" disabled={controller.saving} onClick={controller.keepEditing}>
            Keep editing
          </button>
        </div>
      ) : null}
    </>
  );
}
function fixture(overrides: Partial<Work> = {}): Work {
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
    ...overrides,
  };
}
function click(label: string) {
  const node = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.includes(label) || item.getAttribute("aria-label") === label,
  );
  if (!node) throw new Error(`missing ${label}`);
  act(() => (node as HTMLButtonElement).click());
}
function button(label: string): HTMLButtonElement {
  const node = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.includes(label) || item.getAttribute("aria-label") === label,
  );
  if (!(node instanceof window.HTMLButtonElement)) throw new Error(`missing ${label}`);
  return node;
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
