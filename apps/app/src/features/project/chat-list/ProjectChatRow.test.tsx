// @vitest-environment jsdom
/** Behavioral contracts for the shared project chat row and overflow-owned commands. */
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ProjectChatRow, type ProjectChatRowProps } from "./ProjectChatRow";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, ""),
}));
const chat = (favorite = false): ProjectChatItem => ({
  id: "thread-1",
  title: "River",
  work: { id: "work-1", title: "First Work" },
  lastMessagePreview: "Keep climbing.",
  lastActivityAt: "2025-08-13T15:30:00.000Z",
  actionRequired: false,
  isFavorite: favorite,
});

const props = (overrides: Partial<ProjectChatRowProps> = {}): ProjectChatRowProps => ({
  item: chat(),
  now: Date.parse("2026-08-24T16:00:00.000Z"),
  onOpen: vi.fn(),
  onFavorite: vi.fn(),
  favorite: { pending: false },
  ...overrides,
});

async function openActions() {
  const trigger = document.querySelector('[aria-label="Actions for River"]') as HTMLButtonElement;
  await act(async () => {
    const PointerEventConstructor = window.PointerEvent ?? window.MouseEvent;
    trigger.dispatchEvent(
      new PointerEventConstructor("pointerdown", {
        bubbles: true,
        button: 0,
        pointerType: "mouse",
      } as PointerEventInit),
    );
    trigger.click();
  });
  return trigger;
}

const menuItem = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === name,
  ) as HTMLElement;

const withRow = (row: React.ReactNode, run: () => Promise<void> | void, locale = "en") => {
  const testI18n = setupI18n({ locale, messages: { [locale]: {} } });
  return withReactRoot(<I18nProvider i18n={testI18n}>{row}</I18nProvider>, run);
};

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
  }
  throw lastError;
}

describe("ProjectChatRow", () => {
  it("shows the Composer-style Work value while preserving its accessible label", async () => {
    await withRow(<ProjectChatRow {...props()} />, () => {
      const work = document.querySelector("[data-project-chat-row-work]");
      expect(work?.textContent).toBe("First Work");
      expect(work?.getAttribute("aria-label")).toBe("Work: First Work");
    });
  });

  it("describes action-required state to screen readers without exposing a visual status", async () => {
    await withRow(
      <ProjectChatRow {...props({ item: { ...chat(), actionRequired: true } })} />,
      () => {
        const row = document.querySelector("[data-project-chat-row]") as HTMLElement;
        const open = row.querySelector('[aria-label="Open River"]') as HTMLButtonElement;
        const descriptionId = open.getAttribute("aria-describedby");
        const description = document.getElementById(descriptionId ?? "");

        expect(descriptionId).toBeTruthy();
        expect(descriptionId).not.toContain("thread-1");
        expect(description?.textContent).toBe("The AI asked you a question");
        expect(row.querySelector('[role="status"]')).toBeNull();
        expect(row.querySelector('[aria-label="The AI asked you a question"]')).toBeNull();
      },
    );
  });

  it("uses distinct IDREF targets for repeated instances of one thread", async () => {
    await withRow(
      <>
        <ProjectChatRow {...props({ item: { ...chat(), actionRequired: true } })} />
        <ProjectChatRow {...props({ item: { ...chat(), actionRequired: true } })} />
      </>,
      () => {
        const ids = [...document.querySelectorAll<HTMLElement>("[aria-describedby]")]
          .map((node) => node.getAttribute("aria-describedby"))
          .filter((id): id is string => Boolean(id));
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.every((id) => document.getElementById(id))).toBe(true);
      },
    );
  });

  it("owns Favorite and Remove favorite in the overflow with pointer and keyboard modality", async () => {
    const pointerFavorite = vi.fn();
    await withRow(<ProjectChatRow {...props({ onFavorite: pointerFavorite })} />, async () => {
      await openActions();
      const add = menuItem("Add to favorites");
      await act(async () => {
        const PointerEventConstructor = window.PointerEvent ?? window.MouseEvent;
        add.dispatchEvent(
          new PointerEventConstructor("pointerdown", {
            bubbles: true,
            button: 0,
            pointerType: "mouse",
          } as PointerEventInit),
        );
        add.click();
      });
      expect(pointerFavorite).toHaveBeenCalledWith(
        expect.objectContaining({ id: "thread-1" }),
        true,
      );
    });

    const keyboardFavorite = vi.fn();
    await withRow(
      <ProjectChatRow {...props({ item: chat(true), onFavorite: keyboardFavorite })} />,
      async () => {
        await openActions();
        const remove = menuItem("Remove from favorites");
        await act(async () => {
          remove.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
          remove.click();
        });
        expect(keyboardFavorite).toHaveBeenCalledWith(
          expect.objectContaining({ id: "thread-1" }),
          false,
        );
      },
    );
  });

  it("keeps menu-open ownership and restores trigger focus on Escape", async () => {
    await withRow(<ProjectChatRow {...props()} />, async () => {
      const trigger = await openActions();
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      await act(async () => menuItem("Add to favorites").focus());
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      });
      await waitFor(() => {
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
        expect(document.activeElement).toBe(trigger);
      });
    });
  });

  it("formats compact and full activity dates with the active locale", async () => {
    await withRow(
      <ProjectChatRow {...props()} />,
      () => {
        const dates = [...document.querySelectorAll("time")];
        expect(dates[0]?.textContent).toContain("8月");
        expect(dates[0]?.title).toContain("2025年");
      },
      "zh",
    );
  });
});
