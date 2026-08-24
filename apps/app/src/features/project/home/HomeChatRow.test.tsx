// @vitest-environment jsdom
/** Behavioral contracts for Home's two-line row and overflow-owned commands. */
import { I18nProvider } from "@lingui/react";
import type { HomeChatItem } from "@meridian/contracts/protocol";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/lib/i18n";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { HomeChatRow, type HomeChatRowProps } from "./HomeChatRow";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, ""),
}));
vi.mock("@lingui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lingui/react")>();
  return { ...actual, useLingui: () => ({ i18n }) };
});

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

afterEach(() => {
  i18n.activate("en");
});

describe("HomeChatRow", () => {
  it("owns Favorite and Remove favorite in the overflow with pointer and keyboard modality", async () => {
    const pointerFavorite = vi.fn();
    await withReactRoot(
      <I18nProvider i18n={i18n}>
        <HomeChatRow {...props({ onFavorite: pointerFavorite })} />
      </I18nProvider>,
      async () => {
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
      },
    );

    const keyboardFavorite = vi.fn();
    await withReactRoot(
      <I18nProvider i18n={i18n}>
        <HomeChatRow {...props({ item: chat(true), onFavorite: keyboardFavorite })} />
      </I18nProvider>,
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
    await withReactRoot(
      <I18nProvider i18n={i18n}>
        <HomeChatRow {...props()} />
      </I18nProvider>,
      async () => {
        const trigger = await openActions();
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
        menuItem("Add to favorites").focus();
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
        await act(async () => {
          document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
        });
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
        expect(document.activeElement).toBe(trigger);
      },
    );
  });

  it("keeps failed read retry in the menu without a third row", async () => {
    const onUnread = vi.fn(async () => true);
    await withReactRoot(
      <I18nProvider i18n={i18n}>
        <HomeChatRow
          {...props({
            onUnread,
            getCommandState: vi.fn((_id, field) => ({
              pending: false as const,
              error: field === "isUnread" ? new Error("offline") : null,
            })),
          })}
        />
      </I18nProvider>,
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
    i18n.activate("zh");
    await withReactRoot(
      <I18nProvider i18n={i18n}>
        <HomeChatRow {...props()} />
      </I18nProvider>,
      () => {
        const dates = [...document.querySelectorAll("time")];
        expect(dates[0]?.textContent).toContain("8月");
        expect(dates[0]?.title).toContain("2025年");
      },
    );
  });
});
