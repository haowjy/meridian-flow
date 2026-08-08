// @vitest-environment jsdom
/** Pending-draft signal and review resolution entry for the composer mode control. */
import type { Work } from "@meridian/contracts/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { withReactRoot } from "@/test-support/react-dom-harness";

const openAiDraft = vi.fn();
const mutate = vi.fn();
const mutateAsync = vi.fn(async () => ({
  status: "confirmation_required" as const,
  pendingChangeCount: 1,
}));
let workDraftGroups: ThreadDraftGroup[] | null;

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((result, part, index) => result + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));
vi.mock("@/client/query/useWorkDrafts", () => ({
  useWorkDrafts: () => ({
    groups: workDraftGroups,
  }),
}));
vi.mock("@/client/query/useWorks", () => ({
  useUpdateWorkWriteMode: () => ({ isPending: false, mutate, mutateAsync }),
}));
vi.mock("./useAiDraftLauncher", () => ({
  useAiDraftLauncher: () => ({ openAiDraft }),
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  PopoverHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const { ComposerWriteModeControl } = await import("./ComposerWriteModeControl");

describe("ComposerWriteModeControl", () => {
  beforeEach(() => {
    workDraftGroups = [
      {
        documentId: "document-zulu",
        documentName: "Zulu",
        contextPath: "work://manuscript/zulu.md",
        drafts: [
          {
            draftId: "draft-zulu",
            documentId: "document-zulu",
            documentName: "Zulu",
            contextPath: "work://manuscript/zulu.md",
            status: "active",
            lastActorTurnId: null,
            updatedAt: "2026-07-25T13:00:00.000Z",
            wordsAdded: 1,
            wordsRemoved: 0,
          },
        ],
      },
      {
        documentId: "document-alpha",
        documentName: "Alpha",
        contextPath: "work://manuscript/alpha.md",
        drafts: [
          {
            draftId: "draft-alpha",
            documentId: "document-alpha",
            documentName: "Alpha",
            contextPath: "work://manuscript/alpha.md",
            status: "active",
            lastActorTurnId: null,
            updatedAt: "2026-07-25T12:00:00.000Z",
            wordsAdded: 1,
            wordsRemoved: 0,
          },
        ],
      },
    ];
    openAiDraft.mockClear();
    mutate.mockClear();
    mutateAsync.mockClear();
  });

  it("signals pending drafts without disabling Auto-apply and opens the shared review flow", async () => {
    await withReactRoot(
      <ComposerWriteModeControl projectId="project-1" work={draftWork()} />,
      () => {
        expect(document.body.textContent).toContain("Draft(2)");
        const draft = radio("draft");
        const direct = radio("direct");
        expect(draft.getAttribute("aria-description")).toBe("2 changes waiting for review");
        expect(direct.disabled).toBe(false);

        button("Review changes").click();
        expect(openAiDraft).toHaveBeenCalledWith(
          expect.objectContaining({
            documentId: "document-alpha",
            contextPath: "work://manuscript/alpha.md",
          }),
          "draft-alpha",
        );
      },
    );
  });

  it("labels Review as checking while the reviewable projection is loading", async () => {
    workDraftGroups = null;

    await withReactRoot(
      <ComposerWriteModeControl projectId="project-1" work={draftWork()} />,
      () => {
        const checking = button("Checking pending changes…");
        expect(checking.disabled).toBe(true);
        expect(radio("direct").disabled).toBe(false);
      },
    );
  });
});

function draftWork(): Work {
  return {
    id: "work-1",
    projectId: "project-1",
    createdByUserId: "user-1",
    name: "Novel",
    slug: "novel",
    goal: null,
    description: null,
    status: "active",
    archivedAt: null,
    aiWriteMode: "draft",
    createdAt: "2026-07-25T12:00:00.000Z",
    updatedAt: "2026-07-25T12:00:00.000Z",
    lastActivityAt: "2026-07-25T12:00:00.000Z",
    deletedAt: null,
  };
}

function radio(value: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`input[value="${value}"]`);
  if (!input) throw new Error(`missing radio: ${value}`);
  return input;
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`missing button: ${label}`);
  return found as HTMLButtonElement;
}
