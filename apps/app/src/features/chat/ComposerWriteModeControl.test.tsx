// @vitest-environment jsdom
/** Real write-mode adapter integration for production page focus transitions. */
import type { Work } from "@meridian/contracts/works";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerToolbar, createComposerToolbarModel } from "@/components/app/composer-toolbar";
import { setTestToolbarInlineIds } from "@/components/app/composer-toolbar/composer-toolbar-test-harness";
import { useComposerWriteModeToolbarControl } from "./ComposerWriteModeControl";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));
let groups: unknown = null;
let mutateAsync = vi.fn();
const mutate = vi.fn();
vi.mock("@/client/query/useWorkDrafts", () => ({
  useWorkDrafts: () => ({ groups, drafts: null, status: groups === null ? "loading" : "ready" }),
}));
vi.mock("@/client/query/useWorks", () => ({
  useUpdateWorkWriteMode: () => ({ isPending: false, mutate, mutateAsync }),
}));
vi.mock("./useAiDraftLauncher", () => ({ useAiDraftLauncher: () => ({ openAiDraft: vi.fn() }) }));
vi.mock("@/components/app/composer-toolbar/useMeasuredComposerToolbar", async () => ({
  useMeasuredComposerToolbar: (
    await import("@/components/app/composer-toolbar/composer-toolbar-test-harness")
  ).useTestMeasuredComposerToolbar,
}));

const work = {
  id: "work",
  projectId: "project",
  name: "Book",
  status: "active",
  aiWriteMode: "draft",
} as Work;
const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});
function Harness({ value = work }: { value?: Work }) {
  const control = useComposerWriteModeToolbarControl({ projectId: "project", work: value });
  return <ComposerToolbar model={createComposerToolbarModel([control])} ariaLabel="Options" />;
}
const findButton = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === name || button.textContent?.trim() === name,
  ) as HTMLButtonElement | undefined;

describe("useComposerWriteModeToolbarControl", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    groups = null;
    mutateAsync = vi.fn();
    setTestToolbarInlineIds("all");
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    mutate.mockClear();
  });

  it("opens unresolved Draft on the enabled Auto-apply candidate instead of BODY", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => findButton("AI write mode: Draft")?.click());
    expect(document.activeElement?.textContent).toBe("Auto-apply");
    expect(document.activeElement).not.toBe(document.body);
    expect(
      document.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.disabled,
    ).toBe(true);
  });

  it("moves choices into confirmation and failure pages without losing focus", async () => {
    groups = [
      {
        documentId: "doc",
        documentName: "Chapter",
        contextPath: "manuscript://chapter.md",
        drafts: [
          {
            draftId: "draft",
            documentId: "doc",
            status: "active",
            updatedAt: "2026-08-09T00:00:00.000Z",
          },
        ],
      },
    ];
    let reject!: (cause: Error) => void;
    mutateAsync = vi.fn(
      () =>
        new Promise((_resolve, nextReject) => {
          reject = nextReject;
        }),
    );
    await act(async () => root.render(<Harness />));
    await act(async () => findButton("AI write mode: Draft")?.click());
    await act(async () => findButton("Auto-apply")?.click());
    expect(document.body.textContent).toContain("Drafts are waiting");
    expect(document.activeElement).toBe(document.querySelector('[role="dialog"]'));
    expect(document.activeElement).not.toBe(document.body);
    await act(async () => reject(new Error("offline")));
    expect(document.body.textContent).toContain("Nothing changed");
    expect(document.activeElement?.textContent).toBe("Cancel");
  });

  it("returns to choices after a successful confirmation and on the next open", async () => {
    groups = [
      {
        documentId: "doc",
        drafts: [{ draftId: "draft", documentId: "doc", status: "active" }],
      },
    ];
    mutateAsync = vi
      .fn()
      .mockResolvedValueOnce({ status: "confirmation_required", pendingChangeCount: 1 })
      .mockResolvedValueOnce({ status: "updated" });
    await act(async () => root.render(<Harness />));
    await act(async () => findButton("AI write mode: Draft")?.click());
    await act(async () => findButton("Auto-apply")?.click());
    expect(document.body.textContent).toContain("Drafts are waiting");
    await act(async () => findButton("Apply 1 change and switch")?.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => findButton("AI write mode: Draft")?.click());
    expect(document.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("Drafts are waiting");
  });

  it("does not carry confirmation state across Work identity", async () => {
    groups = [
      {
        documentId: "doc",
        drafts: [{ draftId: "draft", documentId: "doc", status: "active" }],
      },
    ];
    mutateAsync = vi.fn().mockResolvedValue({
      status: "confirmation_required",
      pendingChangeCount: 1,
    });
    await act(async () => root.render(<Harness />));
    await act(async () => findButton("AI write mode: Draft")?.click());
    await act(async () => findButton("Auto-apply")?.click());
    expect(document.body.textContent).toContain("Drafts are waiting");
    const nextWork = { ...work, id: "other", name: "Other Book" } as Work;
    await act(async () => root.render(<Harness value={nextWork} />));
    expect(document.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("Drafts are waiting");
  });

  it("opens choices from the overflow root and returns to the write row", async () => {
    groups = [];
    setTestToolbarInlineIds([]);
    await act(async () => root.render(<Harness />));
    await act(async () => findButton("More composer controls")?.click());
    await act(async () => findButton("AI write mode: Draft")?.click());
    expect(document.activeElement?.textContent).toBe("Draft");
    await act(async () => findButton("Back")?.click());
    expect(document.activeElement?.getAttribute("aria-label")).toBe("AI write mode: Draft");
  });
});
