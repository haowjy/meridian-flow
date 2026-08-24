// @vitest-environment jsdom
/** Behavioral contracts for Home's two-line row and overflow-owned commands. */
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { HomeChatItem } from "@meridian/contracts/protocol";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { HomeChatRow, type HomeChatRowProps } from "./HomeChatRow";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, ""),
}));
const chat = (favorite = false): HomeChatItem => ({
  id: "thread-1",
  title: "River",
  work: { id: "work-1", title: "First Work" },
  lastMessagePreview: "Keep climbing.",
  lastActivityAt: "2025-08-13T15:30:00.000Z",
  attention: "none",
  isFavorite: favorite,
});

const props = (overrides: Partial<HomeChatRowProps> = {}): HomeChatRowProps => ({
  item: chat(),
  now: Date.parse("2026-08-24T16:00:00.000Z"),
  onOpen: vi.fn(),
  onFavorite: vi.fn(),
  onUnread: vi.fn(async () => true),
  getCommandState: vi.fn(() => ({ pending: false, error: null }) as const),
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

describe("HomeChatRow", () => {
  it("owns Favorite and Remove favorite in the overflow with pointer and keyboard modality", async () => {
    const pointerFavorite = vi.fn();
    await withRow(<HomeChatRow {...props({ onFavorite: pointerFavorite })} />, async () => {
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
        false,
      );
    });

    const keyboardFavorite = vi.fn();
    await withRow(
      <HomeChatRow {...props({ item: chat(true), onFavorite: keyboardFavorite })} />,
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
          true,
        );
      },
    );
  });

  it("keeps menu-open ownership and restores trigger focus on Escape", async () => {
    await withRow(<HomeChatRow {...props()} />, async () => {
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

  it("keeps failed read retry in the menu without a third row", async () => {
    const onUnread = vi.fn(async () => true);
    await withRow(
      <HomeChatRow
        {...props({
          onUnread,
          getCommandState: vi.fn((_id, field) => ({
            pending: false as const,
            error: field === "isUnread" ? new Error("offline") : null,
          })),
        })}
      />,
      async () => {
        const row = document.querySelector("[data-home-row]") as HTMLElement;
        expect(row.querySelector('[role="alert"]')).toBeNull();
        expect(row.querySelectorAll("[data-home-row-line]")).toHaveLength(2);
        await openActions();
        await act(async () => menuItem("Retry mark unread").click());
        expect(onUnread).toHaveBeenCalledWith(expect.objectContaining({ id: "thread-1" }), true);
      },
    );
  });

  it("formats compact and full activity dates with the active locale", async () => {
    await withRow(
      <HomeChatRow {...props()} />,
      () => {
        const dates = [...document.querySelectorAll("time")];
        expect(dates[0]?.textContent).toContain("8月");
        expect(dates[0]?.title).toContain("2025年");
      },
      "zh",
    );
  });
});
