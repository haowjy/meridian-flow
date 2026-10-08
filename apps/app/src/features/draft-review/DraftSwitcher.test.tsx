// @vitest-environment jsdom
/**
 * The Draft chip's menu is the versions of one document: the live version and
 * its draft. It names no other file, tag or count (moving between files is the
 * Changes list's). On a phone it also carries Apply draft, Discard draft and
 * the marks switch, and the trigger is a 44px target.
 */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";
import { DraftSwitcher, type DraftSwitcherProps } from "./DraftSwitcher";

const props = (overrides: Partial<DraftSwitcherProps> = {}): DraftSwitcherProps => ({
  draftOnly: false,
  disabled: false,
  onShowLive: vi.fn(),
  ...overrides,
});

function render(p: DraftSwitcherProps, run: () => Promise<void>) {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  return withReactRoot(
    <I18nProvider i18n={i18n}>
      <DraftSwitcher {...p} />
    </I18nProvider>,
    run,
  );
}

const item = (text: string) =>
  Array.from(document.querySelectorAll<HTMLElement>("[role=menuitem]")).find((node) =>
    node.textContent?.includes(text),
  );

async function open() {
  const trigger = document.querySelector<HTMLElement>("[data-slot=dropdown-menu-trigger]");
  await act(async () => {
    trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

describe("DraftSwitcher", () => {
  it("lists this document's versions, the draft checked, and nothing about other files", async () => {
    await render(props(), async () => {
      await open();
      const menu = document.querySelector("[role=menu]")?.textContent ?? "";
      expect(menu).toContain("Versions of this document");
      expect(item("Live version")).toBeDefined();
      expect(item("Draft")?.getAttribute("aria-current")).toBe("true");
      for (const gone of ["Drafts in this Work", "Apply all", "Discard all", "New document"]) {
        expect(menu).not.toContain(gone);
      }
      expect(menu).not.toMatch(/\d+ changes?/);
    });
  });

  it("shows the live version on pick", async () => {
    const onShowLive = vi.fn();
    await render(props({ onShowLive }), async () => {
      await open();
      await act(async () => item("Live version")?.click());
      expect(onShowLive).toHaveBeenCalledOnce();
    });
  });

  it("has no live version for a draft-only document: it closes the review instead", async () => {
    const onShowLive = vi.fn();
    await render(props({ draftOnly: true, onShowLive }), async () => {
      await open();
      expect(item("Live version")).toBeUndefined();
      await act(async () => item("Close review")?.click());
      expect(onShowLive).toHaveBeenCalledOnce();
    });
  });

  it("offers Rename only when it can be done, and on phone Apply draft, Discard draft and the marks switch", async () => {
    await render(props(), async () => {
      await open();
      expect(item("Rename")).toBeUndefined();
      expect(item("Apply draft")).toBeUndefined();
      expect(item("Hide changes")).toBeUndefined();
    });
    const draftCommands = { canApply: true, applying: false, onApply: vi.fn(), onDiscard: vi.fn() };
    const onChange = vi.fn();
    const onRename = vi.fn();
    await render(
      props({ touch: true, draftCommands, marks: { visible: true, onChange }, onRename }),
      async () => {
        expect(document.querySelector("[data-slot=dropdown-menu-trigger]")?.className).toContain(
          "min-h-11",
        );
        await open();
        await act(async () => item("Apply draft")?.click());
        expect(draftCommands.onApply).toHaveBeenCalledOnce();
        await open();
        await act(async () => item("Discard draft")?.click());
        expect(draftCommands.onDiscard).toHaveBeenCalledOnce();
        await open();
        await act(async () => item("Hide changes")?.click());
        expect(onChange).toHaveBeenCalledWith(false);
        await open();
        await act(async () => item("Rename")?.click());
        expect(onRename).toHaveBeenCalledOnce();
      },
    );
  });

  it("disables the whole-draft commands while one is in flight", async () => {
    const draftCommands = { canApply: true, applying: false, onApply: vi.fn(), onDiscard: vi.fn() };
    await render(props({ touch: true, disabled: true, draftCommands }), async () => {
      await open();
      expect(item("Apply draft")?.getAttribute("aria-disabled")).toBe("true");
      expect(item("Discard draft")?.getAttribute("aria-disabled")).toBe("true");
    });
  });
});
